use baas_cli_runtime::{inspect, install, launch_spec};
use baas_updater::{UpdateChannel, UpdaterError, UpdaterResult};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
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

fn run(cancelled: &AtomicBool) -> UpdaterResult<Value> {
    let mut args = std::env::args().skip(1);
    let command = args
        .next()
        .ok_or_else(|| UpdaterError::Config("expected inspect, install, or launch-spec".into()))?;
    if !["inspect", "install", "launch-spec"].contains(&command.as_str()) {
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
    let value = match command.as_str() {
        "inspect" => serde_json::to_value(inspect(&root)?),
        "install" => serde_json::to_value(install(
            &root,
            channel.unwrap_or(UpdateChannel::Dev),
            cancelled,
            &mut |progress| {
                emit(
                    json!({"type":"progress", "stage":progress.stage, "message":progress.message}),
                );
            },
        )?),
        "launch-spec" => serde_json::to_value(launch_spec(
            &root,
            &pipe.ok_or_else(|| UpdaterError::Config("--pipe is required".into()))?,
        )?),
        _ => unreachable!(),
    };
    value.map_err(|error| UpdaterError::Config(error.to_string()))
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
        Ok(data) => emit(json!({"type":"result", "data":data})),
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
