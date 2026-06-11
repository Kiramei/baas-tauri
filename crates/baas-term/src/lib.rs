//! Terminal session orchestration for BAAS update/demo output.
//!
//! The crate owns the lifecycle for a terminal-style terminal session: it starts a
//! renderer, launches process or thread tasks, forwards task output as Tauri
//! events, and tracks terminal dimensions for PTY-backed tasks.

use crate::demo::run_demo_flow;
use crate::renderer::renderer_loop;
use crate::types::{RendererEvent, SessionMetadata, SessionStartedPayload, TaskHandle, TermState};
use constants::{
    DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS, EVENT_BUILD_SESSION_STARTED, PTY_PIXEL_HEIGHT,
    PTY_PIXEL_WIDTH, STATUS_RUNNING, STATUS_STOPPED,
};
use portable_pty::PtySize;
use std::{
    sync::{Arc, Mutex, atomic::Ordering, mpsc},
    thread,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// Shared session and task-completion helpers.
pub mod common;
/// Shared constants controlling session, task, and renderer behavior.
pub mod constants;
mod demo;
/// PTY-backed process task support.
pub mod processor;
/// Terminal dashboard rendering support.
pub mod renderer;
/// In-process task and terminal-output helpers.
pub mod threader;
/// Shared task, renderer, and event payload types.
pub mod types;

/// Coordinates the active terminal build session.
///
/// `TermManager` is cheap to clone because clones share the same internal
/// session state. A manager starts the demo flow, resizes active PTYs, and
/// stops existing tasks before starting a new session.
#[derive(Clone, Default)]
pub struct TermManager {
    inner: Arc<Mutex<TermState>>,
}

impl TermManager {
    /// Starts a new terminal session and demo flow.
    ///
    /// Any existing session tasks are stopped before a fresh session id is
    /// created. The returned metadata is also emitted through the Tauri
    /// `"build:session-started"` event.
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
                state.rows = DEFAULT_TERMINAL_ROWS;
            }
            if state.cols == 0 {
                state.cols = DEFAULT_TERMINAL_COLS;
            }
            (state.rows, state.cols)
        };

        app.emit(
            EVENT_BUILD_SESSION_STARTED,
            SessionStartedPayload {
                session_id: session_id.clone(),
                status: STATUS_RUNNING.to_string(),
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
            status: STATUS_RUNNING.to_string(),
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
                    status: STATUS_STOPPED.to_string(),
                    exit_code: None,
                    error: None,
                });
            }
        }

        Ok(())
    }

    #[allow(dead_code)]
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

    /// Updates the terminal size for the active session.
    ///
    /// Existing PTY-backed tasks are resized, and the renderer receives a
    /// [`RendererEvent::Resize`] event so future snapshots use the new
    /// viewport size.
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
                        pixel_width: PTY_PIXEL_WIDTH,
                        pixel_height: PTY_PIXEL_HEIGHT,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn resize_updates_state_and_notifies_renderer() {
        let manager = TermManager::default();
        let (tx, rx) = mpsc::channel();
        {
            let mut state = manager.inner.lock().unwrap();
            state.renderer_tx = Some(tx);
        }

        manager.resize(48, 160).unwrap();

        let state = manager.inner.lock().unwrap();
        assert_eq!(state.rows, 48);
        assert_eq!(state.cols, 160);
        drop(state);

        match rx.recv().unwrap() {
            RendererEvent::Resize { rows, cols } => {
                assert_eq!(rows, 48);
                assert_eq!(cols, 160);
            }
            _ => panic!("expected resize event"),
        }
    }

    #[test]
    fn clear_stops_thread_tasks_sends_shutdown_and_returns_session_id() {
        let manager = TermManager::default();
        let (tx, rx) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut state = manager.inner.lock().unwrap();
            state.current_session_id = Some("session-1".to_string());
            state.renderer_tx = Some(tx);
            state.tasks.insert(
                "task-1".to_string(),
                Arc::new(TaskHandle::Thread {
                    cancel: Arc::clone(&cancel),
                }),
            );
        }

        assert_eq!(manager.clear(), Some("session-1".to_string()));
        assert!(cancel.load(Ordering::Relaxed));

        match rx.recv().unwrap() {
            RendererEvent::TaskFinished {
                task_id,
                status,
                exit_code,
                error,
                ..
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(status, "stopped");
                assert_eq!(exit_code, None);
                assert_eq!(error, None);
            }
            _ => panic!("expected task-finished event"),
        }
        assert!(matches!(rx.recv().unwrap(), RendererEvent::Shutdown));

        let state = manager.inner.lock().unwrap();
        assert_eq!(state.current_session_id, None);
        assert!(state.renderer_tx.is_none());
        assert!(state.tasks.is_empty());
    }
}
