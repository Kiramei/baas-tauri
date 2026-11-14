//! Rust git2 worker for requests emitted by the embedded Python bootstrap.
//!
//! Python owns the public startup status and publishes the adapted checkout.
//! This worker only produces a checkout, per-request logs, progress, and a result.

use baas_updater::{
    android::{
        install_android_main_repository, stage_android_mirror_repository, AndroidMainInstallOptions,
    },
    OutputSink, OutputStyle, UpdateChannel,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const REQUEST_FILE: &str = "android-git-install-request.json";
const PROGRESS_FILE: &str = "android-git-install-progress.json";
const RESULT_FILE: &str = "android-git-install-result.json";
static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallRequest {
    version: u32,
    request_id: String,
    channel: String,
}

/// Start before the backend so installation also advances without frontend polling.
pub(crate) fn start(root: PathBuf, credential_dir: PathBuf) -> Result<(), String> {
    if WATCHER_STARTED.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let spawned = thread::Builder::new()
        .name("baas-git2-bootstrap".into())
        .spawn(move || watch_requests(&root, &credential_dir));
    if let Err(error) = spawned {
        WATCHER_STARTED.store(false, Ordering::Release);
        return Err(format!(
            "Cannot start the Rust git2 installation worker: {error}"
        ));
    }
    Ok(())
}

fn read_request(root: &Path) -> Option<InstallRequest> {
    serde_json::from_slice(&fs::read(root.join(REQUEST_FILE)).ok()?).ok()
}

fn valid_request_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn watch_requests(root: &Path, credential_dir: &Path) {
    let mut previous_id = String::new();
    loop {
        if let Some(request) = read_request(root) {
            if valid_request_id(&request.request_id) && request.request_id != previous_id {
                previous_id.clone_from(&request.request_id);
                // A completed request survives UI process recreation until Python consumes it.
                let completed = fs::read(root.join(RESULT_FILE))
                    .ok()
                    .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
                    .is_some_and(|value| value["requestId"] == request.request_id);
                if !completed {
                    execute_request(root, credential_dir, &request);
                }
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn execute_request(root: &Path, credential_dir: &Path, request: &InstallRequest) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        install_requested_checkout(root, credential_dir, request)
    }))
    .unwrap_or_else(|_| {
        Err("The Rust git2 installation worker panicked; retry installation.".into())
    });
    let payload = match result {
        Ok((sha, source)) => json!({
            "requestId": request.request_id,
            "ok": true,
            "sha": sha,
            "source": source,
        }),
        Err(error) => json!({
            "requestId": request.request_id,
            "ok": false,
            "error": error,
        }),
    };
    if let Err(error) = write_json_atomically(&root.join(RESULT_FILE), &payload) {
        crate::system_logs::system_log(
            "ERROR",
            "android_install",
            format!("Cannot report git2 installation result: {error}"),
        );
    }
}

fn install_requested_checkout(
    root: &Path,
    credential_dir: &Path,
    request: &InstallRequest,
) -> Result<(String, String), String> {
    if request.version != 1 {
        return Err(format!(
            "Unsupported Android git2 install protocol version: {}",
            request.version
        ));
    }
    let channel = UpdateChannel::parse(&request.channel).map_err(|error| error.message())?;
    let output = Arc::new(InstallOutput::new(root, &request.request_id)?);
    if baas_updater::mirrorc::supports_mirror_package(baas_updater::RepositoryKind::Main, channel) {
        let cdk = crate::mirrorc_credentials::load(credential_dir)?;
        if !cdk.is_empty() {
            let stage = tempfile::tempdir_in(root).map_err(|error| error.to_string())?;
            let sha = stage_android_mirror_repository(stage.path(), &cdk, output.as_ref())
                .map_err(|error| error.message())?;
            if read_request(root).is_none_or(|active| active.request_id != request.request_id) {
                return Err("Android backend installation cancelled".into());
            }
            fs::rename(stage.path(), root.join(".baas-next")).map_err(|error| error.to_string())?;
            return Ok((sha, "MirrorChyan".to_owned()));
        }
    }
    output.line(
        OutputStyle::Info,
        "[handoff] Rust git2 accepted the backend installation request.",
    );
    let cancelled = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let cancellation_worker = {
        let root = root.to_path_buf();
        let request_id = request.request_id.clone();
        let cancelled = Arc::clone(&cancelled);
        let done = Arc::clone(&done);
        thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                if read_request(&root).is_none_or(|request| request.request_id != request_id) {
                    cancelled.store(true, Ordering::Release);
                    break;
                }
                thread::sleep(Duration::from_millis(250));
            }
        })
    };
    let sink: Arc<dyn OutputSink> = output.clone();
    let mut options = AndroidMainInstallOptions::default();
    output.line(
        OutputStyle::Info,
        "[revision] Resolving the official GitHub master commit before ranking mirrors (8s timeout).",
    );
    match official_backend_revision(channel) {
        Ok(sha) => {
            output.line(
                OutputStyle::Info,
                &format!("[revision] Official GitHub master commit={sha}; only matching mirrors may install."),
            );
            options.expected_sha = Some(sha);
        }
        Err(error) => output.line(
            OutputStyle::Warning,
            &format!("[revision] Official API query failed: {error}; verifying the official GitHub Git reference instead."),
        ),
    }
    let outcome = install_android_main_repository(
        &root.join(".baas-next"),
        channel,
        cancelled,
        sink,
        options,
    );
    done.store(true, Ordering::Release);
    let _ = cancellation_worker.join();
    match outcome {
        Ok(report) => {
            output.line(
                OutputStyle::Success,
                "[verify] Checkout is ready; handing it to Python for Android adaptation.",
            );
            Ok((report.sha, report.source_url))
        }
        Err(error) => {
            let message = error.message();
            output.line(OutputStyle::Error, &format!("[error] {message}"));
            Err(message)
        }
    }
}

fn official_backend_revision(channel: UpdateChannel) -> Result<String, String> {
    let repository = baas_updater::history::repository(channel);
    let response = minreq::get(format!(
        "https://api.github.com/repos/{repository}/commits/master"
    ))
    .with_header("User-Agent", "baas-tauri-android")
    .with_header("Accept", "application/vnd.github+json")
    .with_timeout(8)
    .send()
    .map_err(|error| error.to_string())?;
    if response.status_code != 200 {
        return Err(format!("HTTP {}", response.status_code));
    }
    let value: serde_json::Value =
        serde_json::from_str(response.as_str().map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let sha = value["sha"].as_str().unwrap_or_default();
    if sha.len() != 40 || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Official GitHub response did not contain a valid commit SHA".into());
    }
    Ok(sha.to_ascii_lowercase())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    request_id: String,
    step: &'static str,
    phase: &'static str,
    detail: String,
    elapsed_seconds: f64,
    updated_at: f64,
}

struct InstallOutput {
    root: PathBuf,
    log_path: PathBuf,
    started: Instant,
    progress: Mutex<InstallProgress>,
}

impl InstallOutput {
    fn new(root: &Path, request_id: &str) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        let log_path = root.join(format!("android-git-install-{request_id}.log"));
        fs::write(&log_path, b"").map_err(|error| error.to_string())?;
        Ok(Self {
            root: root.to_path_buf(),
            log_path,
            started: Instant::now(),
            progress: Mutex::new(InstallProgress {
                request_id: request_id.into(),
                step: "download",
                phase: "handoff",
                detail: "Rust git2 is preparing mirror speed tests.".into(),
                elapsed_seconds: 0.0,
                updated_at: unix_seconds(),
            }),
        })
    }
}

impl OutputSink for InstallOutput {
    fn line(&self, _style: OutputStyle, message: &str) {
        let Ok(mut progress) = self.progress.lock() else {
            return;
        };
        let elapsed = self.started.elapsed().as_secs_f64();
        if let Ok(mut log) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
        {
            let _ = writeln!(log, "[+{elapsed:5.1}s] {message}");
        }
        if message.starts_with("[checkout]")
            || message.starts_with("[verify]")
            || message.contains("phase=checking out repository files")
        {
            progress.phase = if message.starts_with("[verify]") {
                "verify"
            } else {
                "checkout"
            };
            progress.step = "extract";
        } else if message.starts_with("[probe]") {
            progress.phase = "speed-test";
            progress.step = "download";
        } else if message.starts_with("[git2 transfer]") {
            progress.phase = "receive-objects";
            progress.step = "download";
        }
        progress.detail = message.into();
        progress.elapsed_seconds = elapsed;
        progress.updated_at = unix_seconds();
        let _ = write_json_atomically(&self.root.join(PROGRESS_FILE), &*progress);
    }
}

fn unix_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}
