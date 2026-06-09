use crate::demo::run_demo_flow;
use crate::renderer::renderer_loop;
use crate::types::{RendererEvent, SessionMetadata, SessionStartedPayload, TaskHandle, TermState};
use portable_pty::PtySize;
use std::{
    sync::{Arc, Mutex, atomic::Ordering, mpsc},
    thread,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

pub mod common;
mod demo;
pub mod processor;
pub mod renderer;
pub mod threader;
pub mod types;

#[derive(Clone, Default)]
pub struct TermManager {
    inner: Arc<Mutex<TermState>>,
}

impl TermManager {
    pub fn start(&self, app: AppHandle) -> Result<SessionMetadata, String> {
        self.stop_all()?;

        let session_id = Uuid::new_v4().to_string();
        let (renderer_tx, renderer_rx) = mpsc::channel();

        let (initial_rows, initial_cols) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "build manager lock poisoned")?;
            state.current_session_id = Some(session_id.clone());
            state.renderer_tx = Some(renderer_tx.clone());
            state.tasks.clear();
            if state.rows == 0 {
                state.rows = 32;
            }
            if state.cols == 0 {
                state.cols = 120;
            }
            (state.rows, state.cols)
        };

        app.emit(
            "build:session-started",
            SessionStartedPayload {
                session_id: session_id.clone(),
                status: "running".to_string(),
            },
        )
        .map_err(|error| error.to_string())?;

        let renderer_app = app.clone();
        let renderer_session_id = session_id.clone();
        thread::spawn(move || {
            renderer_loop(
                renderer_app,
                renderer_session_id,
                renderer_rx,
                initial_rows,
                initial_cols,
            )
        });

        let flow_inner = Arc::clone(&self.inner);
        let flow_session_id = session_id.clone();
        thread::spawn(move || run_demo_flow(flow_inner, flow_session_id, renderer_tx));

        Ok(SessionMetadata {
            session_id,
            status: "running".to_string(),
        })
    }

    fn stop_all(&self) -> Result<(), String> {
        let (tasks, tx) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "build manager lock poisoned")?;
            let tasks = state.tasks.drain().collect::<Vec<_>>();
            (tasks, state.renderer_tx.clone())
        };

        for (task_id, handle) in tasks {
            match &*handle {
                TaskHandle::Process { child, .. } => {
                    let _ = child
                        .lock()
                        .map_err(|_| "build child lock poisoned")?
                        .kill();
                }
                TaskHandle::Thread { cancel } => {
                    cancel.store(true, Ordering::Relaxed);
                }
            }
            if let Some(tx) = &tx {
                let _ = tx.send(RendererEvent::TaskFinished {
                    task_id,
                    region_id: String::new(),
                    status: "stopped".to_string(),
                    exit_code: None,
                    error: None,
                });
            }
        }

        Ok(())
    }

    fn clear(&self) -> Option<String> {
        let _ = self.stop_all();
        let mut state = self.inner.lock().ok()?;
        let session_id = state.current_session_id.take();
        if let Some(tx) = state.renderer_tx.take() {
            let _ = tx.send(RendererEvent::Shutdown);
        }
        state.tasks.clear();
        session_id
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let (tasks, tx) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "build manager lock poisoned")?;
            state.rows = rows;
            state.cols = cols;
            (
                state.tasks.values().cloned().collect::<Vec<_>>(),
                state.renderer_tx.clone(),
            )
        };

        for task in tasks {
            if let TaskHandle::Process { master, .. } = &*task {
                master
                    .lock()
                    .map_err(|_| "build pty master lock poisoned")?
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|error| error.to_string())?;
            }
        }

        if let Some(tx) = tx {
            let _ = tx.send(RendererEvent::Resize { rows, cols });
        }

        Ok(())
    }
}
