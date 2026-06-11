//! PTY-backed process task support.
//!
//! Process tasks run commands inside a pseudo terminal so interactive terminal
//! output, ANSI control sequences, and resize events behave like a real shell.

use crate::common::wait_for_completion;
use crate::constants::{
    DEMO_STEP_TOTAL, DEVICE_STATUS_REPORT_REQUEST, DEVICE_STATUS_REPORT_RESPONSE,
    DEVICE_STATUS_REPORT_TAIL_BYTES, PROCESS_FINISH_SETTLE_MS, PROCESS_READ_BUFFER_BYTES,
    PROCESS_WAIT_POLL_MS, PTY_PIXEL_HEIGHT, PTY_PIXEL_WIDTH, STATUS_FAILED, STATUS_SUCCESS,
};
use crate::types::{RendererEvent, TaskCompletion, TaskHandle, TaskSpec, TermState};
use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};
use std::sync::mpsc::Receiver;
use std::{
    sync::{Arc, Mutex, mpsc::Sender},
    thread,
    time::Duration,
};

/// Command configuration for a process task.
pub struct ScriptCommand {
    /// Program executable to spawn.
    pub program: String,
    /// Arguments passed to the executable.
    pub args: Vec<String>,
    /// Human-readable command displayed in task metadata.
    pub display: String,
}

/// Builds a [`TaskSpec`] for a PTY-backed process task.
///
/// The total step count is fixed to the current demo flow's four-step layout.
pub fn create_process_task(
    task_id: &str,
    region_id: &str,
    step_index: u8,
    name: &str,
    script: ScriptCommand,
) -> TaskSpec {
    TaskSpec {
        task_id: task_id.to_string(),
        region_id: region_id.to_string(),
        step_index,
        step_total: DEMO_STEP_TOTAL,
        name: name.to_string(),
        command: script.display,
        program: script.program,
        args: script.args,
    }
}

fn contains_device_status_report(tail: &mut Vec<u8>, bytes: &[u8]) -> bool {
    tail.extend_from_slice(bytes);
    let found = tail
        .windows(DEVICE_STATUS_REPORT_REQUEST.len())
        .any(|window| window == DEVICE_STATUS_REPORT_REQUEST);
    let keep_from = tail.len().saturating_sub(DEVICE_STATUS_REPORT_TAIL_BYTES);
    tail.drain(..keep_from);
    found
}

/// Spawns a process task and streams its output to the renderer.
///
/// The task is rejected when `session_id` is stale. On success, task metadata is
/// inserted into [`TermState`], a start event is emitted, and background threads
/// forward output and final completion status.
pub fn spawn_process_task(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    spec: TaskSpec,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
) -> Result<(), String> {
    let (rows, cols) = {
        let state = inner.lock().map_err(|_| "term manager lock poisoned")?;
        if state.current_session_id.as_deref() != Some(session_id) {
            return Err("stale term session".to_string());
        }
        (state.rows, state.cols)
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: PTY_PIXEL_WIDTH,
            pixel_height: PTY_PIXEL_HEIGHT,
        })
        .map_err(|error| error.to_string())?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;

    let mut command = CommandBuilder::new(&spec.program);
    command.args(spec.args.clone());
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    let child: Box<dyn Child + Send> = child;
    drop(pair.slave);

    let child = Arc::new(Mutex::new(child));
    let writer = Arc::new(Mutex::new(writer));
    let handle = Arc::new(TaskHandle::Process {
        child: Arc::clone(&child),
        master: Arc::new(Mutex::new(pair.master)),
    });

    {
        let mut state = inner.lock().map_err(|_| "term manager lock poisoned")?;
        state.tasks.insert(spec.task_id.clone(), handle);
    }

    renderer_tx
        .send(RendererEvent::TaskStarted(spec.clone()))
        .map_err(|error| error.to_string())?;

    let read_tx = renderer_tx.clone();
    let read_task_id = spec.task_id.clone();
    let read_region_id = spec.region_id.clone();
    let read_writer = Arc::clone(&writer);
    thread::spawn(move || {
        let mut buffer = [0_u8; PROCESS_READ_BUFFER_BYTES];
        let mut control_tail = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if contains_device_status_report(&mut control_tail, &buffer[..size])
                        && let Ok(mut writer) = read_writer.lock()
                    {
                        let _ = writer.write_all(DEVICE_STATUS_REPORT_RESPONSE);
                        let _ = writer.flush();
                    }
                    let _ = read_tx.send(RendererEvent::Output {
                        task_id: read_task_id.clone(),
                        region_id: read_region_id.clone(),
                        chunk: buffer[..size].to_vec(),
                    });
                }
                Err(_) => break,
            }
        }
    });

    let wait_tx = renderer_tx.clone();
    let wait_completion_tx = completion_tx.clone();
    let wait_inner = Arc::clone(inner);
    let wait_task_id = spec.task_id.clone();
    let wait_region_id = spec.region_id.clone();
    thread::spawn(move || {
        let (status, exit_code, success, error) = loop {
            let wait_result = {
                match child.lock() {
                    Ok(mut child) => child.try_wait(),
                    Err(_) => {
                        break (
                            STATUS_FAILED.to_string(),
                            None,
                            false,
                            Some("term child lock poisoned".to_string()),
                        );
                    }
                }
            };

            match wait_result {
                Ok(Some(exit_status)) => {
                    let code = exit_status.exit_code() as i32;
                    let success = code == 0;
                    break (
                        if success {
                            STATUS_SUCCESS
                        } else {
                            STATUS_FAILED
                        }
                        .to_string(),
                        Some(code),
                        success,
                        None,
                    );
                }
                Ok(None) => thread::sleep(Duration::from_millis(PROCESS_WAIT_POLL_MS)),
                Err(error) => {
                    break (
                        STATUS_FAILED.to_string(),
                        None,
                        false,
                        Some(error.to_string()),
                    );
                }
            }
        };

        thread::sleep(Duration::from_millis(PROCESS_FINISH_SETTLE_MS));

        if let Ok(mut state) = wait_inner.lock() {
            state.tasks.remove(&wait_task_id);
        }
        let _ = wait_tx.send(RendererEvent::TaskFinished {
            task_id: wait_task_id.clone(),
            region_id: wait_region_id,
            status,
            exit_code,
            error,
        });
        let _ = wait_completion_tx.send(TaskCompletion {
            task_id: wait_task_id,
            success,
        });
    });

    Ok(())
}

/// Spawns a process task and blocks until that specific task completes.
///
/// Returns `false` when spawning fails, the completion channel closes, or the
/// process exits unsuccessfully.
pub fn run_process_and_wait(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    spec: TaskSpec,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    completion_rx: &Receiver<TaskCompletion>,
) -> bool {
    let task_id = spec.task_id.clone();
    if spawn_process_task(inner, session_id, spec, renderer_tx, completion_tx).is_err() {
        return false;
    }
    wait_for_completion(completion_rx, &task_id)
        .map(|completion| completion.success)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    #[cfg(windows)]
    fn script(command: &str, display: &str) -> ScriptCommand {
        ScriptCommand {
            program: "powershell.exe".to_string(),
            args: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ],
            display: display.to_string(),
        }
    }

    #[cfg(not(windows))]
    fn script(command: &str, display: &str) -> ScriptCommand {
        ScriptCommand {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), command.to_string()],
            display: display.to_string(),
        }
    }

    #[cfg(windows)]
    fn success_script() -> ScriptCommand {
        script("Write-Output ok; exit 0", "success")
    }

    #[cfg(not(windows))]
    fn success_script() -> ScriptCommand {
        script("printf 'ok\\n'; exit 0", "success")
    }

    fn failure_script() -> ScriptCommand {
        script("exit 7", "failure")
    }

    fn active_state() -> Arc<Mutex<TermState>> {
        Arc::new(Mutex::new(TermState {
            current_session_id: Some("session".to_string()),
            rows: 24,
            cols: 80,
            ..TermState::default()
        }))
    }

    #[test]
    fn create_process_task_maps_script_metadata() {
        let spec = create_process_task(
            "task",
            "region",
            2,
            "Build",
            ScriptCommand {
                program: "program".to_string(),
                args: vec!["arg".to_string()],
                display: "program arg".to_string(),
            },
        );

        assert_eq!(spec.task_id, "task");
        assert_eq!(spec.region_id, "region");
        assert_eq!(spec.step_index, 2);
        assert_eq!(spec.step_total, 4);
        assert_eq!(spec.name, "Build");
        assert_eq!(spec.command, "program arg");
        assert_eq!(spec.program, "program");
        assert_eq!(spec.args, ["arg"]);
    }

    #[test]
    fn detects_device_status_report_within_and_across_chunks() {
        let mut tail = Vec::new();

        assert!(!contains_device_status_report(&mut tail, b"abc\x1b["));
        assert!(contains_device_status_report(&mut tail, b"6nxyz"));

        let mut tail = Vec::new();
        assert!(contains_device_status_report(&mut tail, b"\x1b[6n"));

        let mut tail = Vec::new();
        assert!(!contains_device_status_report(&mut tail, b"\x1b[5n"));
    }

    #[test]
    fn spawn_process_task_rejects_stale_sessions() {
        let inner = Arc::new(Mutex::new(TermState::default()));
        let (renderer_tx, renderer_rx) = mpsc::channel();
        let (completion_tx, _completion_rx) = mpsc::channel();
        let spec = create_process_task("task", "region", 1, "Noop", failure_script());

        let error =
            spawn_process_task(&inner, "session", spec, &renderer_tx, &completion_tx).unwrap_err();

        assert_eq!(error, "stale term session");
        assert!(renderer_rx.try_recv().is_err());
        assert!(inner.lock().unwrap().tasks.is_empty());
    }

    #[test]
    fn run_process_and_wait_returns_true_for_successful_process() {
        let inner = active_state();
        let (renderer_tx, renderer_rx) = mpsc::channel();
        let (completion_tx, completion_rx) = mpsc::channel();
        let spec = create_process_task("success", "success-region", 1, "Success", success_script());

        assert!(run_process_and_wait(
            &inner,
            "session",
            spec,
            &renderer_tx,
            &completion_tx,
            &completion_rx
        ));

        assert!(matches!(
            renderer_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            RendererEvent::TaskStarted(_)
        ));
        assert!(inner.lock().unwrap().tasks.is_empty());
    }

    #[test]
    fn run_process_and_wait_returns_false_for_failed_process() {
        let inner = active_state();
        let (renderer_tx, _renderer_rx) = mpsc::channel();
        let (completion_tx, completion_rx) = mpsc::channel();
        let spec = create_process_task("failure", "failure-region", 1, "Failure", failure_script());

        assert!(!run_process_and_wait(
            &inner,
            "session",
            spec,
            &renderer_tx,
            &completion_tx,
            &completion_rx
        ));
        assert!(inner.lock().unwrap().tasks.is_empty());
    }
}
