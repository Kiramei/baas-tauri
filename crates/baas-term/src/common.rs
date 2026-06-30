//! Common helpers shared by process, thread, and workflow orchestration.

use crate::types::{TaskCompletion, TermState};
use std::sync::{Arc, Mutex, mpsc::Receiver};

/// Returns whether `session_id` is still the active session.
///
/// Lock poisoning is treated as stale state and returns `false`.
pub fn session_is_current(inner: &Arc<Mutex<TermState>>, session_id: &str) -> bool {
    inner
        .lock()
        .map(|state| state.current_session_id.as_deref() == Some(session_id))
        .unwrap_or(false)
}

/// Waits until the expected task completion is received.
///
/// Completion messages for other tasks are ignored. If every sender is dropped
/// before the expected task arrives, the channel error is returned as a string.
pub fn wait_for_completion(
    completion_rx: &Receiver<TaskCompletion>,
    expected_task_id: &str,
) -> Result<TaskCompletion, String> {
    loop {
        let completion = completion_rx.recv().map_err(|error| error.to_string())?;
        if completion.task_id == expected_task_id {
            return Ok(completion);
        }
    }
}

/// Waits for all expected task ids and returns aggregate success.
///
/// Completion messages for unknown task ids are ignored. The return value is
/// `true` only when every expected task completes successfully.
pub fn wait_for_completions(
    completion_rx: &Receiver<TaskCompletion>,
    mut expected_task_ids: Vec<String>,
) -> Result<bool, String> {
    let mut success = true;
    while !expected_task_ids.is_empty() {
        let completion = completion_rx.recv().map_err(|error| error.to_string())?;
        if let Some(index) = expected_task_ids
            .iter()
            .position(|task_id| task_id == &completion.task_id)
        {
            expected_task_ids.remove(index);
            success &= completion.success;
        }
    }
    Ok(success)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread};

    fn completion(task_id: &str, success: bool) -> TaskCompletion {
        TaskCompletion {
            task_id: task_id.to_string(),
            success,
        }
    }

    #[test]
    fn session_is_current_matches_active_session() {
        let inner = Arc::new(Mutex::new(TermState {
            current_session_id: Some("session-a".to_string()),
            ..TermState::default()
        }));

        assert!(session_is_current(&inner, "session-a"));
        assert!(!session_is_current(&inner, "session-b"));
    }

    #[test]
    fn session_is_current_returns_false_for_poisoned_lock() {
        let inner = Arc::new(Mutex::new(TermState::default()));
        let thread_inner = Arc::clone(&inner);
        let _ = thread::spawn(move || {
            let _guard = thread_inner.lock().unwrap();
            panic!("poison lock");
        })
        .join();

        assert!(!session_is_current(&inner, "session-a"));
    }

    #[test]
    fn wait_for_completion_ignores_unrelated_tasks() {
        let (tx, rx) = mpsc::channel();
        tx.send(completion("other", false)).unwrap();
        tx.send(completion("expected", true)).unwrap();

        let result = wait_for_completion(&rx, "expected").unwrap();

        assert_eq!(result.task_id, "expected");
        assert!(result.success);
    }

    #[test]
    fn wait_for_completion_returns_channel_errors() {
        let (tx, rx) = mpsc::channel();
        drop(tx);

        assert!(wait_for_completion(&rx, "missing").is_err());
    }

    #[test]
    fn wait_for_completions_accepts_unordered_results_and_aggregates_success() {
        let (tx, rx) = mpsc::channel();
        tx.send(completion("unknown", false)).unwrap();
        tx.send(completion("task-b", false)).unwrap();
        tx.send(completion("task-a", true)).unwrap();

        let success =
            wait_for_completions(&rx, vec!["task-a".to_string(), "task-b".to_string()]).unwrap();

        assert!(!success);
    }

    #[test]
    fn wait_for_completions_returns_true_for_empty_expected_set() {
        let (_tx, rx) = mpsc::channel();

        assert!(wait_for_completions(&rx, Vec::new()).unwrap());
    }

    #[test]
    fn wait_for_completions_returns_channel_errors() {
        let (tx, rx) = mpsc::channel();
        drop(tx);

        assert!(wait_for_completions(&rx, vec!["missing".to_string()]).is_err());
    }
}
