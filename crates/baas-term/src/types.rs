//! Shared data structures for terminal sessions, task state, and renderer
//! events.

use portable_pty::{Child, MasterPty};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, atomic::AtomicBool, mpsc::Sender},
};

/// Mutable state shared by the terminal manager and worker tasks.
///
/// This type is public for lower-level integrations, but callers should prefer
/// [`crate::TermManager`] unless they need to build custom task orchestration.
#[derive(Default)]
pub struct TermState {
    /// The id for the currently active session, if any.
    pub current_session_id: Option<String>,
    /// Handles for process and thread tasks currently owned by the session.
    pub tasks: HashMap<String, Arc<TaskHandle>>,
    /// Channel used to send renderer events for the active session.
    pub renderer_tx: Option<Sender<RendererEvent>>,
    /// Terminal rows used for new and resized PTYs.
    pub rows: u16,
    /// Terminal columns used for new and resized PTYs.
    pub cols: u16,
}

/// Completion notification sent by worker tasks.
#[derive(Clone)]
pub struct TaskCompletion {
    /// Stable task identifier.
    pub task_id: String,
    /// Whether the task completed successfully.
    pub success: bool,
}

/// Runtime handle for a spawned task.
pub enum TaskHandle {
    /// PTY-backed child process plus its master PTY.
    Process {
        /// Child process handle.
        child: Arc<Mutex<Box<dyn Child + Send>>>,
        /// Master PTY used for resize operations.
        master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    },
    /// In-process worker thread controlled by a cancellation token.
    Thread {
        /// Cancellation flag observed by cooperative thread tasks.
        cancel: Arc<AtomicBool>,
    },
}

/// Metadata used to start and render a task.
#[derive(Clone)]
pub struct TaskSpec {
    /// Stable task identifier.
    pub task_id: String,
    /// Renderer region that receives the task output.
    pub region_id: String,
    /// 1-based step number displayed in the task title.
    pub step_index: u8,
    /// Total number of steps displayed in the task title.
    pub step_total: u8,
    /// Human-readable task name.
    pub name: String,
    /// Display command shown to the UI.
    pub command: String,
    /// Program executable for process tasks.
    pub program: String,
    /// Program arguments for process tasks.
    pub args: Vec<String>,
}

/// Metadata returned when a terminal session starts.
///
/// Serialized fields use camelCase for Tauri event payload compatibility.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    /// Unique session id.
    pub session_id: String,
    /// Session status, typically `"running"`.
    pub status: String,
}

/// Payload emitted when a session starts.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartedPayload {
    /// Unique session id.
    pub session_id: String,
    /// Session status, typically `"running"`.
    pub status: String,
}

/// Payload containing a rendered terminal-dashboard chunk.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardLogPayload {
    /// Unique session id.
    pub session_id: String,
    /// Terminal text or control sequence chunk to append.
    pub chunk: String,
}

/// Payload emitted when a task starts.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStartedPayload {
    /// Unique session id.
    pub session_id: String,
    /// Stable task identifier.
    pub task_id: String,
    /// Renderer region for the task output.
    pub region_id: String,
    /// 1-based step number.
    pub step_index: u8,
    /// Total number of steps in the session flow.
    pub step_total: u8,
    /// Human-readable task name.
    pub name: String,
    /// Display command shown to the UI.
    pub command: String,
    /// Task status, typically `"running"`.
    pub status: String,
}

/// Payload emitted when a task status changes.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusPayload {
    /// Unique session id.
    pub session_id: String,
    /// Stable task identifier.
    pub task_id: String,
    /// Renderer region for the task output.
    pub region_id: String,
    /// Status such as `"running"`, `"success"`, `"failed"`, or `"stopped"`.
    pub status: String,
    /// Process exit code when available.
    pub exit_code: Option<i32>,
    /// Error message when the task failed before producing an exit code.
    pub error: Option<String>,
    /// RFC 3339 start timestamp when available.
    pub started_at: Option<String>,
    /// RFC 3339 finish timestamp when available.
    pub finished_at: Option<String>,
}

/// Payload emitted when a terminal session finishes.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFinishedPayload {
    /// Unique session id.
    pub session_id: String,
    /// Whether every required task completed successfully.
    pub success: bool,
}

/// Payload emitted when the terminal dashboard is cleared.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardClearedPayload {
    /// Cleared session id, or `None` when no session was active.
    pub session_id: Option<String>,
}

/// Events consumed by the renderer loop.
#[derive(Clone)]
pub enum RendererEvent {
    /// Hold output for the listed regions until they are flushed.
    BufferRegions {
        /// Region ids to mark as buffered.
        region_ids: Vec<String>,
    },
    /// A task started and should be added to the dashboard.
    TaskStarted(TaskSpec),
    /// Raw task output bytes.
    Output {
        /// Stable task identifier.
        task_id: String,
        /// Renderer region receiving the output.
        region_id: String,
        /// Raw output bytes.
        chunk: Vec<u8>,
    },
    /// A task finished and should emit final status.
    TaskFinished {
        /// Stable task identifier.
        task_id: String,
        /// Renderer region for the finished task.
        region_id: String,
        /// Final task status.
        status: String,
        /// Process exit code when available.
        exit_code: Option<i32>,
        /// Error message when available.
        error: Option<String>,
    },
    /// The full session finished.
    SessionFinished {
        /// Whether the session succeeded.
        success: bool,
    },
    /// Flush buffered regions back into the dashboard snapshot.
    FlushRegions {
        /// Region ids to flush.
        region_ids: Vec<String>,
    },
    /// Resize the renderer viewport.
    Resize {
        /// New row count.
        rows: u16,
        /// New column count.
        cols: u16,
    },
    /// Stop the renderer loop.
    Shutdown,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn term_state_defaults_to_no_session_or_size() {
        let state = TermState::default();

        assert_eq!(state.current_session_id, None);
        assert!(state.tasks.is_empty());
        assert!(state.renderer_tx.is_none());
        assert_eq!(state.rows, 0);
        assert_eq!(state.cols, 0);
    }

    #[test]
    fn task_completion_clones_task_result() {
        let completion = TaskCompletion {
            task_id: "task".to_string(),
            success: true,
        };
        let cloned = completion.clone();

        assert_eq!(cloned.task_id, "task");
        assert!(cloned.success);
    }

    #[test]
    fn payloads_serialize_with_camel_case_fields() {
        let payload = TaskStatusPayload {
            session_id: "session".to_string(),
            task_id: "task".to_string(),
            region_id: "region".to_string(),
            status: "failed".to_string(),
            exit_code: Some(2),
            error: Some("boom".to_string()),
            started_at: Some("2026-06-09T00:00:00Z".to_string()),
            finished_at: None,
        };

        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            json!({
                "sessionId": "session",
                "taskId": "task",
                "regionId": "region",
                "status": "failed",
                "exitCode": 2,
                "error": "boom",
                "startedAt": "2026-06-09T00:00:00Z",
                "finishedAt": null
            })
        );
    }

    #[test]
    fn renderer_event_clone_preserves_payload() {
        let event = RendererEvent::Resize { rows: 24, cols: 80 }.clone();

        match event {
            RendererEvent::Resize { rows, cols } => {
                assert_eq!(rows, 24);
                assert_eq!(cols, 80);
            }
            _ => panic!("expected resize event"),
        }
    }
}
