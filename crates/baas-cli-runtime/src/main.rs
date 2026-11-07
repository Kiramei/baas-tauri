use baas_cli_runtime::{
    Progress, acquire_lease, check_update, inspect, install, launch_spec, update,
};
use baas_updater::{UpdateChannel, UpdaterError, UpdaterResult};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};

fn emit(value: Value) {
    let mut stdout = io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &value).is_ok() {
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
}

fn progress(progress: Progress) {
    if let Ok(mut value) = serde_json::to_value(progress) {
        value["type"] = json!("progress");
        emit(value);
    }
}

fn run(cancelled: &AtomicBool) -> UpdaterResult<Option<Value>> {
    let mut args = std::env::args().skip(1);
    let command = args.next().ok_or_else(|| {
        UpdaterError::Config(
            "expected inspect, install, check-update, update, lease, or launch-spec".into(),
        )
    })?;
    if ![
        "inspect",
        "install",
        "launch-spec",
        "check-update",
        "update",
        "lease",
    ]
    .contains(&command.as_str())
    {
        return Err(UpdaterError::Config(format!("unknown command: {command}")));
    }
    let mut root = None;
    let mut pipe = None;
    let mut channel = None;
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| UpdaterError::Config(format!("missing value for {flag}")))?;
        match flag.as_str() {
            "--root" if root.is_none() => root = Some(PathBuf::from(value)),
            "--pipe" if command == "launch-spec" && pipe.is_none() => pipe = Some(value),
            "--channel" if command == "install" && channel.is_none() => {
                channel = Some(UpdateChannel::parse(&value)?)
            }
            _ => {
                return Err(UpdaterError::Config(format!(
                    "unknown or duplicate option: {flag}"
                )));
            }
        }
    }
    let root = root.ok_or_else(|| UpdaterError::Config("--root is required".into()))?;
    if command == "lease" {
        let _lease = acquire_lease(&root)?;
        emit(
            json!({"type":"result","data":{"root":baas_cli_runtime::normalize_root(&root)?,"leased":true}}),
        );
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let input = io::stdin();
            let mut input = io::BufReader::new(input.take(128));
            let mut line = String::new();
            if input.read_line(&mut line).is_ok() {
                if let Ok(pid) = line.trim().parse::<u32>() {
                    if pid > 1 {
                        let _ = tx.send(Some(pid));
                    }
                }
            }
            let mut byte = [0];
            let _ = input.read(&mut byte);
            let _ = tx.send(None);
        });
        let mut backend_pid = None;
        let mut parent_closed = false;
        loop {
            if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(UpdaterError::Cancelled);
            }
            match rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(Some(pid)) => backend_pid = Some(pid),
                Ok(None) => parent_closed = true,
                _ => {}
            }
            if parent_closed {
                // A crashed CLI may leave its detached backend alive. Keep the
                // read lease until that backend exits, so another CLI cannot
                // reset its files in the middle of a running task.
                if !backend_pid.is_some_and(process_alive) {
                    return Ok(None);
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    }
    let value = match command.as_str() {
        "inspect" => serde_json::to_value(inspect(&root)?),
        "check-update" => serde_json::to_value(check_update(&root, cancelled, &mut progress)?),
        "update" => serde_json::to_value(update(&root, cancelled, &mut progress)?),
        "install" => serde_json::to_value(install(
            &root,
            channel.unwrap_or(UpdateChannel::Dev),
            cancelled,
            &mut progress,
        )?),
        "launch-spec" => serde_json::to_value(launch_spec(
            &root,
            &pipe.ok_or_else(|| UpdaterError::Config("--pipe is required".into()))?,
        )?),
        _ => unreachable!(),
    };
    value
        .map(Some)
        .map_err(|error| UpdaterError::Config(error.to_string()))
}

fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(true)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .output()
            .map(|output| {
                !output.status.success()
                    || String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
            })
            .unwrap_or(true)
    }
}

fn main() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&cancelled);
    if let Err(error) = ctrlc::set_handler(move || {
        signal.store(true, std::sync::atomic::Ordering::Relaxed);
    }) {
        emit(json!({"type":"error", "code":"signal", "message":error.to_string()}));
        std::process::exit(1);
    }
    match run(&cancelled) {
        Ok(Some(data)) => emit(json!({"type":"result", "data":data})),
        Ok(None) => {}
        Err(error) => {
            emit(json!({"type":"error", "code":error.code(), "message":error.message()}));
            std::process::exit(if error == UpdaterError::Cancelled {
                130
            } else {
                1
            });
        }
    }
}
