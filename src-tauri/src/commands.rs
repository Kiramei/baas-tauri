use crate::pipe_commands::BackendPipeManager;
use crate::system_logs::system_log;
use baas_shortcut::{
    apply_shortcut_bindings, ShortcutBindingRequest, ShortcutRegistrationReport, ShortcutRegistry,
};
use baas_term::types::SessionMetadata;
use baas_updater::{
    app::{TerminalSnapshot, UpdaterTermManager, WorkflowAbortReport, WorkflowAbortRequest},
    config::{
        exe_adjacent_config_path, BackendRuntime, BackendTransport, ConfigManager, UpdaterConfig,
    },
    environ::{
        backend_pid_path, cpp_service_executable_name, launch_backend_command,
        launch_backend_pipe_command, launch_cpp_backend_command,
    },
    mirrorc::{MirrorCClient, ReqwestMirrorHttp},
    repo::{repository_branch, repository_urls},
    GitBackend, RepositoryKind, UpdateChannel, WorkflowOptions,
};
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, Webview};
use tokio::{task::JoinSet, time};

const STORAGE_FILE_NAME: &str = ".app_storage.json";
const STORAGE_INSTALL_DIR_KEY: &str = "base_dir";
const SHA_TEST_TIMEOUT_SECONDS: f64 = 10.0;

/// Frontend storage location. Portable installs keep this next to the
/// executable, normal installs keep Tauri's default app-data store.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStartupState {
    pub store_path: PathBuf,
    pub storage_file_path: PathBuf,
    pub portable: bool,
}

/// Frontend startup snapshot for deciding whether to show the setup wizard or
/// immediately run the updater.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStartupState {
    pub config_path: PathBuf,
    pub config: UpdaterConfig,
    pub default_install_path: PathBuf,
    pub install_path: PathBuf,
    pub portable: bool,
    pub baas_root_exists_non_empty: bool,
}

/// Partial configuration update request used by the setup wizard.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterConfigUpdateRequest {
    pub baas_root_path: Option<PathBuf>,
    pub mirrorc_cdk: Option<String>,
    pub channel: Option<String>,
    pub runtime_path: Option<String>,
    pub no_update: Option<bool>,
    pub git_backend: Option<String>,
    pub backend_runtime: Option<String>,
    pub transport: Option<String>,
}

/// MirrorC CDK validation request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorCValidateRequest {
    pub cdk: String,
    pub channel: Option<String>,
}

/// MirrorC CDK validation result returned to the setup wizard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorCValidateReport {
    pub success: bool,
    pub code: Option<i32>,
    pub message: String,
    pub mirrorc_message: Option<String>,
    pub latest_version: Option<String>,
    pub expires_at: Option<u64>,
    pub expires_at_iso: Option<String>,
}

/// Terminal workflow start request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterWorkflowRequest {
    pub install_path: Option<PathBuf>,
    pub launch: Option<bool>,
}

/// Backend endpoint information emitted after a managed backend is ready.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendReadyPayload {
    pub base_backend_addr: String,
    pub base_backend_port: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterVersionCheckRequest {
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterVersionCheckReport {
    pub local: Option<String>,
    pub remote: Option<String>,
    pub update_available: bool,
    pub channel: String,
    pub method: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterShaTestRequest {
    pub channel: Option<String>,
    pub timeout: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterSingleShaTestRequest {
    pub channel: Option<String>,
    pub timeout: Option<f64>,
    pub method: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TauriClientUpdateRequest {
    pub current_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidScrcpyVirtualDisplayRequest {
    pub serial: Option<String>,
    pub package_name: Option<String>,
    pub activity_name: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub density: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidScrcpyVirtualDisplayReport {
    pub serial: String,
    pub display_id: u32,
    pub package_name: String,
    pub activity_name: String,
    pub display_id_file: PathBuf,
    pub log: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidScrcpyVirtualDisplayStatus {
    pub active: bool,
    pub serial: String,
    pub display_id: Option<u32>,
    pub display_id_file: PathBuf,
    pub setting: Option<String>,
    pub mode: String,
    pub log: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterShaTestReport {
    pub success: bool,
    pub name: String,
    pub order: i32,
    pub duration: f64,
    pub value: Option<String>,
    pub error: Option<String>,
}

/// Handles the shortcut apply bindings workflow.
#[tauri::command]
pub fn shortcut_apply_bindings(
    app: AppHandle,
    registry: State<'_, ShortcutRegistry>,
    bindings: Vec<ShortcutBindingRequest>,
) -> Result<ShortcutRegistrationReport, String> {
    system_log(
        "DEBUG",
        "shortcut",
        format!(
            "Shortcut bindings update requested count={}",
            bindings.len()
        ),
    );
    apply_shortcut_bindings(app, &registry, bindings)
}

/// Performs the open main devtools operation.
#[tauri::command]
pub fn open_main_devtools(webview: Webview) -> Result<(), String> {
    system_log(
        "WARNING",
        "devtools",
        format!("WebView DevTools requested label={}", webview.label()),
    );
    webview.open_devtools();
    Ok(())
}

#[tauri::command]
pub fn android_prepare_scrcpy_virtual_display(
    app: AppHandle,
    request: AndroidScrcpyVirtualDisplayRequest,
) -> Result<AndroidScrcpyVirtualDisplayReport, String> {
    system_log(
        "INFO",
        "android_display",
        format!(
            "Virtual display preparation requested serial={:?}",
            request.serial
        ),
    );
    let serial = normalized_adb_serial(request.serial.as_deref())?;
    let width = request.width.unwrap_or(1280);
    let height = request.height.unwrap_or(720);
    let density = request.density.unwrap_or(240);
    let activity_name = request
        .activity_name
        .unwrap_or_else(|| "com.yostar.sdk.bridge.YoStarUnityPlayerActivity".to_string());
    let mut log = Vec::new();

    adb_checked(
        &serial,
        &[
            "shell",
            "settings",
            "put",
            "global",
            "overlay_display_devices",
            &format!("{width}x{height}/{density}"),
        ],
        &mut log,
    )?;
    thread::sleep(Duration::from_secs(2));

    let display_dump = adb_output(
        &serial,
        &["shell", "dumpsys", "window", "displays"],
        &mut log,
    )?;
    let display_id = parse_overlay_display_id(&display_dump, width, height).ok_or_else(|| {
        format!("failed to find non-default Android display in dumpsys output:\n{display_dump}")
    })?;

    let package_name = match request.package_name {
        Some(package) if !package.trim().is_empty() => package,
        _ => resolve_blue_archive_package(&serial, &mut log)?,
    };

    adb_checked(
        &serial,
        &[
            "shell",
            "am",
            "start-activity",
            "--display",
            &display_id.to_string(),
            "-n",
            &format!("{package_name}/{activity_name}"),
        ],
        &mut log,
    )?;

    let manager = ensure_default_config(&app)?;
    let config_dir = manager.config.baas_root().join("config");
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let display_id_file = config_dir.join("scrcpy_display_id.txt");
    fs::write(&display_id_file, display_id.to_string()).map_err(|error| error.to_string())?;
    std::env::set_var("BAAS_SCRCPY_DISPLAY_ID", display_id.to_string());
    std::env::set_var(
        "BAAS_SCRCPY_DISPLAY_ID_FILE",
        display_id_file.to_string_lossy().to_string(),
    );

    Ok(AndroidScrcpyVirtualDisplayReport {
        serial,
        display_id,
        package_name,
        activity_name,
        display_id_file,
        log,
    })
}

#[tauri::command]
pub fn android_cleanup_scrcpy_virtual_display(
    app: AppHandle,
    serial: Option<String>,
) -> Result<(), String> {
    system_log(
        "INFO",
        "android_display",
        format!("Virtual display cleanup requested serial={serial:?}"),
    );
    let serial = normalized_adb_serial(serial.as_deref())?;
    let mut log = Vec::new();
    let _ = adb_output(
        &serial,
        &["shell", "pkill", "-f", "com.genymobile.scrcpy.Server"],
        &mut log,
    );
    let _ = adb_output(
        &serial,
        &[
            "shell",
            "settings",
            "delete",
            "global",
            "overlay_display_devices",
        ],
        &mut log,
    );
    if let Ok(manager) = ensure_default_config(&app) {
        let _ = fs::remove_file(
            manager
                .config
                .baas_root()
                .join("config")
                .join("scrcpy_display_id.txt"),
        );
    }
    std::env::remove_var("BAAS_SCRCPY_DISPLAY_ID");
    std::env::remove_var("BAAS_SCRCPY_DISPLAY_ID_FILE");
    Ok(())
}

#[tauri::command]
pub fn android_scrcpy_virtual_display_status(
    app: AppHandle,
    serial: Option<String>,
) -> Result<AndroidScrcpyVirtualDisplayStatus, String> {
    system_log(
        "DEBUG",
        "android_display",
        format!("Virtual display status requested serial={serial:?}"),
    );
    let serial = normalized_adb_serial(serial.as_deref())?;
    let mut log = Vec::new();
    let manager = ensure_default_config(&app)?;
    let display_id_file = manager
        .config
        .baas_root()
        .join("config")
        .join("scrcpy_display_id.txt");
    let marker_display_id = fs::read_to_string(&display_id_file)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok());
    let setting = adb_output(
        &serial,
        &[
            "shell",
            "settings",
            "get",
            "global",
            "overlay_display_devices",
        ],
        &mut log,
    )
    .map(|value| value.trim().to_string())?;
    let active =
        !setting.is_empty() && setting != "null" && !setting.eq_ignore_ascii_case("deleted");
    let display_dump = adb_output(
        &serial,
        &["shell", "dumpsys", "window", "displays"],
        &mut log,
    )
    .unwrap_or_default();
    let display_id = parse_overlay_display_id(&display_dump, 1280, 720).or(marker_display_id);
    if !active {
        let _ = fs::remove_file(&display_id_file);
    }
    Ok(AndroidScrcpyVirtualDisplayStatus {
        active,
        serial,
        display_id: if active { display_id } else { None },
        display_id_file,
        setting: if setting.is_empty() {
            None
        } else {
            Some(setting)
        },
        mode: "desktop-adb".to_string(),
        log,
    })
}

/// Simple path probe used by the setup page to recover from older configs
/// where the install root was lost but the frontend still has a cached path.
#[tauri::command]
pub fn updater_path_exists_non_empty(path: PathBuf) -> bool {
    system_log(
        "DEBUG",
        "storage",
        format!("Install path probe path={}", path.display()),
    );
    path_exists_non_empty(&path)
}

/// Performs the updater get storage state operation.
#[tauri::command]
pub fn updater_get_storage_state(app: AppHandle) -> Result<StorageStartupState, String> {
    system_log("DEBUG", "storage", "Frontend storage state requested");
    let portable = is_portable_install();
    let storage_file_path = storage_file_path(&app, portable)?;
    Ok(StorageStartupState {
        store_path: if portable {
            storage_file_path.clone()
        } else {
            PathBuf::from(STORAGE_FILE_NAME)
        },
        storage_file_path,
        portable,
    })
}

/// Tracks backend processes started by updater workflows so the Tauri process
/// owns their lifetime.
#[derive(Default)]
pub struct BackendProcessManager {
    pid_files: Arc<Mutex<Vec<PathBuf>>>,
}

impl BackendProcessManager {
    /// Handles the remember config workflow.
    pub fn remember_config(&self, config: &UpdaterConfig) -> Result<(), String> {
        self.remember_pid_file(backend_pid_path(config))
    }

    /// Performs the stop for config operation.
    pub fn stop_for_config(&self, config: &UpdaterConfig) -> Result<(), String> {
        let pid_file = backend_pid_path(config);
        system_log(
            "DEBUG",
            "backend_process",
            format!("Stopping backend for pid_file={}", pid_file.display()),
        );
        self.remember_pid_file(pid_file.clone())?;
        stop_backend_pid_file(&pid_file)
    }

    /// Performs the stop all operation.
    pub fn stop_all(&self) -> Result<(), String> {
        let pid_files = self
            .pid_files
            .lock()
            .map_err(|_| "backend pid-file lock poisoned")?
            .clone();
        for pid_file in pid_files {
            system_log(
                "DEBUG",
                "backend_process",
                format!("Stopping managed backend pid_file={}", pid_file.display()),
            );
            stop_backend_pid_file(&pid_file)?;
        }
        Ok(())
    }

    /// Handles the remember pid file workflow.
    fn remember_pid_file(&self, pid_file: PathBuf) -> Result<(), String> {
        let mut pid_files = self
            .pid_files
            .lock()
            .map_err(|_| "backend pid-file lock poisoned")?;
        if !pid_files.iter().any(|known| known == &pid_file) {
            pid_files.push(pid_file);
        }
        Ok(())
    }
}

impl Drop for BackendProcessManager {
    /// Handles the drop workflow.
    fn drop(&mut self) {
        let _ = self.stop_all();
    }
}

/// Performs the updater get startup state operation.
#[tauri::command]
pub fn updater_get_startup_state(app: AppHandle) -> Result<UpdaterStartupState, String> {
    system_log("DEBUG", "updater", "Updater startup state requested");
    let portable = is_portable_install();
    let default_install_path = default_install_path();
    let stored_install_path = if portable {
        None
    } else {
        read_stored_install_path(&app, portable)?.filter(|path| path_exists_non_empty(path))
    };
    let install_path = if portable {
        PathBuf::from(".")
    } else {
        stored_install_path
            .clone()
            .unwrap_or_else(|| default_install_path.clone())
    };
    let manager = config_manager_for_install_path(&install_path, portable)?;
    let baas_root_exists_non_empty = portable || stored_install_path.is_some();

    Ok(UpdaterStartupState {
        config_path: manager.config_path,
        config: manager.config,
        default_install_path,
        install_path,
        portable,
        baas_root_exists_non_empty,
    })
}

/// Performs the updater update config operation.
#[tauri::command]
pub fn updater_update_config(
    app: AppHandle,
    request: UpdaterConfigUpdateRequest,
) -> Result<UpdaterConfig, String> {
    system_log(
        "INFO",
        "updater",
        format!(
            "Updater config change requested channel={:?} no_update={:?} git_backend={:?} backend_runtime={:?} transport={:?} cdk_present={}",
            request.channel,
            request.no_update,
            request.git_backend,
            request.backend_runtime,
            request.transport,
            request
                .mirrorc_cdk
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
        ),
    );
    let portable = is_portable_install();
    let request_baas_root_path = if portable {
        Some(PathBuf::from("."))
    } else {
        request.baas_root_path.clone()
    };
    let mut manager = ensure_config_for_install_path(&app, request_baas_root_path.as_deref())?;
    let parsed_channel = match request.channel.as_deref() {
        Some(value) => Some(UpdateChannel::parse(value).map_err(|error| error.message())?),
        None => None,
    };
    let parsed_git_backend = match request.git_backend.as_deref() {
        Some(value) => Some(GitBackend::parse(value).map_err(|error| error.message())?),
        None => None,
    };
    let parsed_transport = match request.transport.as_deref() {
        Some("websocket") => Some(BackendTransport::Websocket),
        Some("pipe") => Some(BackendTransport::Pipe),
        Some(value) => return Err(format!("unsupported backend transport: {value}")),
        None => None,
    };
    let parsed_backend_runtime = parse_backend_runtime(request.backend_runtime.as_deref())?;
    manager
        .update(|config| {
            if let Some(path) = request_baas_root_path {
                config.paths.baas_root_path = persisted_baas_root_path(&path, portable);
            }
            if let Some(cdk) = request.mirrorc_cdk {
                config.general.mirrorc_cdk = cdk.trim().to_string();
            }
            if let Some(channel) = parsed_channel {
                config.general.channel = channel;
            }
            if let Some(runtime) = request.runtime_path {
                config.python.runtime_path = runtime;
            }
            if let Some(no_update) = request.no_update {
                config.general.no_update = no_update;
            }
            if let Some(git_backend) = parsed_git_backend {
                config.general.git_backend = git_backend;
            }
            if let Some(runtime) = parsed_backend_runtime {
                config.general.backend_runtime = runtime;
            }
            if let Some(transport) = parsed_transport {
                config.general.transport = transport;
            }
            if config.general.backend_runtime == BackendRuntime::Cpp {
                config.general.transport = BackendTransport::Websocket;
            }
        })
        .map_err(|error| error.message())?;
    Ok(manager.config)
}

/// Parses the persisted desktop backend implementation without aliases or fallback.
fn parse_backend_runtime(value: Option<&str>) -> Result<Option<BackendRuntime>, String> {
    match value {
        Some("python") => Ok(Some(BackendRuntime::Python)),
        Some("cpp") => Ok(Some(BackendRuntime::Cpp)),
        Some(value) => Err(format!("unsupported backend runtime: {value}")),
        None => Ok(None),
    }
}

/// Performs the updater validate mirrorc cdk operation.
#[tauri::command]
pub fn updater_validate_mirrorc_cdk(
    app: AppHandle,
    request: MirrorCValidateRequest,
) -> Result<MirrorCValidateReport, String> {
    system_log(
        "DEBUG",
        "updater",
        format!(
            "MirrorC validation requested cdk_present={}",
            !request.cdk.trim().is_empty()
        ),
    );
    let cdk = request.cdk.trim().to_string();
    let channel = match request.channel.as_deref() {
        Some(value) => UpdateChannel::parse(value).map_err(|error| error.message())?,
        None => ensure_default_config(&app)?.config.general.channel,
    };

    let report = if cdk.is_empty() {
        MirrorCValidateReport {
            success: false,
            code: Some(7002),
            message: "CDK invalid.".to_string(),
            mirrorc_message: None,
            latest_version: None,
            expires_at: None,
            expires_at_iso: None,
        }
    } else {
        let client = MirrorCClient::new(ReqwestMirrorHttp);
        match client.latest(RepositoryKind::Main, channel, "", &cdk) {
            Ok(latest) => {
                let success = latest.is_success();
                let expires_at_iso = format_mirrorc_expiry(latest.cdk_expired_time);
                let message = mirrorc_validation_message(
                    latest.code,
                    &latest.message,
                    expires_at_iso.as_deref(),
                );
                MirrorCValidateReport {
                    success,
                    code: Some(latest.code),
                    message,
                    mirrorc_message: Some(latest.message.clone()),
                    latest_version: latest.latest_version_name,
                    expires_at: latest.cdk_expired_time,
                    expires_at_iso,
                }
            }
            Err(error) => MirrorCValidateReport {
                success: false,
                code: None,
                message: error.message(),
                mirrorc_message: None,
                latest_version: None,
                expires_at: None,
                expires_at_iso: None,
            },
        }
    };

    Ok(report)
}

/// Handles the tauri client check update workflow.
#[tauri::command]
pub fn tauri_client_check_update(
    request: TauriClientUpdateRequest,
) -> Result<serde_json::Value, String> {
    system_log(
        "DEBUG",
        "client_update",
        "Tauri client update check requested",
    );
    let _ = request.current_version;
    Err("Desktop client updates are handled by tauri-plugin-updater.".to_string())
}

/// Performs the updater check version operation.
#[tauri::command]
pub fn updater_check_version(
    app: AppHandle,
    request: UpdaterVersionCheckRequest,
) -> Result<UpdaterVersionCheckReport, String> {
    system_log(
        "DEBUG",
        "updater",
        format!(
            "Backend version check requested channel={:?}",
            request.channel
        ),
    );
    let manager = ensure_default_config(&app)?;
    let channel =
        parse_requested_channel(request.channel.as_deref(), manager.config.general.channel)?;
    let local = desktop_local_main_sha(&manager.config);
    let preferred_method = normalized_sha_method(&manager.config.general.get_remote_sha_method);
    let (method, remote) = desktop_first_remote_sha(channel, &preferred_method)?;
    Ok(UpdaterVersionCheckReport {
        update_available: local.as_deref() != Some(remote.as_str()),
        local,
        remote: Some(remote),
        channel: channel.as_str().to_string(),
        method,
    })
}

/// Verifies the updater test sha methods behavior.
#[tauri::command]
pub async fn updater_test_sha_methods(
    app: AppHandle,
    request: UpdaterShaTestRequest,
) -> Result<Vec<UpdaterShaTestReport>, String> {
    system_log(
        "INFO",
        "updater",
        format!(
            "All SHA connectivity tests requested channel={:?}",
            request.channel
        ),
    );
    let manager = ensure_default_config(&app)?;
    let channel =
        parse_requested_channel(request.channel.as_deref(), manager.config.general.channel)?;
    let timeout = sha_test_timeout(request.timeout);
    let branch = repository_branch(RepositoryKind::Main).map_err(|error| error.message())?;
    let mut tasks = JoinSet::new();
    for (order, (name, url)) in sha_method_sources(channel).into_iter().enumerate() {
        let branch = branch.clone();
        tasks.spawn(run_sha_probe(name, order as i32, url, branch, timeout));
    }

    let mut reports = Vec::new();
    while let Some(result) = tasks.join_next().await {
        reports.push(result.map_err(|error| error.to_string())?);
    }
    Ok(reports)
}

/// Verifies the updater test sha method behavior.
#[tauri::command]
pub async fn updater_test_sha_method(
    app: AppHandle,
    request: UpdaterSingleShaTestRequest,
) -> Result<UpdaterShaTestReport, String> {
    system_log(
        "DEBUG",
        "updater",
        format!("SHA connectivity test requested method={}", request.method),
    );
    let manager = ensure_default_config(&app)?;
    let channel =
        parse_requested_channel(request.channel.as_deref(), manager.config.general.channel)?;
    let timeout = sha_test_timeout(request.timeout);
    let branch = repository_branch(RepositoryKind::Main).map_err(|error| error.message())?;
    let name = request.method.trim().to_string();
    let (order, url) = sha_method_sources(channel)
        .into_iter()
        .enumerate()
        .find(|(_, (method, _))| method == &name)
        .map(|(index, (_, url))| (index as i32, url))
        .unwrap_or((-1, None));
    Ok(run_sha_probe(name, order, url, branch, timeout).await)
}

/// Performs the updater start workflow operation.
#[tauri::command]
pub fn updater_start_workflow(
    app: AppHandle,
    request: UpdaterWorkflowRequest,
    manager: State<'_, UpdaterTermManager>,
    backend: State<'_, BackendProcessManager>,
) -> Result<SessionMetadata, String> {
    system_log(
        "INFO",
        "updater",
        format!(
            "Updater workflow requested install_path={:?} launch={:?}",
            request.install_path, request.launch
        ),
    );
    let portable = is_portable_install();
    let initial_config_manager = ensure_default_config(&app)?;
    let install_path = request
        .install_path
        .or_else(|| non_empty_path(&initial_config_manager.config.paths.baas_root_path))
        .unwrap_or_else(default_install_path);
    let install_path = if portable {
        PathBuf::from(".")
    } else {
        install_path
    };
    let mut config_manager = ensure_config_for_install_path(&app, Some(&install_path))?;
    backend.stop_for_config(&config_manager.config)?;
    let mut next_config = config_manager.config.clone();
    next_config.paths.baas_root_path = persisted_baas_root_path(&install_path, portable);
    backend.stop_for_config(&next_config)?;
    backend.remember_config(&next_config)?;

    // The updater launch stage checks both WorkflowOptions.launch and
    // general.launch. Persisting this makes setup.toml reflect the app mode.
    config_manager
        .update(|config| {
            config.paths.baas_root_path = persisted_baas_root_path(&install_path, portable);
            config.general.launch = request.launch.unwrap_or(true);
        })
        .map_err(|error| error.message())?;

    manager.start(
        app,
        WorkflowOptions {
            config_path: Some(config_manager.config_path),
            install_path: Some(install_path),
            launch: request.launch.unwrap_or(true),
        },
    )
}

/// Performs the updater reset backend auth and restart operation.
#[tauri::command]
pub fn updater_reset_backend_auth_and_restart(
    app: AppHandle,
    backend: State<'_, BackendProcessManager>,
) -> Result<BackendReadyPayload, String> {
    system_log(
        "WARNING",
        "backend_auth",
        "Backend authentication reset requested",
    );
    let manager = ensure_default_config(&app)?;
    backend.stop_for_config(&manager.config)?;
    thread::sleep(Duration::from_millis(300));
    delete_backend_auth_files(&manager.config)?;

    let port = available_backend_port()?;
    match manager.config.general.backend_runtime {
        BackendRuntime::Python => start_backend_detached(&manager.config, port)?,
        BackendRuntime::Cpp => start_cpp_backend_detached(&app, &manager.config, port)?,
    }
    track_and_wait_backend(
        &backend,
        &manager.config,
        port,
        manager.config.general.backend_runtime,
    )?;
    system_log(
        "INFO",
        "backend_process",
        format!("Backend restarted and ready port={port}"),
    );

    Ok(BackendReadyPayload {
        base_backend_addr: "127.0.0.1".to_string(),
        base_backend_port: port,
    })
}

/// Restarts the managed backend for the selected frontend transport.
#[tauri::command]
pub fn backend_transport_start(
    app: AppHandle,
    backend: State<'_, BackendProcessManager>,
    pipe: State<'_, BackendPipeManager>,
    mode: String,
) -> Result<BackendReadyPayload, String> {
    let transport = match mode.as_str() {
        "websocket" => BackendTransport::Websocket,
        "pipe" => BackendTransport::Pipe,
        _ => return Err(format!("unsupported backend transport: {mode}")),
    };
    let mut manager = ensure_default_config(&app)?;
    let previous_runtime = manager.config.general.backend_runtime;
    let previous_transport = manager.config.general.transport;
    manager
        .update(|config| {
            config.general.backend_runtime = BackendRuntime::Python;
            config.general.transport = transport;
        })
        .map_err(|error| error.message())?;
    let mut started = false;
    let result = (|| {
        backend.stop_for_config(&manager.config)?;
        pipe.close_all()?;
        thread::sleep(Duration::from_millis(300));

        let port = available_backend_port()?;
        match mode.as_str() {
            "websocket" => {
                start_backend_detached(&manager.config, port)?;
                started = true;
            }
            "pipe" => {
                let pipe_name = backend_pipe_endpoint();
                start_backend_pipe_detached(&manager.config, port, &pipe_name)?;
                started = true;
                pipe.configure(pipe_name)?;
            }
            _ => unreachable!("transport mode was validated before backend restart"),
        }
        track_and_wait_backend(&backend, &manager.config, port, BackendRuntime::Python)?;
        system_log(
            "INFO",
            "backend_process",
            format!("Backend transport ready mode={mode} port={port}"),
        );
        Ok(BackendReadyPayload {
            base_backend_addr: "127.0.0.1".to_string(),
            base_backend_port: port,
        })
    })();
    match result {
        Ok(payload) => Ok(payload),
        Err(error) => {
            let _ = pipe.close_all();
            let error = cleanup_started_backend(&manager.config, started, error);
            Err(rollback_backend_selection(
                &mut manager,
                previous_runtime,
                previous_transport,
                error,
            ))
        }
    }
}

/// Restarts and persists the explicitly selected C++ backend.
#[tauri::command]
pub fn backend_cpp_transport_start(
    app: AppHandle,
    backend: State<'_, BackendProcessManager>,
    pipe: State<'_, BackendPipeManager>,
    mode: String,
) -> Result<BackendReadyPayload, String> {
    let transport = match mode.as_str() {
        "websocket" => BackendTransport::Websocket,
        "pipe" => return Err(
            "C++ Pipe transport is not available until its production channel factory is complete"
                .to_string(),
        ),
        _ => return Err(format!("unsupported C++ backend transport: {mode}")),
    };
    let mut manager = ensure_default_config(&app)?;
    let previous_runtime = manager.config.general.backend_runtime;
    let previous_transport = manager.config.general.transport;
    manager
        .update(|config| {
            config.general.backend_runtime = BackendRuntime::Cpp;
            config.general.transport = transport;
        })
        .map_err(|error| error.message())?;
    let mut started = false;
    let result = (|| {
        backend.stop_for_config(&manager.config)?;
        pipe.close_all()?;
        thread::sleep(Duration::from_millis(300));

        let port = available_backend_port()?;
        start_cpp_backend_detached(&app, &manager.config, port)?;
        started = true;
        track_and_wait_backend(&backend, &manager.config, port, BackendRuntime::Cpp)?;
        system_log(
            "INFO",
            "backend_process",
            format!("C++ backend transport ready mode={mode} port={port}"),
        );
        Ok(BackendReadyPayload {
            base_backend_addr: "127.0.0.1".to_string(),
            base_backend_port: port,
        })
    })();
    match result {
        Ok(payload) => Ok(payload),
        Err(error) => {
            let error = cleanup_started_backend(&manager.config, started, error);
            Err(rollback_backend_selection(
                &mut manager,
                previous_runtime,
                previous_transport,
                error,
            ))
        }
    }
}

/// Waits for the selected backend and stops a rejected child without changing runtime.
fn track_and_wait_backend(
    backend: &BackendProcessManager,
    config: &UpdaterConfig,
    port: u16,
    runtime: BackendRuntime,
) -> Result<(), String> {
    let ready = backend
        .remember_config(config)
        .and_then(|()| match runtime {
            BackendRuntime::Python => wait_for_backend_auth_endpoint(port),
            BackendRuntime::Cpp => wait_for_cpp_backend_ready(port),
        });
    if let Err(error) = ready {
        return match stop_backend_pid_file(&backend_pid_path(config)) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; failed to stop rejected {runtime:?} backend: {cleanup_error}"
            )),
        };
    }
    Ok(())
}

/// Stops a child started by a switch when a later activation step rejects it.
fn cleanup_started_backend(config: &UpdaterConfig, started: bool, error: String) -> String {
    if !started {
        return error;
    }
    match stop_backend_pid_file(&backend_pid_path(config)) {
        Ok(()) => error,
        Err(cleanup_error) => {
            format!("{error}; failed to stop rejected backend: {cleanup_error}")
        }
    }
}

/// Restores the last working persisted selection after an explicit switch fails.
fn rollback_backend_selection(
    manager: &mut ConfigManager,
    runtime: BackendRuntime,
    transport: BackendTransport,
    error: String,
) -> String {
    match manager.update(|config| {
        config.general.backend_runtime = runtime;
        config.general.transport = transport;
    }) {
        Ok(()) => error,
        Err(rollback_error) => format!(
            "{error}; failed to restore previous backend selection: {}",
            rollback_error.message()
        ),
    }
}

/// Performs the updater abort workflow operation.
#[tauri::command]
pub fn updater_abort_workflow(
    request: Option<WorkflowAbortRequest>,
    manager: State<'_, UpdaterTermManager>,
) -> Result<WorkflowAbortReport, String> {
    system_log("WARNING", "updater", "Updater workflow abort requested");
    manager.abort(request.unwrap_or_default())
}

/// Performs the updater terminal snapshot operation.
#[tauri::command]
pub fn updater_terminal_snapshot(
    manager: State<'_, UpdaterTermManager>,
) -> Result<TerminalSnapshot, String> {
    system_log(
        "TRACE",
        "updater_terminal",
        "Updater terminal snapshot requested",
    );
    manager.snapshot()
}

/// Performs the updater resize term operation.
#[tauri::command]
pub fn updater_resize_term(
    manager: State<'_, UpdaterTermManager>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    system_log(
        "DEBUG",
        "updater_terminal",
        "Updater terminal resize requested",
    );
    manager.resize(rows, cols)
}

/// Returns the parse requested channel result.
fn parse_requested_channel(
    requested: Option<&str>,
    fallback: UpdateChannel,
) -> Result<UpdateChannel, String> {
    match requested {
        Some(value) if !value.trim().is_empty() => {
            UpdateChannel::parse(value).map_err(|error| error.message())
        }
        _ => Ok(fallback),
    }
}

/// Returns the normalized sha method result.
fn normalized_sha_method(value: &str) -> String {
    match value.trim() {
        "" | "git2" | "git_cli" | "auto" => "github".to_string(),
        other => other.to_string(),
    }
}

/// Handles the desktop local main sha workflow.
fn desktop_local_main_sha(config: &UpdaterConfig) -> Option<String> {
    let configured = config.general.current_baas_sha.trim();
    if !configured.is_empty() {
        return Some(configured.to_string());
    }
    let root = PathBuf::from(config.paths.baas_root_path.trim());
    if root.as_os_str().is_empty() {
        return None;
    }
    git_rev_parse_head(&root).ok()
}

/// Handles the desktop first remote sha workflow.
fn desktop_first_remote_sha(
    channel: UpdateChannel,
    preferred_method: &str,
) -> Result<(String, String), String> {
    let branch = repository_branch(RepositoryKind::Main).map_err(|error| error.message())?;
    let methods = sha_method_sources(channel);
    let mut ordered = Vec::new();
    if methods
        .iter()
        .any(|(name, url)| name == preferred_method && url.is_some())
    {
        ordered.push(preferred_method.to_string());
    }
    for (name, url) in &methods {
        if url.is_some() && !ordered.iter().any(|item| item == name) {
            ordered.push(name.clone());
        }
    }

    let mut last_error = None;
    for method in ordered {
        let Some((_, Some(url))) = methods.iter().find(|(name, _)| name == &method) else {
            continue;
        };
        match git_ls_remote_with_timeout(url, &branch, Duration::from_secs(15)) {
            Ok(sha) => return Ok((method, sha)),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "no git source configured".to_string()))
}

/// Verifies the sha test timeout behavior.
fn sha_test_timeout(timeout: Option<f64>) -> Duration {
    Duration::from_secs_f64(
        timeout
            .unwrap_or(SHA_TEST_TIMEOUT_SECONDS)
            .clamp(0.1, SHA_TEST_TIMEOUT_SECONDS),
    )
}

/// Performs the run sha probe operation.
async fn run_sha_probe(
    name: String,
    order: i32,
    url: Option<String>,
    branch: String,
    timeout: Duration,
) -> UpdaterShaTestReport {
    let start = Instant::now();
    let worker_name = name.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || match url {
        Some(url) => match git_ls_remote_with_timeout(&url, &branch, timeout) {
            Ok(value) => UpdaterShaTestReport {
                success: true,
                name: worker_name,
                order,
                duration: start.elapsed().as_secs_f64(),
                value: Some(value),
                error: None,
            },
            Err(error) => UpdaterShaTestReport {
                success: false,
                name: worker_name,
                order: -1,
                duration: start.elapsed().as_secs_f64(),
                value: None,
                error: Some(error),
            },
        },
        None => UpdaterShaTestReport {
            success: false,
            name: worker_name,
            order: -1,
            duration: start.elapsed().as_secs_f64(),
            value: None,
            error: Some("not a git source".to_string()),
        },
    });

    match time::timeout(timeout + Duration::from_millis(100), worker).await {
        Ok(Ok(report)) => report,
        Ok(Err(error)) => UpdaterShaTestReport {
            success: false,
            name,
            order: -1,
            duration: start.elapsed().as_secs_f64(),
            value: None,
            error: Some(error.to_string()),
        },
        Err(_) => UpdaterShaTestReport {
            success: false,
            name,
            order: -1,
            duration: timeout.as_secs_f64(),
            value: None,
            error: Some(format!(
                "git ls-remote timed out after {:.1}s",
                timeout.as_secs_f64()
            )),
        },
    }
}

/// Handles the sha method sources workflow.
fn sha_method_sources(channel: UpdateChannel) -> Vec<(String, Option<String>)> {
    let urls = repository_urls(RepositoryKind::Main, channel);
    vec![
        ("github".to_string(), urls.first().cloned()),
        ("mirrorc".to_string(), None),
        ("gitee".to_string(), find_url(&urls, "gitee.com")),
        ("gitcode".to_string(), find_url(&urls, "gitcode.com")),
        (
            "github_proxy_v4".to_string(),
            find_url(&urls, "v4.gh-proxy.org"),
        ),
        (
            "github_proxy_v6".to_string(),
            find_url(&urls, "v6.gh-proxy.org"),
        ),
        (
            "github_proxy_cdn".to_string(),
            find_url(&urls, "cdn.gh-proxy.org"),
        ),
        ("gh_proxy".to_string(), find_url(&urls, "://gh-proxy.org")),
        ("sevencdn".to_string(), find_url(&urls, "gh.sevencdn.com")),
        ("githubfast".to_string(), find_url(&urls, "githubfast.com")),
        (
            "baas_cdn".to_string(),
            find_url(&urls, "baas-cdn.kiramei.workers.dev"),
        ),
    ]
}

/// Returns the find url result.
fn find_url(urls: &[String], needle: &str) -> Option<String> {
    urls.iter().find(|url| url.contains(needle)).cloned()
}

/// Handles the git rev parse head workflow.
fn git_rev_parse_head(root: &Path) -> Result<String, String> {
    let mut command = Command::new("git");
    hide_command_window(&mut command);
    configure_git_environment(&mut command);
    let output = command
        .arg("rev-parse")
        .arg("HEAD")
        .current_dir(root)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Handles the git ls remote with timeout workflow.
fn git_ls_remote_with_timeout(
    url: &str,
    branch: &str,
    timeout: Duration,
) -> Result<String, String> {
    let mut command = Command::new("git");
    hide_command_window(&mut command);
    configure_git_environment(&mut command);
    command
        .arg("-c")
        .arg("credential.interactive=never")
        .arg("ls-remote")
        .arg("--heads")
        .arg(url)
        .arg(branch)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let start = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            let output = child
                .wait_with_output()
                .map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            return String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .next()
                .filter(|sha| !sha.is_empty())
                .map(ToOwned::to_owned)
                .ok_or_else(|| format!("remote branch not found: {url} {branch}"));
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "git ls-remote timed out after {:.1}s",
                timeout.as_secs_f64()
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

/// Handles the configure git environment workflow.
fn configure_git_environment(command: &mut Command) {
    command
        .arg("-c")
        .arg("credential.helper=")
        .arg("-c")
        .arg("credential.interactive=never")
        .arg("-c")
        .arg("core.askPass=echo")
        .arg("-c")
        .arg("core.sshCommand=ssh -o BatchMode=yes")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GCM_MODAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo")
        .env("SSH_ASKPASS", "echo");
}

/// Handles the hide command window workflow.
#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

/// Handles the hide command window workflow.
#[cfg(not(target_os = "windows"))]
fn hide_command_window(_command: &mut Command) {}

fn normalized_adb_serial(serial: Option<&str>) -> Result<String, String> {
    let serial = serial.unwrap_or("").trim();
    if serial.is_empty() || serial == "auto" {
        return Ok("emulator-5556".to_string());
    }
    Ok(serial.to_string())
}

fn adb_output(serial: &str, args: &[&str], log: &mut Vec<String>) -> Result<String, String> {
    let mut command = Command::new("adb");
    command.arg("-s").arg(serial).args(args);
    hide_command_window(&mut command);
    let output = command.output().map_err(|error| {
        format!("failed to run adb. Ensure adb is installed and available in PATH: {error}")
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    log.push(format!("adb -s {serial} {}", args.join(" ")));
    if !stdout.trim().is_empty() {
        log.push(stdout.trim().to_string());
    }
    if !stderr.trim().is_empty() {
        log.push(stderr.trim().to_string());
    }
    if !output.status.success() {
        return Err(format!(
            "adb command failed: adb -s {serial} {}\n{}{}",
            args.join(" "),
            stdout,
            stderr
        ));
    }
    Ok(stdout)
}

fn adb_checked(serial: &str, args: &[&str], log: &mut Vec<String>) -> Result<(), String> {
    adb_output(serial, args, log).map(|_| ())
}

fn parse_overlay_display_id(dump: &str, width: u32, height: u32) -> Option<u32> {
    let mut current_id = None;
    let mut candidates = Vec::new();
    let expected_size = format!("cur={width}x{height}");
    for line in dump.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Display: mDisplayId=") {
            let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
            current_id = digits.parse::<u32>().ok();
            continue;
        }
        if let Some(display_id) = current_id {
            if display_id != 0 && trimmed.contains(&expected_size) {
                candidates.push(display_id);
                current_id = None;
            }
        }
    }
    candidates.into_iter().max()
}

fn resolve_blue_archive_package(serial: &str, log: &mut Vec<String>) -> Result<String, String> {
    for package in [
        "com.RoamingStar.BlueArchive.bilibili",
        "com.RoamingStar.BlueArchive",
    ] {
        if adb_output(serial, &["shell", "pm", "path", package], log)
            .map(|output| output.contains("package:"))
            .unwrap_or(false)
        {
            return Ok(package.to_string());
        }
    }
    Err("Blue Archive package not found on the selected adb device".to_string())
}

/// Returns the active setup.toml manager without using app-data setup storage.
pub fn ensure_default_config(app: &AppHandle) -> Result<ConfigManager, String> {
    let portable = is_portable_install();
    let default_install_path = default_install_path();
    let install_path = startup_install_path(app, portable, &default_install_path)?;
    config_manager_for_install_path(&install_path, portable)
}

/// Performs the ensure config for install path operation.
fn ensure_config_for_install_path(
    app: &AppHandle,
    install_path: Option<&Path>,
) -> Result<ConfigManager, String> {
    let portable = is_portable_install();
    if portable {
        let mut manager = load_config_recovering_invalid(portable_config_path()?)?;
        normalize_portable_config(&mut manager)?;
        return Ok(manager);
    }

    let install_path = match install_path {
        Some(path) => path.to_path_buf(),
        None => startup_install_path(app, false, &default_install_path())?,
    };
    let mut manager = config_manager_for_install_path(&install_path, false)?;
    manager
        .update(|config| {
            config.paths.baas_root_path = install_path.to_string_lossy().to_string();
        })
        .map_err(|error| error.message())?;
    Ok(manager)
}

/// Handles the config manager for install path workflow.
fn config_manager_for_install_path(
    install_path: &Path,
    portable: bool,
) -> Result<ConfigManager, String> {
    if portable {
        let mut manager = load_config_recovering_invalid(portable_config_path()?)?;
        normalize_portable_config(&mut manager)?;
        return Ok(manager);
    }

    let config_path = install_path.join("setup.toml");
    let mut manager = load_config_recovering_invalid(config_path)?;
    manager.config.paths.baas_root_path = install_path.to_string_lossy().to_string();
    Ok(manager)
}

/// Loads setup.toml and recovers from malformed TOML by preserving a backup.
fn load_config_recovering_invalid(config_path: PathBuf) -> Result<ConfigManager, String> {
    match ConfigManager::load_from(&config_path) {
        Ok(manager) => Ok(manager),
        Err(error) if error.code() == "config" && config_path.exists() => {
            let backup_path = invalid_config_backup_path(&config_path);
            backup_invalid_config(&config_path, &backup_path)?;
            let manager = ConfigManager {
                config_path,
                config: UpdaterConfig::default(),
            };
            manager.save().map_err(|error| error.message())?;
            Ok(manager)
        }
        Err(error) => Err(error.message()),
    }
}

/// Returns the malformed setup.toml backup path.
fn invalid_config_backup_path(config_path: &Path) -> PathBuf {
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
    let file_name = config_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("setup.toml");
    config_path.with_file_name(format!("{file_name}.invalid-{timestamp}"))
}

/// Moves a malformed setup.toml aside while preserving its contents.
fn backup_invalid_config(config_path: &Path, backup_path: &Path) -> Result<(), String> {
    fs::rename(config_path, backup_path)
        .or_else(|_| {
            fs::copy(config_path, backup_path)?;
            fs::remove_file(config_path)
        })
        .map_err(|error| error.to_string())
        .map(|_| ())
}

/// Performs the startup install path operation.
fn startup_install_path(
    app: &AppHandle,
    portable: bool,
    default_install_path: &Path,
) -> Result<PathBuf, String> {
    if portable {
        return Ok(PathBuf::from("."));
    }

    Ok(read_stored_install_path(app, portable)?
        .filter(|path| path_exists_non_empty(path))
        .unwrap_or_else(|| default_install_path.to_path_buf()))
}

/// Handles the configure portable working dir workflow.
pub fn configure_portable_working_dir() -> Result<(), String> {
    if !is_portable_install() {
        return Ok(());
    }
    let Some(dir) = current_exe_dir() else {
        return Ok(());
    };
    std::env::set_current_dir(&dir).map_err(|error| error.to_string())
}

/// Returns the normalize portable config result.
fn normalize_portable_config(manager: &mut ConfigManager) -> Result<(), String> {
    if manager.config.paths.baas_root_path == "." {
        return Ok(());
    }
    manager
        .update(|config| {
            config.paths.baas_root_path = ".".to_string();
        })
        .map_err(|error| error.message())
}

/// Handles the persisted baas root path workflow.
fn persisted_baas_root_path(path: &Path, portable: bool) -> String {
    if portable {
        ".".to_string()
    } else {
        path.to_string_lossy().to_string()
    }
}

/// Returns the is portable install result.
fn is_portable_install() -> bool {
    exe_adjacent_config_path()
        .map(|path| path.exists())
        .unwrap_or(false)
}

/// Handles the portable config path workflow.
fn portable_config_path() -> Result<PathBuf, String> {
    exe_adjacent_config_path().map_err(|error| error.message())
}

/// Handles the current exe dir workflow.
fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

/// Handles the storage file path workflow.
fn storage_file_path(app: &AppHandle, portable: bool) -> Result<PathBuf, String> {
    if portable {
        return Ok(current_exe_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(STORAGE_FILE_NAME));
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(STORAGE_FILE_NAME))
}

/// Returns the read stored install path result.
fn read_stored_install_path(app: &AppHandle, portable: bool) -> Result<Option<PathBuf>, String> {
    let path = storage_file_path(app, portable)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Ok(None);
    };
    Ok(value
        .get(STORAGE_INSTALL_DIR_KEY)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from))
}

/// Handles the default install path workflow.
fn default_install_path() -> PathBuf {
    if cfg!(target_os = "windows") {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else if cfg!(target_os = "macos") {
        std::env::current_exe()
            .ok()
            .and_then(|exe| macos_app_adjacent_install_path_from_exe(&exe))
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|dir| dir.join("BAAS"))
                    .unwrap_or_else(|_| PathBuf::from("BAAS"))
            })
    } else {
        directories::BaseDirs::new()
            .map(|dirs| dirs.home_dir().join(".baas"))
            .unwrap_or_else(|| PathBuf::from(".baas"))
    }
}

/// Handles the macos app adjacent install path from exe workflow.
fn macos_app_adjacent_install_path_from_exe(exe: &Path) -> Option<PathBuf> {
    let mut ancestors = exe.ancestors();
    let _exe_path = ancestors.next()?;
    let macos_dir = ancestors.next()?;
    let contents_dir = ancestors.next()?;
    let app_dir = ancestors.next()?;

    if macos_dir.file_name()? != "MacOS"
        || contents_dir.file_name()? != "Contents"
        || app_dir.extension()? != "app"
    {
        return None;
    }

    app_dir.parent().map(|parent| parent.join("BAAS"))
}

/// Handles the path exists non empty workflow.
fn path_exists_non_empty(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.is_dir()
        && fs::read_dir(path)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false)
}

/// Handles the non empty path workflow.
fn non_empty_path(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Performs the delete backend auth files operation.
fn delete_backend_auth_files(config: &UpdaterConfig) -> Result<(), String> {
    let auth_dir = config.baas_root().join("config");
    for filename in [
        "service_auth.json",
        "service_remembered_logins.json",
        "service_signing_key.bin",
        "service_ticket.key",
    ] {
        let path = auth_dir.join(filename);
        if path.exists() {
            fs::remove_file(&path).map_err(|error| {
                format!(
                    "failed to remove backend auth file {}: {error}",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

/// Handles the available backend port workflow.
fn available_backend_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|error| error.to_string())
}

/// Performs the start backend detached operation.
fn start_backend_detached(config: &UpdaterConfig, port: u16) -> Result<(), String> {
    let command = launch_backend_command(config, port);
    spawn_backend_detached(config, port, command)
}

/// Returns a platform-native local Pipe endpoint.
fn backend_pipe_endpoint() -> String {
    #[cfg(windows)]
    return format!(r"\\.\pipe\baas-{}", uuid::Uuid::new_v4());
    #[cfg(unix)]
    return format!("/tmp/baas-{}.sock", uuid::Uuid::new_v4());
}

/// Starts a managed backend with its Pipe listener enabled.
fn start_backend_pipe_detached(
    config: &UpdaterConfig,
    port: u16,
    pipe_name: &str,
) -> Result<(), String> {
    let command = launch_backend_pipe_command(config, port, pipe_name);
    spawn_backend_detached(config, port, command)
}

/// Starts the explicit C++ backend on its HTTP/WebSocket listener.
fn start_cpp_backend_detached(
    app: &AppHandle,
    config: &UpdaterConfig,
    port: u16,
) -> Result<(), String> {
    let executable = resolve_cpp_service_executable(app)?;
    let command = launch_cpp_backend_command(config, port, executable);
    spawn_backend_detached(config, port, command)
}

/// Resolves the service only from an explicit override or an application-owned
/// layout. The BAAS project root is data and is deliberately not executable
/// search space.
fn resolve_cpp_service_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let override_path = std::env::var_os("BAAS_CPP_SERVICE_PATH").filter(|value| !value.is_empty());
    if let Some(path) = override_path {
        return validate_cpp_service_executable(PathBuf::from(path), "BAAS_CPP_SERVICE_PATH");
    }

    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push((
            resource_dir.join(cpp_service_executable_name()),
            resource_dir,
        ));
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push((
                parent.join(cpp_service_executable_name()),
                parent.to_path_buf(),
            ));
        }
    }
    if cfg!(debug_assertions) {
        let owner = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        candidates.push((owner.join(cpp_service_executable_name()), owner));
    }
    candidates.dedup();

    for (candidate, owner) in &candidates {
        if candidate.is_file() {
            return validate_owned_cpp_service_executable(
                candidate.clone(),
                owner,
                "application layout",
            );
        }
    }
    Err(format!(
        "BAAS C++ service is not installed; checked {}. Set BAAS_CPP_SERVICE_PATH to an absolute verified {} for development",
        candidates
            .iter()
            .map(|(path, _)| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
        cpp_service_executable_name()
    ))
}

/// Canonicalizes and validates a service path without invoking shell or PATH
/// lookup semantics.
fn validate_cpp_service_executable(path: PathBuf, source: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!(
            "{source} must be an absolute path to {}: {}",
            cpp_service_executable_name(),
            path.display()
        ));
    }
    if path.file_name().and_then(|name| name.to_str()) != Some(cpp_service_executable_name()) {
        return Err(format!(
            "{source} must name exactly {}: {}",
            cpp_service_executable_name(),
            path.display()
        ));
    }
    if !path.is_file() {
        return Err(format!(
            "{source} is not a service file: {}",
            path.display()
        ));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize {}: {error}", path.display()))?;
    if canonical.file_name().and_then(|name| name.to_str()) != Some(cpp_service_executable_name()) {
        return Err(format!(
            "{source} resolves to a file not named exactly {}: {}",
            cpp_service_executable_name(),
            canonical.display()
        ));
    }
    Ok(canonical)
}

/// Prevents application-owned resource candidates from escaping their owning
/// directory through a symlink or reparse point.
fn validate_owned_cpp_service_executable(
    path: PathBuf,
    owner: &Path,
    source: &str,
) -> Result<PathBuf, String> {
    let canonical_owner = owner
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize {}: {error}", owner.display()))?;
    let canonical = validate_cpp_service_executable(path, source)?;
    if canonical.parent() != Some(canonical_owner.as_path()) {
        return Err(format!(
            "{source} escapes its application-owned directory {}: {}",
            canonical_owner.display(),
            canonical.display()
        ));
    }
    Ok(canonical)
}

/// Spawns one prepared backend command and records its PID.
fn spawn_backend_detached(
    config: &UpdaterConfig,
    port: u16,
    command: baas_updater::environ::CommandSpec,
) -> Result<(), String> {
    system_log(
        "INFO",
        "backend_process",
        format!(
            "Starting backend program={} args={:?} cwd={:?} port={port}",
            command.program.display(),
            command.args,
            command.cwd
        ),
    );
    let mut process = Command::new(&command.program);
    process.args(&command.args);
    if let Some(cwd) = &command.cwd {
        process.current_dir(cwd);
    }
    for (key, value) in &command.env {
        process.env(key, value);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }
    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let child_id = child.id();
    let pid_file = command
        .detached_pid_file
        .clone()
        .unwrap_or_else(|| backend_pid_path(config));
    let persist_pid = persist_managed_backend_pid(&pid_file, child_id, config);
    if let Err(error) = persist_pid {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "failed to persist backend pid {child_id}; process was terminated: {error}"
        ));
    }
    system_log(
        "INFO",
        "backend_process",
        format!(
            "Backend process spawned pid={} pid_file={}",
            child_id,
            pid_file.display()
        ),
    );
    Ok(())
}

const CPP_BACKEND_READY_RESPONSE_LIMIT: usize = 64 * 1024;

const MANAGED_BACKEND_PID_SCHEMA: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ManagedBackendKind {
    Python,
    Cpp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ManagedBackendPid {
    schema: u8,
    pid: u32,
    executable: PathBuf,
    project_root: PathBuf,
    start_identity: String,
    kind: ManagedBackendKind,
}

#[derive(Debug)]
struct BackendProcessIdentity {
    executable: PathBuf,
    args: Vec<String>,
    raw_command_line: String,
    structured_args: bool,
    start_identity: String,
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffersize: u32) -> i32;
}

/// Waits for both the C++ service identity and ready health projection.
fn wait_for_cpp_backend_ready(port: u16) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        if cpp_backend_ready(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(300));
    }
    Err(format!(
        "C++ backend did not publish ready BAAS service health on 127.0.0.1:{port}"
    ))
}

/// Accepts only the expected BAAS v1 service and a ready health response.
fn cpp_backend_ready(port: u16) -> bool {
    let Some(version) = backend_http_json(port, "/version") else {
        return false;
    };
    if version.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
        || version
            .get("api_version")
            .and_then(serde_json::Value::as_u64)
            != Some(1)
        || version.get("service").and_then(serde_json::Value::as_str) != Some("BAAS Service")
    {
        return false;
    }
    let Some(health) = backend_http_json(port, "/health") else {
        return false;
    };
    health.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
        && health
            .pointer("/statuses/runtime/phase")
            .and_then(serde_json::Value::as_str)
            == Some("ready")
}

/// Reads one bounded connection-close JSON response with an exact 200 status.
fn backend_http_json(port: u16, path: &str) -> Option<serde_json::Value> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    let timeout = Some(Duration::from_millis(700));
    stream.set_read_timeout(timeout).ok()?;
    stream.set_write_timeout(timeout).ok()?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;

    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                if response.len().checked_add(read)? > CPP_BACKEND_READY_RESPONSE_LIMIT {
                    return None;
                }
                response.extend_from_slice(&chunk[..read]);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                break
            }
            Err(_) => return None,
        }
    }

    let header_end = response.windows(4).position(|part| part == b"\r\n\r\n")?;
    let headers = std::str::from_utf8(&response[..header_end]).ok()?;
    let mut lines = headers.split("\r\n");
    let mut status = lines.next()?.split_ascii_whitespace();
    let version = status.next()?;
    if !matches!(version, "HTTP/1.1" | "HTTP/1.0")
        || status.next()? != "200"
        || status.next().is_none()
    {
        return None;
    }
    let mut content_length = None;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return None;
        }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return None;
            }
            content_length = Some(value.trim().parse::<usize>().ok()?);
        }
    }
    let body = &response[header_end + 4..];
    if content_length? != body.len() {
        return None;
    }
    serde_json::from_slice(body).ok()
}

/// Performs the wait for backend auth endpoint operation.
fn wait_for_backend_auth_endpoint(port: u16) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        if backend_auth_endpoint_ready(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(300));
    }
    Err(format!(
        "backend auth endpoint did not become ready on 127.0.0.1:{port}"
    ))
}

/// Handles the backend auth endpoint ready workflow.
fn backend_auth_endpoint_ready(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(700));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    if stream
        .write_all(b"GET /auth/remember HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 16];
    stream
        .read(&mut response)
        .map(|read| read > 0 && response.starts_with(b"HTTP/"))
        .unwrap_or(false)
}

/// Captures and persists executable, project-root, and start-time identity for
/// one freshly spawned backend. No PID-only record is ever produced.
fn persist_managed_backend_pid(
    pid_file: &Path,
    pid: u32,
    config: &UpdaterConfig,
) -> Result<(), String> {
    let project_root = config
        .baas_root()
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize BAAS root: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let identity = loop {
        if let Some(identity) = backend_process_identity(pid)? {
            break identity;
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "spawned backend PID {pid} has no observable process identity"
            ));
        }
        thread::sleep(Duration::from_millis(25));
    };
    let kind = backend_process_kind(&identity).ok_or_else(|| {
        format!("spawned PID {pid} does not expose a recognized BAAS backend command line")
    })?;
    if !identity_binds_project_root(&identity, &kind, &project_root) {
        return Err(format!(
            "spawned backend PID {pid} is not bound to project root {}",
            project_root.display()
        ));
    }
    let record = ManagedBackendPid {
        schema: MANAGED_BACKEND_PID_SCHEMA,
        pid,
        executable: identity.executable,
        project_root,
        start_identity: identity.start_identity,
        kind,
    };
    if let Some(parent) = pid_file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let encoded = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    let temporary = pid_file.with_extension(format!("pid.tmp.{pid}"));
    let _ = fs::remove_file(&temporary);
    fs::write(&temporary, encoded).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary, pid_file) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

fn backend_process_kind(identity: &BackendProcessIdentity) -> Option<ManagedBackendKind> {
    let executable_basename = identity
        .executable
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if (executable_basename.eq_ignore_ascii_case("baas_service.exe")
        || executable_basename.eq_ignore_ascii_case("baas_service"))
        && contains_cli_flag(&identity.args, "--project-root")
        && contains_cli_flag(&identity.args, "--host")
        && contains_cli_flag(&identity.args, "--port")
    {
        return Some(ManagedBackendKind::Cpp);
    }
    if identity
        .args
        .iter()
        .any(|arg| command_basename(arg).eq_ignore_ascii_case("main.service.py"))
        && contains_cli_flag(&identity.args, "--host")
        && contains_cli_flag(&identity.args, "--port")
    {
        return Some(ManagedBackendKind::Python);
    }
    None
}

fn cli_flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    for (index, arg) in args.iter().enumerate() {
        if arg == flag {
            return args.get(index + 1).map(String::as_str);
        }
        if let Some(value) = arg.strip_prefix(&format!("{flag}=")) {
            return Some(value);
        }
    }
    None
}

fn canonical_path_matches(value: &str, expected: &Path) -> bool {
    Path::new(value)
        .canonicalize()
        .map(|path| path == expected)
        .unwrap_or(false)
}

fn identity_binds_project_root(
    identity: &BackendProcessIdentity,
    kind: &ManagedBackendKind,
    project_root: &Path,
) -> bool {
    match kind {
        ManagedBackendKind::Cpp => {
            cli_flag_value(&identity.args, "--project-root")
                .is_some_and(|value| canonical_path_matches(value, project_root))
                || (!identity.structured_args
                    && (identity.raw_command_line.contains(&format!(
                        "--project-root {}",
                        project_root.to_string_lossy()
                    )) || identity.raw_command_line.contains(&format!(
                        "--project-root \"{}\"",
                        project_root.to_string_lossy()
                    ))))
        }
        ManagedBackendKind::Python => {
            let script = project_root.join("main.service.py");
            identity
                .args
                .iter()
                .any(|arg| canonical_path_matches(arg, &script))
                || (!identity.structured_args
                    && identity
                        .raw_command_line
                        .contains(script.to_string_lossy().as_ref()))
        }
    }
}

fn managed_backend_identity_matches(
    record: &ManagedBackendPid,
    identity: &BackendProcessIdentity,
) -> bool {
    record.schema == MANAGED_BACKEND_PID_SCHEMA
        && identity.executable == record.executable
        && identity.start_identity == record.start_identity
        && backend_process_kind(identity).as_ref() == Some(&record.kind)
        && identity_binds_project_root(identity, &record.kind, &record.project_root)
}

/// Performs the stop backend pid file operation.
fn stop_backend_pid_file(pid_file: &Path) -> Result<(), String> {
    let Some(record) = read_managed_backend_pid(pid_file)? else {
        return Ok(());
    };
    let Some(identity) = backend_process_identity(record.pid)? else {
        fs::remove_file(pid_file).map_err(|error| error.to_string())?;
        return Ok(());
    };
    if !managed_backend_identity_matches(&record, &identity) {
        return Err(format!(
            "managed backend PID {} identity mismatch; refusing to terminate it and preserving {}",
            record.pid,
            pid_file.display()
        ));
    }
    terminate_managed_backend(&record)?;
    fs::remove_file(pid_file).map_err(|error| error.to_string())?;
    Ok(())
}

/// Reads a strong process record. Live legacy numeric PID files are retained
/// and rejected because they cannot prove executable/start ownership.
fn read_managed_backend_pid(pid_file: &Path) -> Result<Option<ManagedBackendPid>, String> {
    if !pid_file.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(pid_file).map_err(|error| error.to_string())?;
    if text.trim().is_empty() {
        fs::remove_file(pid_file).map_err(|error| error.to_string())?;
        return Ok(None);
    }
    if let Ok(record) = serde_json::from_str::<ManagedBackendPid>(&text) {
        if record.schema != MANAGED_BACKEND_PID_SCHEMA || record.pid == 0 {
            return Err(format!(
                "unsupported managed backend PID record in {}",
                pid_file.display()
            ));
        }
        return Ok(Some(record));
    }
    if let Ok(pid) = text.trim().parse::<u32>() {
        if pid > 0 && backend_process_identity(pid)?.is_none() {
            fs::remove_file(pid_file).map_err(|error| error.to_string())?;
            return Ok(None);
        }
        return Err(format!(
            "live legacy backend PID file {} has no strong identity; refusing cleanup",
            pid_file.display()
        ));
    }
    Err(format!(
        "malformed managed backend PID record {}; preserving it",
        pid_file.display()
    ))
}

/// Returns whether a process command line belongs to a backend launched here.
///
/// Exact executable/script basenames plus the launcher's required flags avoid
/// matching similarly named tests, owners, or unrelated service processes.
#[cfg(test)]
fn is_managed_backend_command_line(command_line: &str) -> bool {
    let tokens = split_command_line(command_line);
    let python = tokens
        .get(1)
        .is_some_and(|token| command_basename(token).eq_ignore_ascii_case("main.service.py"))
        && contains_cli_flag(&tokens, "--host")
        && contains_cli_flag(&tokens, "--port");
    let cpp = tokens.first().is_some_and(|token| {
        let basename = command_basename(token);
        basename.eq_ignore_ascii_case("baas_service.exe")
            || basename.eq_ignore_ascii_case("baas_service")
    }) && contains_cli_flag(&tokens, "--project-root")
        && contains_cli_flag(&tokens, "--host")
        && contains_cli_flag(&tokens, "--port");
    python || cpp
}

/// Splits the platform command-line representation used by CIM and `ps`.
fn split_command_line(command_line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    for value in command_line.chars() {
        match value {
            '"' => quoted = !quoted,
            value if value.is_whitespace() && !quoted => {
                if !token.is_empty() {
                    tokens.push(std::mem::take(&mut token));
                }
            }
            value => token.push(value),
        }
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    tokens
}

/// Returns one executable or script basename for either path separator.
fn command_basename(token: &str) -> &str {
    token.rsplit(['/', '\\']).next().unwrap_or(token)
}

/// Finds one exact CLI flag token or its `--flag=value` spelling.
fn contains_cli_flag(tokens: &[String], flag: &str) -> bool {
    tokens.iter().any(|token| {
        token == flag
            || token
                .strip_prefix(flag)
                .is_some_and(|rest| rest.starts_with('='))
    })
}

#[cfg(target_os = "windows")]
fn backend_process_identity(pid: u32) -> Result<Option<BackendProcessIdentity>, String> {
    use std::os::windows::process::CommandExt;

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct CimIdentity {
        executable_path: String,
        command_line: String,
        creation_date: String,
    }

    let query = format!(
        "$process = Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" -ErrorAction SilentlyContinue; \
         if ($null -ne $process) {{ [pscustomobject]@{{ ExecutablePath = $process.ExecutablePath; \
         CommandLine = $process.CommandLine; CreationDate = $process.CreationDate.ToUniversalTime().ToString('o') }} \
         | ConvertTo-Json -Compress }}"
    );
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &query,
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("failed to query process identity for PID {pid}"));
    }
    let text = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let cim: CimIdentity = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let executable = PathBuf::from(&cim.executable_path)
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize process executable: {error}"))?;
    Ok(Some(BackendProcessIdentity {
        executable,
        args: split_command_line(&cim.command_line),
        raw_command_line: cim.command_line,
        structured_args: true,
        start_identity: cim.creation_date,
    }))
}

#[cfg(target_os = "linux")]
fn backend_process_identity(pid: u32) -> Result<Option<BackendProcessIdentity>, String> {
    let proc_root = PathBuf::from(format!("/proc/{pid}"));
    let executable = match fs::read_link(proc_root.join("exe")) {
        Ok(path) => path
            .canonicalize()
            .map_err(|error| format!("failed to canonicalize /proc/{pid}/exe: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read /proc/{pid}/exe: {error}")),
    };
    let command_bytes = fs::read(proc_root.join("cmdline"))
        .map_err(|error| format!("failed to read /proc/{pid}/cmdline: {error}"))?;
    let args = command_bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8(part.to_vec()).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let stat = fs::read_to_string(proc_root.join("stat"))
        .map_err(|error| format!("failed to read /proc/{pid}/stat: {error}"))?;
    let after_name = stat
        .rsplit_once(')')
        .map(|(_, rest)| rest.trim())
        .ok_or_else(|| format!("malformed /proc/{pid}/stat"))?;
    let start_identity = after_name
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| format!("missing start time in /proc/{pid}/stat"))?
        .to_string();
    Ok(Some(BackendProcessIdentity {
        executable,
        raw_command_line: args.join(" "),
        args,
        structured_args: true,
        start_identity,
    }))
}

#[cfg(target_os = "macos")]
fn backend_process_identity(pid: u32) -> Result<Option<BackendProcessIdentity>, String> {
    let mut buffer = vec![0_u8; 4096];
    // SAFETY: the writable buffer matches the length passed to proc_pidpath.
    let length = unsafe {
        proc_pidpath(
            pid as i32,
            buffer.as_mut_ptr().cast::<std::ffi::c_void>(),
            buffer.len() as u32,
        )
    };
    if length <= 0 {
        let status = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .map_err(|error| error.to_string())?;
        let process_status = String::from_utf8(status.stdout)
            .map_err(|error| error.to_string())?
            .trim()
            .to_string();
        if process_status.is_empty() || process_status.starts_with('Z') {
            return Ok(None);
        }
        return Err(format!(
            "cannot inspect executable identity for live PID {pid}"
        ));
    }
    buffer.truncate(length as usize);
    let executable = PathBuf::from(String::from_utf8(buffer).map_err(|error| error.to_string())?)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let command = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .map_err(|error| error.to_string())?;
    let raw_command_line = String::from_utf8(command.stdout)
        .map_err(|error| error.to_string())?
        .trim()
        .to_string();
    let start = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .map_err(|error| error.to_string())?;
    let start_identity = String::from_utf8(start.stdout)
        .map_err(|error| error.to_string())?
        .trim()
        .to_string();
    if raw_command_line.is_empty() || start_identity.is_empty() {
        return Err(format!("incomplete process identity for live PID {pid}"));
    }
    Ok(Some(BackendProcessIdentity {
        executable,
        args: split_command_line(&raw_command_line),
        raw_command_line,
        structured_args: false,
        start_identity,
    }))
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn backend_process_identity(_pid: u32) -> Result<Option<BackendProcessIdentity>, String> {
    Err("managed backend identity is unsupported on this platform".to_string())
}

#[cfg(target_os = "windows")]
fn terminate_managed_backend(record: &ManagedBackendPid) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let status = Command::new("taskkill.exe")
        .args(["/PID", &record.pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!(
            "taskkill failed for managed backend PID {}",
            record.pid
        ));
    }
    confirm_managed_backend_exit(record, Duration::from_secs(5))
}

#[cfg(not(target_os = "windows"))]
fn terminate_managed_backend(record: &ManagedBackendPid) -> Result<(), String> {
    let term = Command::new("kill")
        .args(["-TERM", &record.pid.to_string()])
        .status()
        .map_err(|error| error.to_string())?;
    if !term.success() {
        return Err(format!(
            "SIGTERM failed for managed backend PID {}",
            record.pid
        ));
    }
    if confirm_managed_backend_exit(record, Duration::from_secs(1)).is_ok() {
        return Ok(());
    }
    let Some(identity) = backend_process_identity(record.pid)? else {
        return Ok(());
    };
    if !managed_backend_identity_matches(record, &identity) {
        return Ok(());
    }
    let kill = Command::new("kill")
        .args(["-KILL", &record.pid.to_string()])
        .status()
        .map_err(|error| error.to_string())?;
    if !kill.success() {
        return Err(format!(
            "SIGKILL failed for managed backend PID {}",
            record.pid
        ));
    }
    confirm_managed_backend_exit(record, Duration::from_secs(5))
}

fn confirm_managed_backend_exit(
    record: &ManagedBackendPid,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        match backend_process_identity(record.pid)? {
            None => return Ok(()),
            Some(identity) if !managed_backend_identity_matches(record, &identity) => return Ok(()),
            Some(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Some(_) => {
                return Err(format!(
                    "managed backend PID {} remained alive after termination",
                    record.pid
                ))
            }
        }
    }
}

/// Returns the format mirrorc expiry result.
fn format_mirrorc_expiry(expires_at: Option<u64>) -> Option<String> {
    let timestamp = i64::try_from(expires_at?).ok()?;
    DateTime::<Utc>::from_timestamp(timestamp, 0).map(|datetime| {
        datetime
            .with_timezone(&Local)
            .format("%Y-%m-%d %H:%M:%S %:z")
            .to_string()
    })
}

/// Handles the mirrorc validation message workflow.
fn mirrorc_validation_message(
    code: i32,
    mirrorc_message: &str,
    expires_at: Option<&str>,
) -> String {
    match code {
        0 => expires_at
            .map(|timestamp| format!("CDK valid. Expires at {timestamp}."))
            .unwrap_or_else(|| {
                if mirrorc_message.trim().is_empty() {
                    "CDK valid, but MirrorC did not return an expiry time.".to_string()
                } else {
                    format!("{mirrorc_message}. MirrorC did not return an expiry time.")
                }
            }),
        _ if !mirrorc_message.trim().is_empty() => mirrorc_message.to_string(),
        7001 => "The cdk has expired".to_string(),
        7002 => "CDK invalid.".to_string(),
        7003 => "CDK quota exhausted for today.".to_string(),
        7004 => "CDK mismatched for requested resource.".to_string(),
        7005 => "CDK blocked.".to_string(),
        other => format!("MirrorC returned code {other}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepare_real_cpp_service_project(project_root: &Path) {
        let remote_jar = std::env::var_os("BAAS_CPP_SERVICE_REMOTE_JAR")
            .map(PathBuf::from)
            .expect("BAAS_CPP_SERVICE_REMOTE_JAR must accompany BAAS_CPP_SERVICE_PATH");
        assert!(remote_jar.is_absolute());
        assert_eq!(
            remote_jar.file_name().and_then(|name| name.to_str()),
            Some("scrcpy-server.jar")
        );
        assert!(remote_jar.is_file());

        let source = project_root.join("config").join("source");
        let remote = project_root.join("service").join("remote");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&remote).unwrap();
        fs::write(
            source.join("config.json"),
            br#"{"name":"Smoke","server":"JP"}"#,
        )
        .unwrap();
        fs::write(source.join("event.json"), b"[]").unwrap();
        fs::write(
            project_root.join("config").join("static.json"),
            br#"{"version":1,"source":"tauri-rust-smoke"}"#,
        )
        .unwrap();
        fs::write(
            project_root.join("setup.toml"),
            b"[general]\nchannel = 'stable'\n",
        )
        .unwrap();
        fs::copy(remote_jar, remote.join("scrcpy-server.jar")).unwrap();
    }

    #[test]
    fn cpp_transport_command_has_a_desktop_only_acl_chain() {
        const CPP_PERMISSION: &str =
            include_str!("../permissions/autogenerated/commands/cpp-transport-commands.toml");
        const MOBILE_PERMISSION: &str =
            include_str!("../permissions/autogenerated/commands/mobile-commands.toml");
        const DESKTOP_CAPABILITY: &str = include_str!("../capabilities/default.json");
        const ANDROID_CAPABILITY: &str = include_str!("../capabilities/android.json");

        let allowed_commands = CPP_PERMISSION
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with('"'))
            .map(|line| line.trim_matches(&['"', ','][..]))
            .collect::<Vec<_>>();
        assert_eq!(allowed_commands, ["backend_cpp_transport_start"]);
        assert!(!MOBILE_PERMISSION.contains("backend_cpp_transport_start"));
        let desktop: serde_json::Value = serde_json::from_str(DESKTOP_CAPABILITY).unwrap();
        let android: serde_json::Value = serde_json::from_str(ANDROID_CAPABILITY).unwrap();
        let has_permission = |capability: &serde_json::Value| {
            capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|permission| permission.as_str() == Some("allow-cpp-transport-command"))
        };
        assert!(has_permission(&desktop));
        assert!(!has_permission(&android));
    }

    fn serve_cpp_health(
        version: &'static str,
        health: &'static str,
        expected_connections: usize,
    ) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            for _ in 0..expected_connections {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 1024];
                let read = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..read]);
                let body = if request.starts_with("GET /version ") {
                    version
                } else if request.starts_with("GET /health ") {
                    health
                } else {
                    r#"{"ok":false}"#
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (port, handle)
    }

    fn serve_one_response(response: Vec<u8>) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream.write_all(&response).unwrap();
        });
        (port, handle)
    }

    /// The explicit C++ entry accepts only the expected service identity and ready health.
    #[test]
    fn recognizes_ready_cpp_backend() {
        let (port, server) = serve_cpp_health(
            r#"{"ok":true,"api_version":1,"service":"BAAS Service"}"#,
            r#"{"ok":true,"statuses":{"runtime":{"phase":"ready"}}}"#,
            2,
        );
        assert!(cpp_backend_ready(port));
        server.join().unwrap();
    }

    /// An unrelated listener cannot satisfy the explicit C++ readiness contract.
    #[test]
    fn rejects_wrong_cpp_backend_identity() {
        let (port, server) = serve_cpp_health(
            r#"{"ok":true,"api_version":1,"service":"Other Service"}"#,
            r#"{"ok":true}"#,
            1,
        );
        assert!(!cpp_backend_ready(port));
        server.join().unwrap();
    }

    /// A generic healthy response is not enough until the production runtime
    /// explicitly projects its ready phase.
    #[test]
    fn rejects_cpp_backend_before_runtime_ready() {
        let (port, server) = serve_cpp_health(
            r#"{"ok":true,"api_version":1,"service":"BAAS Service"}"#,
            r#"{"ok":true,"statuses":{"runtime":{"phase":"starting"}}}"#,
            2,
        );
        assert!(!cpp_backend_ready(port));
        server.join().unwrap();
    }

    /// Explicit service overrides cannot degrade into PATH lookup or target a
    /// similarly named test executable.
    #[test]
    fn validates_exact_absolute_cpp_service_path() {
        let root = tempfile::tempdir().unwrap();
        let exact = root.path().join(cpp_service_executable_name());
        fs::write(&exact, b"service").unwrap();
        assert_eq!(
            validate_cpp_service_executable(exact.clone(), "test").unwrap(),
            exact.canonicalize().unwrap()
        );
        assert!(validate_cpp_service_executable(
            PathBuf::from(cpp_service_executable_name()),
            "test"
        )
        .unwrap_err()
        .contains("absolute"));
        let owner_test = root.path().join(if cfg!(windows) {
            "BAAS_service_owner_tests.exe"
        } else {
            "BAAS_service_owner_tests"
        });
        fs::write(&owner_test, b"test").unwrap();
        assert!(validate_cpp_service_executable(owner_test, "test")
            .unwrap_err()
            .contains("exactly"));
    }

    /// A service-named symlink/reparse alias cannot redirect execution to an
    /// unrecognized process identity or escape an application-owned directory.
    #[test]
    fn rejects_cpp_service_alias_to_other_executable() {
        let owner = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let other = outside
            .path()
            .join(if cfg!(windows) { "other.exe" } else { "other" });
        fs::write(&other, b"other").unwrap();
        let alias = owner.path().join(cpp_service_executable_name());
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&other, &alias).is_err() {
            return;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&other, &alias).unwrap();

        assert!(validate_cpp_service_executable(alias.clone(), "test")
            .unwrap_err()
            .contains("resolves to"));
        assert!(validate_owned_cpp_service_executable(alias, owner.path(), "test").is_err());
    }

    /// When the real service is discoverable, freeze the Tauri-side readiness
    /// contract and orderly shutdown against an actual loopback process.
    #[test]
    fn real_cpp_service_lifecycle_smoke_when_configured() {
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let Some(executable) = std::env::var_os("BAAS_CPP_SERVICE_PATH") else {
            return;
        };
        let executable =
            validate_cpp_service_executable(PathBuf::from(executable), "test").unwrap();
        let project_root = tempfile::tempdir().unwrap();
        prepare_real_cpp_service_project(project_root.path());
        let port = available_backend_port().unwrap();
        let mut child = ChildGuard(
            Command::new(executable)
                .args([
                    "--project-root",
                    &project_root.path().to_string_lossy(),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            if cpp_backend_ready(port) {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                stream
                    .write_all(
                        b"POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .unwrap();
                let mut response = Vec::new();
                stream.read_to_end(&mut response).unwrap();
                assert!(response.starts_with(b"HTTP/1.1 202"));
                let exit_started = Instant::now();
                while exit_started.elapsed() < Duration::from_secs(5) {
                    if let Some(status) = child.0.try_wait().unwrap() {
                        assert!(status.success());
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                panic!("real C++ service did not exit after /shutdown");
            }
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("real C++ service exited before readiness: {status}");
            }
            thread::sleep(Duration::from_millis(100));
        }
        panic!("real C++ service did not become ready");
    }

    /// The managed PID cleanup path recognizes and terminates the real service
    /// command line without relying on a stale child handle.
    #[test]
    fn real_cpp_service_managed_cleanup_when_configured() {
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let Some(executable) = std::env::var_os("BAAS_CPP_SERVICE_PATH") else {
            return;
        };
        let executable =
            validate_cpp_service_executable(PathBuf::from(executable), "test").unwrap();
        let project_root = tempfile::tempdir().unwrap();
        prepare_real_cpp_service_project(project_root.path());
        let mut config = UpdaterConfig::default();
        config.paths.baas_root_path = project_root.path().to_string_lossy().into_owned();
        let port = available_backend_port().unwrap();
        let mut child = ChildGuard(
            Command::new(executable)
                .args([
                    "--project-root",
                    &project_root.path().to_string_lossy(),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let pid_file = backend_pid_path(&config);
        persist_managed_backend_pid(&pid_file, child.0.id(), &config).unwrap();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) && !cpp_backend_ready(port) {
            assert!(child.0.try_wait().unwrap().is_none());
            thread::sleep(Duration::from_millis(100));
        }
        assert!(cpp_backend_ready(port));

        stop_backend_pid_file(&pid_file).unwrap();
        assert!(!pid_file.exists());
        let stopped = Instant::now();
        while stopped.elapsed() < Duration::from_secs(5) {
            if child.0.try_wait().unwrap().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("managed PID cleanup did not terminate the real C++ service");
    }

    /// Structured identity preserves executable and project paths containing
    /// spaces and rejects a stale start identity for the same PID/path tuple.
    #[test]
    fn managed_identity_handles_spaces_and_rejects_stale_start() {
        let root = tempfile::tempdir().unwrap();
        let product_dir = root.path().join("BAAS Tauri Product");
        let project_root = root.path().join("Project Root With Spaces");
        fs::create_dir_all(&product_dir).unwrap();
        fs::create_dir_all(&project_root).unwrap();
        let executable = product_dir.join(cpp_service_executable_name());
        fs::write(&executable, b"service").unwrap();
        let executable = executable.canonicalize().unwrap();
        let project_root = project_root.canonicalize().unwrap();
        let args = vec![
            executable.to_string_lossy().into_owned(),
            "--project-root".to_string(),
            project_root.to_string_lossy().into_owned(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "8190".to_string(),
        ];
        let identity = BackendProcessIdentity {
            executable: executable.clone(),
            raw_command_line: args.join(" "),
            args,
            structured_args: true,
            start_identity: "start-1".to_string(),
        };
        let mut record = ManagedBackendPid {
            schema: MANAGED_BACKEND_PID_SCHEMA,
            pid: 42,
            executable,
            project_root,
            start_identity: "start-1".to_string(),
            kind: ManagedBackendKind::Cpp,
        };
        assert!(managed_backend_identity_matches(&record, &identity));
        record.start_identity = "start-2".to_string();
        assert!(!managed_backend_identity_matches(&record, &identity));
    }

    /// A stale PID record must fail closed and remain on disk for diagnosis;
    /// it must never report success or target the unrelated live process.
    #[test]
    fn stale_pid_identity_is_preserved_without_kill() {
        let root = tempfile::tempdir().unwrap();
        let pid_file = root.path().join("backend.pid");
        let current = backend_process_identity(std::process::id())
            .unwrap()
            .unwrap();
        let record = ManagedBackendPid {
            schema: MANAGED_BACKEND_PID_SCHEMA,
            pid: std::process::id(),
            executable: current.executable,
            project_root: root.path().canonicalize().unwrap(),
            start_identity: "definitely-not-this-process".to_string(),
            kind: ManagedBackendKind::Cpp,
        };
        fs::write(&pid_file, serde_json::to_vec(&record).unwrap()).unwrap();

        let error = stop_backend_pid_file(&pid_file).unwrap_err();
        assert!(error.contains("identity mismatch"));
        assert!(pid_file.exists());
    }

    /// Live legacy numeric records cannot authorize termination and remain
    /// present until an operator resolves them.
    #[test]
    fn live_legacy_pid_record_is_rejected_and_preserved() {
        let root = tempfile::tempdir().unwrap();
        let pid_file = root.path().join("backend.pid");
        fs::write(&pid_file, std::process::id().to_string()).unwrap();

        let error = stop_backend_pid_file(&pid_file).unwrap_err();
        assert!(error.contains("no strong identity"));
        assert!(pid_file.exists());
    }

    /// A truncated body is rejected even when its JSON prefix looks valid.
    #[test]
    fn rejects_truncated_cpp_backend_response() {
        let response =
            b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{\"ok\":true}"
                .to_vec();
        let (port, server) = serve_one_response(response);
        assert!(backend_http_json(port, "/health").is_none());
        server.join().unwrap();
    }

    /// Handles the detects existing non empty root workflow.
    #[test]
    fn detects_existing_non_empty_root() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!path_exists_non_empty(dir.path()));
        fs::write(dir.path().join("marker.txt"), "ok").unwrap();
        assert!(path_exists_non_empty(dir.path()));
    }

    /// Handles the mirrorc validation messages cover known codes workflow.
    #[test]
    fn mirrorc_validation_messages_cover_known_codes() {
        assert!(
            mirrorc_validation_message(0, "ok", Some("2026-06-11 12:00:00 +08:00"))
                .contains("Expires at")
        );
        assert_eq!(
            mirrorc_validation_message(7001, "The cdk has expired", None),
            "The cdk has expired"
        );
        assert!(mirrorc_validation_message(7002, "", None).contains("invalid"));
        assert!(mirrorc_validation_message(7003, "", None).contains("quota"));
        assert!(mirrorc_validation_message(7004, "", None).contains("mismatched"));
        assert!(mirrorc_validation_message(7005, "", None).contains("blocked"));
    }

    /// Returns the formats mirrorc expiry for frontend display result.
    #[test]
    fn formats_mirrorc_expiry_for_frontend_display() {
        assert!(format_mirrorc_expiry(Some(1_784_199_615)).is_some());
        assert_eq!(format_mirrorc_expiry(None), None);
    }

    /// Returns the parses non empty path only result.
    #[test]
    fn parses_non_empty_path_only() {
        assert_eq!(non_empty_path(""), None);
        assert_eq!(non_empty_path("   "), None);
        assert_eq!(non_empty_path("D:/BAAS"), Some(PathBuf::from("D:/BAAS")));
    }

    /// Runtime configuration accepts only the two explicit implementations.
    #[test]
    fn parses_backend_runtime_without_fallback_aliases() {
        assert_eq!(
            parse_backend_runtime(Some("python")).unwrap(),
            Some(BackendRuntime::Python)
        );
        assert_eq!(
            parse_backend_runtime(Some("cpp")).unwrap(),
            Some(BackendRuntime::Cpp)
        );
        assert_eq!(parse_backend_runtime(None).unwrap(), None);
        assert_eq!(
            parse_backend_runtime(Some("native")).unwrap_err(),
            "unsupported backend runtime: native"
        );
    }

    /// A failed switch restores the previous persisted runtime and transport.
    #[test]
    fn rollback_restores_previous_backend_selection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("setup.toml");
        let mut manager = ConfigManager::load_from(&path).unwrap();
        manager
            .update(|config| {
                config.general.backend_runtime = BackendRuntime::Cpp;
                config.general.transport = BackendTransport::Websocket;
            })
            .unwrap();

        let error = rollback_backend_selection(
            &mut manager,
            BackendRuntime::Python,
            BackendTransport::Pipe,
            "C++ startup failed".to_string(),
        );

        assert_eq!(error, "C++ startup failed");
        let restored = ConfigManager::load_from(path).unwrap().config.general;
        assert_eq!(restored.backend_runtime, BackendRuntime::Python);
        assert_eq!(restored.transport, BackendTransport::Pipe);
    }

    /// Managed backend identity accepts only exact names and launcher flags.
    #[test]
    fn recognizes_managed_backend_command_lines() {
        assert!(is_managed_backend_command_line(
            r#"C:\Python\python.exe D:\BAAS\main.service.py --host 127.0.0.1 --port 8190"#
        ));
        assert!(is_managed_backend_command_line(
            r#""C:\Program Files\BAAS\BAAS_service.exe" --project-root D:\BAAS --host 127.0.0.1 --port 8190"#
        ));
        assert!(is_managed_backend_command_line(
            "/opt/baas/BAAS_service --project-root /srv/baas --host 127.0.0.1 --port 8190"
        ));
    }

    /// Similar binaries and incomplete commands never pass stop identity.
    #[test]
    fn rejects_unmanaged_backend_command_lines() {
        assert!(!is_managed_backend_command_line(
            r#"D:\build\BAAS_service_owner_tests.exe --project-root D:\BAAS --host 127.0.0.1 --port 8190"#
        ));
        assert!(!is_managed_backend_command_line(
            r#"D:\tools\BAAS_service.exe --serve-unrelated-work"#
        ));
        assert!(!is_managed_backend_command_line(
            r#"python.exe D:\BAAS\main.service.py --run-one-test"#
        ));
        assert!(!is_managed_backend_command_line(
            r#"runner.exe --input D:\BAAS\main.service.py --host 127.0.0.1 --port 8190"#
        ));
    }

    /// Handles malformed setup.toml recovery for desktop startup.
    #[test]
    fn load_config_recovers_malformed_setup_toml() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("setup.toml");
        fs::write(&config_path, "[repositories]\nmain_sources = []\nies]\n").unwrap();

        let manager = load_config_recovering_invalid(config_path.clone()).unwrap();

        assert!(config_path.exists());
        assert_eq!(manager.config, UpdaterConfig::default());
        let backups = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("setup.toml.invalid-")
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
    }

    /// Returns the derives macos install root next to app bundle result.
    #[test]
    fn derives_macos_install_root_next_to_app_bundle() {
        let exe = Path::new("/Applications/Blue Archive Auto Script.app/Contents/MacOS/baas");
        assert_eq!(
            macos_app_adjacent_install_path_from_exe(exe),
            Some(PathBuf::from("/Applications/BAAS"))
        );

        assert_eq!(
            macos_app_adjacent_install_path_from_exe(Path::new("/tmp/baas")),
            None
        );
    }
}
