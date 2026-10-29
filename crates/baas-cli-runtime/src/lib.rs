//! The CLI adapter for the same installation workflow used by BAAS Desktop.
//!
//! No daemon is started here. The caller owns the backend process and receives
//! its launch specification only after a complete, CLI-owned installation.

use baas_term::types::{RendererEvent, TaskHandle, TermState};
use baas_updater::{
    UpdateChannel, UpdaterError, UpdaterResult, WorkflowOptions,
    config::{BackendTransport, ConfigManager, UpdaterConfig},
    environ::{launch_backend_pipe_command, requirements_lock_path, runtime_python, uv_executable},
    repo::cpp_branch_for,
    workflow::{new_workflow_cleanup_state, run_terminal_workflow_flow},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    net::TcpListener,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

pub const MARKER_FILE: &str = ".baas-cli-runtime.json";
const OWNER: &str = "baas-cli-runtime";
const SCHEMA_VERSION: u32 = 1;
pub const DEV_BACKEND_REQUIRED: &str =
    "CLI 本地环境需要 dev 服务后端；stable 当前不包含 BPIP 管道协议，请使用 --channel dev。";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallationMarker {
    owner: String,
    schema_version: u32,
    root: PathBuf,
    channel: UpdateChannel,
    complete: bool,
}

/// Installation state. `managed` means this directory belongs to BAAS CLI,
/// while `installed` additionally requires every installation stage to finish.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub installed: bool,
    pub managed: bool,
    pub root: PathBuf,
    /// Absolute path to main.service.py, the backend entry point.
    pub backend_path: PathBuf,
    /// Absolute path to the private .venv interpreter.
    pub python_path: PathBuf,
    /// Directory containing the OCR prebuild payload.
    pub cpp_path: PathBuf,
    pub channel: UpdateChannel,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Progress {
    pub stage: String,
    pub message: String,
}

/// Normalize without following symlinks, so the protocol preserves the root
/// selected by the caller. Installation separately rejects symlink anchors.
pub fn normalize_root(root: &Path) -> UpdaterResult<PathBuf> {
    if root.as_os_str().is_empty() {
        return Err(UpdaterError::Config("--root must not be empty".into()));
    }
    let absolute = std::path::absolute(root)?;
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    if normalized.parent().is_none() {
        return Err(UpdaterError::Config(
            "the filesystem root cannot be an installation directory".into(),
        ));
    }
    Ok(normalized)
}

fn cpp_dir(root: &Path) -> PathBuf {
    root.join("core/ocr/baas_ocr_client/bin")
}

fn cpp_program(root: &Path) -> PathBuf {
    cpp_dir(root).join(if cfg!(windows) {
        "BAAS_ocr_server.exe"
    } else {
        "BAAS_ocr_server"
    })
}

fn private_config(root: &Path, channel: UpdateChannel) -> UpdaterConfig {
    let mut config = UpdaterConfig::default();
    config.paths.baas_root_path = root.to_string_lossy().into_owned();
    config.general.channel = channel;
    config.general.transport = BackendTransport::Pipe;
    config.general.transport_version = 1;
    config.general.launch = false;
    config
}

fn read_marker(root: &Path) -> UpdaterResult<Option<InstallationMarker>> {
    let path = root.join(MARKER_FILE);
    if !path.try_exists()? {
        return Ok(None);
    }
    reject_symlink(&path)?;
    let marker: InstallationMarker = serde_json::from_slice(&fs::read(&path)?)
        .map_err(|error| UpdaterError::Config(format!("invalid CLI runtime marker: {error}")))?;
    if marker.owner != OWNER || marker.schema_version != SCHEMA_VERSION || marker.root != root {
        return Err(UpdaterError::Config(
            "the directory is not owned by this CLI runtime".into(),
        ));
    }
    Ok(Some(marker))
}

fn write_marker(root: &Path, channel: UpdateChannel, complete: bool) -> UpdaterResult<()> {
    let marker = InstallationMarker {
        owner: OWNER.into(),
        schema_version: SCHEMA_VERSION,
        root: root.to_owned(),
        channel,
        complete,
    };
    let path = root.join(MARKER_FILE);
    reject_symlink(&path)?;
    let temporary = root.join(format!(".baas-cli-runtime-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    serde_json::to_writer_pretty(&mut file, &marker)
        .map_err(|error| UpdaterError::Config(error.to_string()))?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    // Windows cannot rename a file over an existing target. The directory
    // lock prevents another installer from observing an intermediate update.
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path)?;
    }
    fs::rename(&temporary, &path)?;
    Ok(())
}

fn reject_symlink(path: &Path) -> UpdaterResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(UpdaterError::Config(format!(
            "CLI runtime path must not be a symbolic link: {}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn validate_anchors(root: &Path) -> UpdaterResult<()> {
    reject_symlink(root)?;
    for path in [
        MARKER_FILE,
        "setup.toml",
        ".baas-cli-install.lock",
        ".baas-updater",
        "tmp",
        "toolkit",
        ".venv",
        "core",
        "core/ocr",
        "core/ocr/baas_ocr_client",
        "core/ocr/baas_ocr_client/bin",
    ] {
        reject_symlink(&root.join(path))?;
    }
    Ok(())
}

/// Inspect without creating directories, modifying settings, or making any
/// network requests. A desktop install without a CLI marker remains unmanaged.
pub fn inspect(root: &Path) -> UpdaterResult<Inspection> {
    let root = normalize_root(root)?;
    validate_anchors(&root)?;
    let marker = read_marker(&root)?;
    let channel = marker
        .as_ref()
        .map(|value| value.channel)
        .unwrap_or_default();
    let config = private_config(&root, channel);
    let mut missing = Vec::new();
    if marker.is_none() {
        missing.push("managed-installation".into());
    } else if !marker.as_ref().is_some_and(|value| value.complete) {
        missing.push("installation-not-complete".into());
    }
    let backend_path = root.join("main.service.py");
    let python_path = runtime_python(&config);
    let cpp_path = cpp_dir(&root);
    for (label, path) in [
        ("backend", backend_path.clone()),
        ("python", python_path.clone()),
        ("uv", uv_executable(&config)),
        ("cpp", cpp_program(&root)),
        ("dependencies", requirements_lock_path(&config)),
        ("setup", root.join("setup.toml")),
    ] {
        if !path.is_file() {
            missing.push(label.into());
        }
    }
    if marker.is_some() && root.join("setup.toml").is_file() {
        let manager = ConfigManager::load_from(root.join("setup.toml"))?;
        if manager.config.baas_root() != root
            || manager.config.python.runtime_path != "default"
            || manager.config.paths.toolkit_path != "toolkit"
            || manager.config.paths.tmp_path != "tmp"
        {
            missing.push("private-runtime-config".into());
        }
    }
    Ok(Inspection {
        installed: missing.is_empty(),
        managed: marker.is_some(),
        root,
        backend_path,
        python_path,
        cpp_path,
        channel,
        missing,
    })
}

/// Install through the desktop updater workflow, including repositories,
/// managed Python, and dependency synchronization. Never launch a backend.
pub fn install(
    root: &Path,
    channel: UpdateChannel,
    cancelled: &AtomicBool,
    emit: &mut impl FnMut(Progress),
) -> UpdaterResult<Inspection> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(UpdaterError::Cancelled);
    }
    // The desktop stable source is the legacy Qt application and currently
    // has neither main.service.py nor the BPIP transport. Fail before any
    // filesystem or network operation rather than installing an unusable GUI.
    if channel == UpdateChannel::Stable {
        return Err(UpdaterError::Config(DEV_BACKEND_REQUIRED.into()));
    }
    install_with(root, channel, cancelled, emit, |root, emit| {
        run_workflow(root, cancelled, emit)
    })
}

fn install_with(
    root: &Path,
    channel: UpdateChannel,
    cancelled: &AtomicBool,
    emit: &mut impl FnMut(Progress),
    workflow: impl FnOnce(&Path, &mut dyn FnMut(Progress)) -> UpdaterResult<()>,
) -> UpdaterResult<Inspection> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(UpdaterError::Cancelled);
    }
    let root = normalize_root(root)?;
    // Reject unsupported Cpp platforms before creating any installation state.
    cpp_branch_for(std::env::consts::OS, std::env::consts::ARCH)?;
    validate_anchors(&root)?;
    if root.exists() && !root.is_dir() {
        return Err(UpdaterError::Config(
            "installation root must be a directory".into(),
        ));
    }
    if root.is_dir()
        && read_marker(&root)?.is_none()
        && fs::read_dir(&root)?.any(|entry| {
            entry
                .map(|entry| entry.file_name() != ".baas-cli-install.lock")
                .unwrap_or(true)
        })
    {
        return Err(UpdaterError::Config(format!(
            "refusing to overwrite an existing unmanaged directory: {}",
            root.display()
        )));
    }
    fs::create_dir_all(&root)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".baas-cli-install.lock"))?;
    lock.try_lock().map_err(|_| {
        UpdaterError::Workflow("another installer is using this CLI runtime".into())
    })?;
    let marker = read_marker(&root)?;
    if marker.is_none()
        && fs::read_dir(&root)?.any(|entry| {
            entry
                .map(|entry| entry.file_name() != ".baas-cli-install.lock")
                .unwrap_or(true)
        })
    {
        return Err(UpdaterError::Config(format!(
            "refusing to overwrite an existing unmanaged directory: {}",
            root.display()
        )));
    }
    write_marker(&root, channel, false)?;
    let mut manager = ConfigManager::load_from(root.join("setup.toml"))?;
    manager.config.paths.baas_root_path = root.to_string_lossy().into_owned();
    manager.config.paths.tmp_path = "tmp".into();
    manager.config.paths.toolkit_path = "toolkit".into();
    manager.config.python.runtime_path = "default".into();
    manager.config.general.channel = channel;
    manager.config.general.transport = BackendTransport::Pipe;
    manager.config.general.transport_version = 1;
    manager.config.general.launch = false;
    manager.config.general.no_update = false;
    manager.save()?;
    emit(Progress {
        stage: "prepare".into(),
        message: "Installing a private BAAS backend and Python environment".into(),
    });
    workflow(&root, emit)?;
    if cancelled.load(Ordering::Relaxed) {
        return Err(UpdaterError::Cancelled);
    }
    let state = inspect(&root)?;
    let incomplete: Vec<_> = state
        .missing
        .iter()
        .filter(|item| item.as_str() != "installation-not-complete")
        .cloned()
        .collect();
    if !incomplete.is_empty() {
        return Err(UpdaterError::Environment(format!(
            "installation finished without required components: {}",
            incomplete.join(", ")
        )));
    }
    write_marker(&root, channel, true)?;
    emit(Progress {
        stage: "complete".into(),
        message: "BAAS backend, Cpp, Python and dependencies are ready".into(),
    });
    inspect(&root)
}

fn cancel_tasks(inner: &Arc<Mutex<TermState>>) {
    if let Ok(mut state) = inner.lock() {
        state.current_session_id = None;
        for handle in state.tasks.values() {
            match handle.as_ref() {
                TaskHandle::Thread { cancel } => cancel.store(true, Ordering::Relaxed),
                TaskHandle::Process { child, .. } => {
                    if let Ok(mut child) = child.lock() {
                        let _ = child.kill();
                    }
                }
            }
        }
    }
}

fn run_workflow(
    root: &Path,
    cancelled: &AtomicBool,
    emit: &mut dyn FnMut(Progress),
) -> UpdaterResult<()> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    let inner = Arc::new(Mutex::new(TermState {
        current_session_id: Some(session_id.clone()),
        renderer_tx: Some(tx.clone()),
        rows: 30,
        cols: 120,
        ..TermState::default()
    }));
    let state = Arc::clone(&inner);
    let options = WorkflowOptions {
        config_path: Some(root.join("setup.toml")),
        install_path: Some(root.to_owned()),
        launch: false,
        pipe_name: None,
        shm_name: None,
    };
    let worker = thread::spawn(move || {
        run_terminal_workflow_flow(state, session_id, tx, options, new_workflow_cleanup_state())
    });
    let mut last_error = None;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            cancel_tasks(&inner);
            return Err(UpdaterError::Cancelled);
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(RendererEvent::TaskStarted(spec)) => emit(Progress {
                stage: spec.task_id,
                message: spec.name,
            }),
            Ok(RendererEvent::Output { task_id, chunk, .. }) => {
                let message = plain_output(&String::from_utf8_lossy(&chunk));
                if !message.is_empty() {
                    emit(Progress {
                        stage: task_id,
                        message,
                    });
                }
            }
            Ok(RendererEvent::TaskFinished {
                task_id,
                status,
                error,
                exit_code,
                ..
            }) => {
                if let Some(error) = &error {
                    last_error = Some(error.clone());
                }
                emit(Progress {
                    stage: task_id,
                    message: error.unwrap_or_else(|| match exit_code {
                        Some(code) => format!("{status} (exit {code})"),
                        None => status,
                    }),
                });
            }
            Ok(RendererEvent::SessionFinished { success }) => {
                worker
                    .join()
                    .map_err(|_| UpdaterError::Workflow("installer worker panicked".into()))?;
                return if success {
                    Ok(())
                } else {
                    Err(UpdaterError::Workflow(last_error.unwrap_or_else(|| {
                        "BAAS installation failed; see progress output".into()
                    })))
                };
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) if !worker.is_finished() => {}
            Err(_) => {
                cancel_tasks(&inner);
                return Err(UpdaterError::Workflow(last_error.unwrap_or_else(|| {
                    "installer ended before reporting completion".into()
                })));
            }
        }
    }
}

/// Strip terminal controls from the desktop workflow before emitting NDJSON.
fn plain_output(value: &str) -> String {
    let mut result = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.next() == Some('[') {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
        } else if ch == '\r' || ch == '\n' {
            result.push('\n');
        } else if !ch.is_control() || ch == '\t' {
            result.push(ch);
        }
    }
    result
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Produce a foreground backend command for the caller to own. There is no
/// process spawn, pid file write, or daemon launch in this operation.
pub fn launch_spec(root: &Path, pipe: &str) -> UpdaterResult<LaunchSpec> {
    if pipe.is_empty() || pipe.contains('\0') {
        return Err(UpdaterError::Config(
            "--pipe must be a non-empty endpoint".into(),
        ));
    }
    if cfg!(windows) {
        if !pipe.starts_with(r"\\.\pipe\") {
            return Err(UpdaterError::Config(
                "Windows pipe must use \\\\.\\pipe\\...".into(),
            ));
        }
    } else if !Path::new(pipe).is_absolute() {
        return Err(UpdaterError::Config(
            "Unix pipe must be an absolute socket path".into(),
        ));
    }
    let inspection = inspect(root)?;
    if !inspection.installed {
        return Err(UpdaterError::Environment(format!(
            "CLI runtime is not installed: {}",
            inspection.missing.join(", ")
        )));
    }
    let config = private_config(&inspection.root, inspection.channel);
    if !fs::read_to_string(&inspection.backend_path)?.contains("--pipe-name") {
        return Err(UpdaterError::Environment("this backend does not support CLI pipe transport; install a compatible backend channel".into()));
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let command = launch_backend_pipe_command(&config, port, pipe);
    let mut env: BTreeMap<_, _> = command.env.into_iter().collect();
    env.insert("PYTHONUNBUFFERED".into(), "1".into());
    Ok(LaunchSpec {
        program: command.program,
        args: command.args,
        cwd: inspection.root,
        env,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_install_is_rejected_before_creating_root_or_emitting_progress() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("must-not-be-created");
        let mut progress = Vec::new();
        let result = install(
            &root,
            UpdateChannel::Stable,
            &AtomicBool::new(false),
            &mut |item| progress.push(item),
        );
        assert_eq!(
            result,
            Err(UpdaterError::Config(DEV_BACKEND_REQUIRED.into()))
        );
        assert!(progress.is_empty());
        assert!(!root.exists());
        assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 0);
    }

    fn fixture(root: &Path) {
        let config = private_config(root, UpdateChannel::Dev);
        for path in [
            root.join("main.service.py"),
            runtime_python(&config),
            uv_executable(&config),
            cpp_program(root),
            requirements_lock_path(&config),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "# --pipe-name supported fixture\n").unwrap();
        }
    }

    #[test]
    fn inspect_missing_root_is_read_only_and_never_calls_it_installed() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("not-created");
        let state = inspect(&root).unwrap();
        assert!(!root.exists());
        assert!(!state.managed);
        assert!(!state.installed);
        assert!(state.root.is_absolute());
        assert!(
            state
                .missing
                .iter()
                .any(|item| item == "managed-installation")
        );
    }

    #[test]
    fn complete_workflow_is_required_even_when_payload_files_exist() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        let cancelled = AtomicBool::new(false);
        let result = install_with(
            &root,
            UpdateChannel::Dev,
            &cancelled,
            &mut |_| {},
            |root, _| {
                fixture(root);
                Err(UpdaterError::Environment("dependency sync failed".into()))
            },
        );
        assert!(result.is_err());
        let state = inspect(&root).unwrap();
        assert!(state.managed);
        assert!(!state.installed);
        assert_eq!(state.missing, vec!["installation-not-complete"]);
        let ready = install_with(
            &root,
            UpdateChannel::Dev,
            &cancelled,
            &mut |_| {},
            |_, _| Ok(()),
        )
        .unwrap();
        assert!(ready.installed);
        assert_eq!(ready.channel, UpdateChannel::Dev);
    }

    #[test]
    fn workflow_success_without_cpp_or_dependency_payload_is_not_installed() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        let result = install_with(
            &root,
            UpdateChannel::Stable,
            &AtomicBool::new(false),
            &mut |_| {},
            |_, _| Ok(()),
        );
        assert!(result.is_err());
        assert!(!inspect(&root).unwrap().installed);
    }

    #[test]
    fn unmanaged_nonempty_directory_is_not_overwritten() {
        let parent = tempfile::tempdir().unwrap();
        fs::write(parent.path().join("my-config"), "keep me").unwrap();
        let result = install_with(
            parent.path(),
            UpdateChannel::Stable,
            &AtomicBool::new(false),
            &mut |_| {},
            |_, _| panic!("must not run"),
        );
        assert!(result.unwrap_err().message().contains("unmanaged"));
        assert_eq!(
            fs::read_to_string(parent.path().join("my-config")).unwrap(),
            "keep me"
        );
        assert!(!parent.path().join(MARKER_FILE).exists());
        assert!(!parent.path().join("setup.toml").exists());
        assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
    }

    #[test]
    fn launch_spec_uses_shared_command_and_never_starts_a_process() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        let state = install_with(
            &root,
            UpdateChannel::Dev,
            &AtomicBool::new(false),
            &mut |_| {},
            |root, _| {
                fixture(root);
                Ok(())
            },
        )
        .unwrap();
        let pipe = if cfg!(windows) {
            r"\\.\pipe\baas-cli-test".to_string()
        } else {
            parent
                .path()
                .join("service.sock")
                .to_string_lossy()
                .into_owned()
        };
        let spec = launch_spec(&root, &pipe).unwrap();
        assert_eq!(spec.program, state.python_path);
        assert_eq!(spec.cwd, root);
        assert_eq!(spec.args[0], state.backend_path.to_string_lossy());
        assert!(
            spec.args
                .windows(2)
                .any(|args| args == ["--host", "127.0.0.1"])
        );
        assert!(
            spec.args
                .windows(2)
                .any(|args| args[0] == "--pipe-name" && args[1] == pipe)
        );
        assert_eq!(spec.env["PYTHONUNBUFFERED"], "1");
        assert!(!root.join(".pid").exists());
        assert!(launch_spec(&root, "relative.sock").is_err());
        fs::remove_file(cpp_program(&root)).unwrap();
        assert!(!inspect(&root).unwrap().installed);
        assert!(launch_spec(&root, &pipe).is_err());
    }

    #[test]
    fn concurrent_install_and_precancelled_operation_cannot_start_work() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        let result = install_with(
            &root,
            UpdateChannel::Stable,
            &AtomicBool::new(true),
            &mut |_| {},
            |_, _| panic!("must not run"),
        );
        assert_eq!(result, Err(UpdaterError::Cancelled));
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(root.join(".baas-cli-install.lock"))
            .unwrap();
        lock.lock().unwrap();
        let result = install_with(
            &root,
            UpdateChannel::Stable,
            &AtomicBool::new(false),
            &mut |_| {},
            |_, _| panic!("must not run"),
        );
        assert!(result.unwrap_err().message().contains("another installer"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_anchors_cannot_redirect_installation_writes() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        let external = parent.path().join("external");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir(&external).unwrap();
        write_marker(&root, UpdateChannel::Stable, false).unwrap();
        std::os::unix::fs::symlink(&external, root.join("toolkit")).unwrap();
        let result = install_with(
            &root,
            UpdateChannel::Stable,
            &AtomicBool::new(false),
            &mut |_| {},
            |_, _| panic!("must not run"),
        );
        assert!(result.unwrap_err().message().contains("symbolic link"));
        assert_eq!(fs::read_dir(external).unwrap().count(), 0);
    }

    #[test]
    fn terminal_control_sequences_do_not_escape_into_protocol_messages() {
        assert_eq!(
            plain_output("\u{1b}[32m环境就绪\u{1b}[0m\r\n\u{1b}[2Kdone"),
            "环境就绪\ndone"
        );
    }

    #[test]
    fn real_shared_workflow_events_are_consumed_without_launching_a_daemon() {
        let root = tempfile::tempdir().unwrap();
        let mut config = private_config(root.path(), UpdateChannel::Dev);
        // Offline fixture: shared workflow skips repository updates and all
        // managed environment work for an explicitly configured interpreter.
        config.general.no_update = true;
        config.general.launch = true;
        config.python.runtime_path = root
            .path()
            .join("fixture-python")
            .to_string_lossy()
            .into_owned();
        ConfigManager {
            config_path: root.path().join("setup.toml"),
            config,
        }
        .save()
        .unwrap();
        let mut progress = Vec::new();
        run_workflow(root.path(), &AtomicBool::new(false), &mut |item| {
            progress.push(item)
        })
        .unwrap();
        assert!(progress.iter().any(|item| item.stage == "updater-config"));
        assert!(
            progress
                .iter()
                .any(|item| item.stage == "launch-backend" && item.message.contains("disabled"))
        );
        assert!(!root.path().join(".pid").exists());
        assert!(progress.iter().all(|item| !item.message.contains('\u{1b}')));
    }

    #[test]
    fn real_shared_workflow_failure_is_never_reported_as_success() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let mut config = private_config(root.path(), UpdateChannel::Dev);
        config.general.no_update = true;
        ConfigManager {
            config_path: root.path().join("setup.toml"),
            config,
        }
        .save()
        .unwrap();
        let mut progress = Vec::new();
        // Existing Python/UV skip downloads, then missing requirements fail
        // before a PyPI request or a child process can be started.
        let result = run_workflow(root.path(), &AtomicBool::new(false), &mut |item| {
            progress.push(item)
        });
        assert!(result.is_err());
        assert!(
            progress
                .iter()
                .any(|item| item.message.contains("requirements file not found"))
        );
        assert!(!root.path().join(".pid").exists());
    }
}
