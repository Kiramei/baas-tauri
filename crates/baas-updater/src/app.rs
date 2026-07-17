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

/// Application-owned guard retained for the complete updater flow lifetime.
/// Normal completion and confirmed start cancellation are explicit; dropping
/// the guard during panic unwinding must remain fail-closed.
pub trait WorkflowLifetimeGuard: Send {
    fn complete(self: Box<Self>);
    fn cancel(self: Box<Self>);
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
        let mut lifetime_guard = None;
        self.start_inner(app, options, &mut lifetime_guard)
    }

    /// Starts a workflow while retaining an application-owned lifetime guard
    /// until the background flow has actually returned.
    pub fn start_with_lifetime_guard(
        &self,
        app: AppHandle,
        options: WorkflowOptions,
        lifetime_guard: impl WorkflowLifetimeGuard + 'static,
    ) -> Result<SessionMetadata, String> {
        let mut lifetime_guard: Option<Box<dyn WorkflowLifetimeGuard>> =
            Some(Box::new(lifetime_guard));
        let result = self.start_inner(app, options, &mut lifetime_guard);
        finish_guarded_start(result, &mut lifetime_guard)
    }

    fn start_inner(
        &self,
        app: AppHandle,
        options: WorkflowOptions,
        lifetime_guard: &mut Option<Box<dyn WorkflowLifetimeGuard>>,
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

        finish_session_start_emit(
            &self.inner,
            &session_id,
            app.emit(
                "build:session-started",
                SessionStartedPayload {
                    session_id: session_id.clone(),
                    status: "running".to_string(),
                },
            )
            .map_err(|error| error.to_string()),
        )?;

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
        let flow_lifetime_guard = lifetime_guard.take();
        thread::spawn(move || {
            run_with_lifetime_guard(flow_lifetime_guard, || {
                run_terminal_workflow_flow(
                    flow_inner,
                    flow_session_id,
                    renderer_tx,
                    options,
                    flow_cleanup,
                )
            })
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

fn run_with_lifetime_guard(
    lifetime_guard: Option<Box<dyn WorkflowLifetimeGuard>>,
    workflow: impl FnOnce(),
) {
    workflow();
    if let Some(lifetime_guard) = lifetime_guard {
        lifetime_guard.complete();
    }
}

fn finish_guarded_start(
    result: Result<SessionMetadata, String>,
    lifetime_guard: &mut Option<Box<dyn WorkflowLifetimeGuard>>,
) -> Result<SessionMetadata, String> {
    if result.is_err()
        && let Some(lifetime_guard) = lifetime_guard.take()
    {
        lifetime_guard.cancel();
    }
    result
}

fn finish_session_start_emit(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    emit_result: Result<(), String>,
) -> Result<(), String> {
    let Err(error) = emit_result else {
        return Ok(());
    };
    let rollback_result = rollback_failed_session_start(inner, session_id);
    match rollback_result {
        Ok(()) => Err(error),
        Err(rollback_error) => Err(format!(
            "{error}; failed to roll back updater session start: {rollback_error}"
        )),
    }
}

fn rollback_failed_session_start(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
) -> Result<(), String> {
    let mut state = inner
        .lock()
        .map_err(|_| "updater manager lock poisoned".to_string())?;
    if state.current_session_id.as_deref() == Some(session_id) {
        state.current_session_id = None;
        state.renderer_tx = None;
        state.workflow_plan = None;
        state.tasks.clear();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct GuardSignals {
        completed: mpsc::Sender<()>,
        cancelled: mpsc::Sender<()>,
        dropped: mpsc::Sender<()>,
    }

    impl WorkflowLifetimeGuard for GuardSignals {
        fn complete(self: Box<Self>) {
            let _ = self.completed.send(());
        }

        fn cancel(self: Box<Self>) {
            let _ = self.cancelled.send(());
        }
    }

    impl Drop for GuardSignals {
        fn drop(&mut self) {
            let _ = self.dropped.send(());
        }
    }

    fn guard_signals() -> (
        GuardSignals,
        mpsc::Receiver<()>,
        mpsc::Receiver<()>,
        mpsc::Receiver<()>,
    ) {
        let (completed_tx, completed_rx) = mpsc::channel();
        let (cancelled_tx, cancelled_rx) = mpsc::channel();
        let (dropped_tx, dropped_rx) = mpsc::channel();
        (
            GuardSignals {
                completed: completed_tx,
                cancelled: cancelled_tx,
                dropped: dropped_tx,
            },
            completed_rx,
            cancelled_rx,
            dropped_rx,
        )
    }

    /// Handles the abort idle workflow is idempotent workflow.
    #[test]
    fn abort_idle_workflow_is_idempotent() {
        let manager = UpdaterTermManager::default();
        let report = manager.abort(WorkflowAbortRequest::default()).unwrap();
        assert_eq!(report.stopped_tasks, 0);
        assert!(report.cleaned_paths.is_empty());
    }

    #[test]
    fn lifetime_guard_is_held_until_background_workflow_returns() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (guard, completed_rx, cancelled_rx, dropped_rx) = guard_signals();
        let worker = thread::spawn(move || {
            run_with_lifetime_guard(Some(Box::new(guard)), || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
        });

        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(
            completed_rx
                .recv_timeout(Duration::from_millis(30))
                .is_err()
        );
        assert!(dropped_rx.recv_timeout(Duration::from_millis(30)).is_err());
        release_tx.send(()).unwrap();
        completed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        dropped_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(cancelled_rx.try_recv().is_err());
        worker.join().unwrap();
    }

    #[test]
    fn panic_drops_guard_without_marking_workflow_complete() {
        let (guard, completed_rx, cancelled_rx, dropped_rx) = guard_signals();
        let worker = thread::spawn(move || {
            run_with_lifetime_guard(Some(Box::new(guard)), || {
                panic!("injected updater flow panic");
            });
        });

        assert!(worker.join().is_err());
        assert!(completed_rx.try_recv().is_err());
        assert!(cancelled_rx.try_recv().is_err());
        dropped_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn returned_start_failure_explicitly_cancels_lifetime_guard() {
        let (guard, completed_rx, cancelled_rx, dropped_rx) = guard_signals();
        let mut guard: Option<Box<dyn WorkflowLifetimeGuard>> = Some(Box::new(guard));

        let error = finish_guarded_start(Err("injected start failure".to_string()), &mut guard)
            .err()
            .unwrap();

        assert_eq!(error, "injected start failure");
        assert!(guard.is_none());
        assert!(completed_rx.try_recv().is_err());
        cancelled_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        dropped_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn emit_failure_rolls_back_terminal_snapshot_state() {
        let manager = UpdaterTermManager::default();
        let session_id = "failed-session";
        let (renderer_tx, _renderer_rx) = mpsc::channel();
        {
            let mut state = manager.inner.lock().unwrap();
            state.current_session_id = Some(session_id.to_string());
            state.renderer_tx = Some(renderer_tx);
            state.workflow_plan = Some(terminal_workflow_plan());
        }

        let error = finish_session_start_emit(
            &manager.inner,
            session_id,
            Err("injected app.emit failure".to_string()),
        )
        .unwrap_err();

        assert_eq!(error, "injected app.emit failure");
        let snapshot = manager.snapshot().unwrap();
        assert!(snapshot.session_id.is_none());
        assert!(snapshot.workflow_plan.is_none());
        let state = manager.inner.lock().unwrap();
        assert!(state.renderer_tx.is_none());
        assert!(state.tasks.is_empty());
    }
}
