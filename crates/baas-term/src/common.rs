use crate::types::{TaskCompletion, TermState};
use std::sync::{Arc, Mutex, mpsc::Receiver};

pub fn session_is_current(inner: &Arc<Mutex<TermState>>, session_id: &str) -> bool {
    inner
        .lock()
        .map(|state| state.current_session_id.as_deref() == Some(session_id))
        .unwrap_or(false)
}

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
