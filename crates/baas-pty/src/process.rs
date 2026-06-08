use crate::types::{RendererEvent, State, TaskCompletion, TaskHandle, TaskSpec};
use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};
use std::{
    sync::{Arc, Mutex, mpsc::Sender},
    thread,
    time::Duration,
};

pub struct ScriptCommand {
    pub program: String,
    pub args: Vec<String>,
    pub display: String,
}

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
        step_total: 4,
        name: name.to_string(),
        command: script.display,
        program: script.program,
        args: script.args,
    }
}

pub fn spawn_process_task(
    inner: &Arc<Mutex<State>>,
    session_id: &str,
    spec: TaskSpec,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
) -> Result<(), String> {
    let (rows, cols) = {
        let state = inner.lock().map_err(|_| "build manager lock poisoned")?;
        if state.current_session_id.as_deref() != Some(session_id) {
            return Err("stale build session".to_string());
        }
        (state.rows, state.cols)
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut reader = pair
        .master
        .try_clone_reader()
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
    let handle = Arc::new(TaskHandle::Process {
        child: Arc::clone(&child),
        master: Arc::new(Mutex::new(pair.master)),
    });

    {
        let mut state = inner.lock().map_err(|_| "build manager lock poisoned")?;
        state.tasks.insert(spec.task_id.clone(), handle);
    }

    renderer_tx
        .send(RendererEvent::TaskStarted(spec.clone()))
        .map_err(|error| error.to_string())?;

    let read_tx = renderer_tx.clone();
    let read_task_id = spec.task_id.clone();
    let read_region_id = spec.region_id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
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
                            "failed".to_string(),
                            None,
                            false,
                            Some("build child lock poisoned".to_string()),
                        );
                    }
                }
            };

            match wait_result {
                Ok(Some(exit_status)) => {
                    let code = exit_status.exit_code() as i32;
                    let success = code == 0;
                    break (
                        if success { "success" } else { "failed" }.to_string(),
                        Some(code),
                        success,
                        None,
                    );
                }
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(error) => break ("failed".to_string(), None, false, Some(error.to_string())),
            }
        };

        thread::sleep(Duration::from_millis(80));

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
