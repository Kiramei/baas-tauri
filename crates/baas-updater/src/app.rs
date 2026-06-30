//! Tauri-facing updater session manager.

use crate::{
    WorkflowOptions,
    workflow::{
        WorkflowCleanupState, cleanup_workflow_state, new_workflow_cleanup_state,
        run_terminal_workflow_flow, terminal_workflow_plan,
    },
};
use baas_term::{
    renderer::renderer_loop,
    types::{
        RendererEvent, SessionMetadata, SessionStartedPayload, TaskHandle, TermState, WorkflowPlan,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::Ordering, mpsc},
    thread,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// Terminal-backed updater session manager.
///
/// This manager starts the real updater workflow through `baas-term` renderer,
/// process tasks, and thread tasks.
/// Request payload for aborting a terminal updater workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAbortRequest {
    /// Whether transient staging paths should be removed after stopping tasks.
    pub cleanup: bool,
    /// Whether terminal session-finished events should be emitted.
    #[serde(default = "default_abort_emit_events")]
    pub emit_events: bool,
}

impl Default for WorkflowAbortRequest {
    /// Handles the default workflow.
    fn default() -> Self {
        Self {
            cleanup: true,
            emit_events: true,
        }
    }
}

/// Handles the default abort emit events workflow.
fn default_abort_emit_events() -> bool {
    true
}

/// Result payload returned after aborting a terminal updater workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAbortReport {
    /// Number of currently registered tasks that were stopped.
    pub stopped_tasks: usize,
    /// Transient paths that were removed.
    pub cleaned_paths: Vec<PathBuf>,
}

/// Current terminal workflow snapshot for late frontend subscribers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    /// Active session id when one exists.
    pub session_id: Option<String>,
    /// Last planned workflow graph for the active session.
    pub workflow_plan: Option<WorkflowPlan>,
}

#[derive(Clone)]
pub struct UpdaterTermManager {
    inner: Arc<Mutex<TermState>>,
    cleanup_state: Arc<Mutex<WorkflowCleanupState>>,
}

impl Default for UpdaterTermManager {
    /// Handles the default workflow.
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(TermState::default())),
            cleanup_state: new_workflow_cleanup_state(),
        }
    }
}

impl UpdaterTermManager {
    /// Starts a terminal-rendered updater workflow.
    pub fn start(
        &self,
        app: AppHandle,
        options: WorkflowOptions,
    ) -> Result<SessionMetadata, String> {
        self.abort(WorkflowAbortRequest {
            cleanup: true,
            emit_events: false,
        })?;
        {
            let mut cleanup = self
                .cleanup_state
                .lock()
                .map_err(|_| "updater cleanup lock poisoned")?;
            *cleanup = WorkflowCleanupState::default();
        }

        let session_id = Uuid::new_v4().to_string();
        let (renderer_tx, renderer_rx) = mpsc::channel();
        let workflow_plan = terminal_workflow_plan();
        let (initial_rows, initial_cols) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "updater manager lock poisoned")?;
            state.current_session_id = Some(session_id.clone());
            state.renderer_tx = Some(renderer_tx.clone());
            state.workflow_plan = Some(workflow_plan);
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
        let flow_cleanup = Arc::clone(&self.cleanup_state);
        thread::spawn(move || {
            run_terminal_workflow_flow(
                flow_inner,
                flow_session_id,
                renderer_tx,
                options,
                flow_cleanup,
            )
        });

        Ok(SessionMetadata {
            session_id,
            status: "running".to_string(),
        })
    }

    /// Returns the active terminal workflow snapshot.
    pub fn snapshot(&self) -> Result<TerminalSnapshot, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "updater manager lock poisoned")?;
        Ok(TerminalSnapshot {
            session_id: state.current_session_id.clone(),
            workflow_plan: state.workflow_plan.clone(),
        })
    }

    /// Resizes active terminal process tasks and renderer state.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let (tasks, tx) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "updater manager lock poisoned")?;
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
                    .map_err(|_| "updater pty master lock poisoned")?
                    .resize(portable_pty::PtySize {
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

    /// Aborts the current terminal workflow.
    ///
    /// This method is safe to call after workflow failure. Cleanup is
    /// idempotent and only removes transient staging paths registered by the
    /// current or most recent workflow run.
    pub fn abort(&self, request: WorkflowAbortRequest) -> Result<WorkflowAbortReport, String> {
        let (stopped_tasks, tx) = self.stop_all()?;
        let cleaned_paths = if request.cleanup {
            cleanup_workflow_state(&self.cleanup_state).map_err(|error| error.message())?
        } else {
            Vec::new()
        };
        if request.emit_events
            && let Some(tx) = tx
        {
            let _ = tx.send(RendererEvent::SessionFinished { success: false });
        }
        Ok(WorkflowAbortReport {
            stopped_tasks,
            cleaned_paths,
        })
    }

    /// Performs the stop all operation.
    fn stop_all(&self) -> Result<(usize, Option<mpsc::Sender<RendererEvent>>), String> {
        let (tasks, tx) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "updater manager lock poisoned")?;
            let tasks = state.tasks.drain().collect::<Vec<_>>();
            let tx = state.renderer_tx.take();
            state.current_session_id = None;
            state.workflow_plan = None;
            (tasks, tx)
        };
        let stopped_tasks = tasks.len();

        for (task_id, handle) in tasks {
            match &*handle {
                TaskHandle::Process { child, .. } => {
                    let _ = child
                        .lock()
                        .map_err(|_| "updater child lock poisoned")?
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
        Ok((stopped_tasks, tx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Handles the abort idle workflow is idempotent workflow.
    #[test]
    fn abort_idle_workflow_is_idempotent() {
        let manager = UpdaterTermManager::default();
        let report = manager.abort(WorkflowAbortRequest::default()).unwrap();
        assert_eq!(report.stopped_tasks, 0);
        assert!(report.cleaned_paths.is_empty());
    }
}
