use baas_shortcut::{
    apply_shortcut_bindings, ShortcutBindingRequest, ShortcutRegistrationReport, ShortcutRegistry,
};
use baas_term::types::SessionMetadata;
use baas_updater::{
    app::{TerminalSnapshot, UpdaterTermManager, WorkflowAbortReport, WorkflowAbortRequest},
    config::{exe_adjacent_config_path, ConfigManager, UpdaterConfig},
    environ::{backend_pid_path, launch_backend_command},
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
use tauri::{AppHandle, Manager, State};

const STORAGE_FILE_NAME: &str = ".app_storage.json";
const STORAGE_INSTALL_DIR_KEY: &str = "base_dir";

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterShaTestReport {
    pub success: bool,
    pub name: String,
    pub duration: f64,
    pub value: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn shortcut_apply_bindings(
    app: AppHandle,
    registry: State<'_, ShortcutRegistry>,
    bindings: Vec<ShortcutBindingRequest>,
) -> Result<ShortcutRegistrationReport, String> {
    apply_shortcut_bindings(app, &registry, bindings)
}

#[tauri::command]
pub fn open_main_devtools(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.open_devtools();
    Ok(())
}

/// Simple path probe used by the setup page to recover from older configs
/// where the install root was lost but the frontend still has a cached path.
#[tauri::command]
pub fn updater_path_exists_non_empty(path: PathBuf) -> bool {
    path_exists_non_empty(&path)
}

#[tauri::command]
pub fn updater_get_storage_state(app: AppHandle) -> Result<StorageStartupState, String> {
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
    pub fn remember_config(&self, config: &UpdaterConfig) -> Result<(), String> {
        self.remember_pid_file(backend_pid_path(config))
    }

    pub fn stop_for_config(&self, config: &UpdaterConfig) -> Result<(), String> {
        let pid_file = backend_pid_path(config);
        self.remember_pid_file(pid_file.clone())?;
        stop_backend_pid_file(&pid_file)
    }

    pub fn stop_all(&self) -> Result<(), String> {
        let pid_files = self
            .pid_files
            .lock()
            .map_err(|_| "backend pid-file lock poisoned")?
            .clone();
        for pid_file in pid_files {
            stop_backend_pid_file(&pid_file)?;
        }
        Ok(())
    }

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
    fn drop(&mut self) {
        let _ = self.stop_all();
    }
}

#[tauri::command]
pub fn updater_get_startup_state(app: AppHandle) -> Result<UpdaterStartupState, String> {
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

#[tauri::command]
pub fn updater_update_config(
    app: AppHandle,
    request: UpdaterConfigUpdateRequest,
) -> Result<UpdaterConfig, String> {
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
        })
        .map_err(|error| error.message())?;
    Ok(manager.config)
}

#[tauri::command]
pub fn updater_validate_mirrorc_cdk(
    app: AppHandle,
    request: MirrorCValidateRequest,
) -> Result<MirrorCValidateReport, String> {
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

#[tauri::command]
pub fn tauri_client_check_update(
    request: TauriClientUpdateRequest,
) -> Result<serde_json::Value, String> {
    let _ = request.current_version;
    Err("Desktop client updates are handled by tauri-plugin-updater.".to_string())
}

#[tauri::command]
pub fn updater_check_version(
    app: AppHandle,
    request: UpdaterVersionCheckRequest,
) -> Result<UpdaterVersionCheckReport, String> {
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

#[tauri::command]
pub fn updater_test_sha_methods(
    app: AppHandle,
    request: UpdaterShaTestRequest,
) -> Result<Vec<UpdaterShaTestReport>, String> {
    let manager = ensure_default_config(&app)?;
    let channel =
        parse_requested_channel(request.channel.as_deref(), manager.config.general.channel)?;
    let timeout = Duration::from_secs_f64(request.timeout.unwrap_or(15.0).clamp(1.0, 60.0));
    let branch = repository_branch(RepositoryKind::Main).map_err(|error| error.message())?;
    Ok(sha_method_sources(channel)
        .into_iter()
        .map(|(name, url)| {
            let start = Instant::now();
            match url {
                Some(url) => match git_ls_remote_with_timeout(&url, &branch, timeout) {
                    Ok(value) => UpdaterShaTestReport {
                        success: true,
                        name,
                        duration: start.elapsed().as_secs_f64(),
                        value: Some(value),
                        error: None,
                    },
                    Err(error) => UpdaterShaTestReport {
                        success: false,
                        name,
                        duration: start.elapsed().as_secs_f64(),
                        value: None,
                        error: Some(error),
                    },
                },
                None => UpdaterShaTestReport {
                    success: false,
                    name,
                    duration: start.elapsed().as_secs_f64(),
                    value: None,
                    error: Some("not a git source".to_string()),
                },
            }
        })
        .collect())
}

#[tauri::command]
pub fn updater_test_sha_method(
    app: AppHandle,
    request: UpdaterSingleShaTestRequest,
) -> Result<UpdaterShaTestReport, String> {
    let manager = ensure_default_config(&app)?;
    let channel =
        parse_requested_channel(request.channel.as_deref(), manager.config.general.channel)?;
    let timeout = Duration::from_secs_f64(request.timeout.unwrap_or(15.0).clamp(1.0, 60.0));
    let branch = repository_branch(RepositoryKind::Main).map_err(|error| error.message())?;
    let start = Instant::now();
    let name = request.method.trim().to_string();
    let url = sha_method_sources(channel)
        .into_iter()
        .find(|(method, _)| method == &name)
        .and_then(|(_, url)| url);
    Ok(match url {
        Some(url) => match git_ls_remote_with_timeout(&url, &branch, timeout) {
            Ok(value) => UpdaterShaTestReport {
                success: true,
                name,
                duration: start.elapsed().as_secs_f64(),
                value: Some(value),
                error: None,
            },
            Err(error) => UpdaterShaTestReport {
                success: false,
                name,
                duration: start.elapsed().as_secs_f64(),
                value: None,
                error: Some(error),
            },
        },
        None => UpdaterShaTestReport {
            success: false,
            name,
            duration: start.elapsed().as_secs_f64(),
            value: None,
            error: Some("not a git source".to_string()),
        },
    })
}

#[tauri::command]
pub fn updater_start_workflow(
    app: AppHandle,
    request: UpdaterWorkflowRequest,
    manager: State<'_, UpdaterTermManager>,
    backend: State<'_, BackendProcessManager>,
) -> Result<SessionMetadata, String> {
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

#[tauri::command]
pub fn updater_reset_backend_auth_and_restart(
    app: AppHandle,
    backend: State<'_, BackendProcessManager>,
) -> Result<BackendReadyPayload, String> {
    let manager = ensure_default_config(&app)?;
    backend.stop_for_config(&manager.config)?;
    thread::sleep(Duration::from_millis(300));
    delete_backend_auth_files(&manager.config)?;

    let port = available_backend_port()?;
    start_backend_detached(&manager.config, port)?;
    backend.remember_config(&manager.config)?;
    wait_for_backend_auth_endpoint(port)?;

    Ok(BackendReadyPayload {
        base_backend_addr: "127.0.0.1".to_string(),
        base_backend_port: port,
    })
}

#[tauri::command]
pub fn updater_abort_workflow(
    request: Option<WorkflowAbortRequest>,
    manager: State<'_, UpdaterTermManager>,
) -> Result<WorkflowAbortReport, String> {
    manager.abort(request.unwrap_or_default())
}

#[tauri::command]
pub fn updater_terminal_snapshot(
    manager: State<'_, UpdaterTermManager>,
) -> Result<TerminalSnapshot, String> {
    manager.snapshot()
}

#[tauri::command]
pub fn updater_resize_term(
    manager: State<'_, UpdaterTermManager>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    manager.resize(rows, cols)
}

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

fn normalized_sha_method(value: &str) -> String {
    match value.trim() {
        "" | "git2" | "git_cli" | "auto" => "github".to_string(),
        other => other.to_string(),
    }
}

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

fn find_url(urls: &[String], needle: &str) -> Option<String> {
    urls.iter().find(|url| url.contains(needle)).cloned()
}

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

fn configure_git_environment(command: &mut Command) {
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GCM_MODAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "");
}

#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
fn hide_command_window(_command: &mut Command) {}

/// Returns the active setup.toml manager without using app-data setup storage.
pub fn ensure_default_config(app: &AppHandle) -> Result<ConfigManager, String> {
    let portable = is_portable_install();
    let default_install_path = default_install_path();
    let install_path = startup_install_path(app, portable, &default_install_path)?;
    config_manager_for_install_path(&install_path, portable)
}

fn ensure_config_for_install_path(
    app: &AppHandle,
    install_path: Option<&Path>,
) -> Result<ConfigManager, String> {
    let portable = is_portable_install();
    if portable {
        let mut manager =
            ConfigManager::load_from(portable_config_path()?).map_err(|error| error.message())?;
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

fn config_manager_for_install_path(
    install_path: &Path,
    portable: bool,
) -> Result<ConfigManager, String> {
    if portable {
        let mut manager =
            ConfigManager::load_from(portable_config_path()?).map_err(|error| error.message())?;
        normalize_portable_config(&mut manager)?;
        return Ok(manager);
    }

    let config_path = install_path.join("setup.toml");
    let mut manager = ConfigManager::load_from(config_path).map_err(|error| error.message())?;
    manager.config.paths.baas_root_path = install_path.to_string_lossy().to_string();
    Ok(manager)
}

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

pub fn configure_portable_working_dir() -> Result<(), String> {
    if !is_portable_install() {
        return Ok(());
    }
    let Some(dir) = current_exe_dir() else {
        return Ok(());
    };
    std::env::set_current_dir(&dir).map_err(|error| error.to_string())
}

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

fn persisted_baas_root_path(path: &Path, portable: bool) -> String {
    if portable {
        ".".to_string()
    } else {
        path.to_string_lossy().to_string()
    }
}

fn is_portable_install() -> bool {
    exe_adjacent_config_path()
        .map(|path| path.exists())
        .unwrap_or(false)
}

fn portable_config_path() -> Result<PathBuf, String> {
    exe_adjacent_config_path().map_err(|error| error.message())
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

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

fn path_exists_non_empty(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.is_dir()
        && fs::read_dir(path)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false)
}

fn non_empty_path(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

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

fn available_backend_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|error| error.to_string())
}

fn start_backend_detached(config: &UpdaterConfig, port: u16) -> Result<(), String> {
    let command = launch_backend_command(config, port);
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
    let child = process.spawn().map_err(|error| error.to_string())?;
    let pid_file = command
        .detached_pid_file
        .clone()
        .unwrap_or_else(|| backend_pid_path(config));
    if let Some(parent) = pid_file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&pid_file, child.id().to_string()).map_err(|error| error.to_string())?;
    Ok(())
}

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

fn stop_backend_pid_file(pid_file: &Path) -> Result<(), String> {
    let Some(pid) = read_backend_pid(pid_file)? else {
        return Ok(());
    };
    kill_backend_pid(pid)?;
    let _ = fs::remove_file(pid_file);
    Ok(())
}

fn read_backend_pid(pid_file: &Path) -> Result<Option<u32>, String> {
    if !pid_file.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(pid_file).map_err(|error| error.to_string())?;
    let Some(first) = text.split_whitespace().next() else {
        let _ = fs::remove_file(pid_file);
        return Ok(None);
    };
    match first.parse::<u32>() {
        Ok(pid) if pid > 0 => Ok(Some(pid)),
        _ => {
            let _ = fs::remove_file(pid_file);
            Ok(None)
        }
    }
}

#[cfg(target_os = "windows")]
fn kill_backend_pid(pid: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let script = format!(
        "$targetPid = {pid}; \
         $process = Get-CimInstance Win32_Process -Filter \"ProcessId = $targetPid\" -ErrorAction SilentlyContinue; \
         if ($null -ne $process -and $process.CommandLine -like '*main.service.py*') {{ \
             taskkill.exe /PID $targetPid /T /F | Out-Null \
         }}; exit 0"
    );
    Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000000)
        .status()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn kill_backend_pid(pid: u32) -> Result<(), String> {
    let script = format!(
        "if ps -p {pid} -o command= | grep -F 'main.service.py' >/dev/null 2>&1; then \
             kill -TERM {pid} >/dev/null 2>&1 || true; \
             sleep 1; \
             kill -KILL {pid} >/dev/null 2>&1 || true; \
         fi"
    );
    Command::new("sh")
        .args(["-lc", &script])
        .status()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn format_mirrorc_expiry(expires_at: Option<u64>) -> Option<String> {
    let timestamp = i64::try_from(expires_at?).ok()?;
    DateTime::<Utc>::from_timestamp(timestamp, 0).map(|datetime| {
        datetime
            .with_timezone(&Local)
            .format("%Y-%m-%d %H:%M:%S %:z")
            .to_string()
    })
}

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

    #[test]
    fn detects_existing_non_empty_root() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!path_exists_non_empty(dir.path()));
        fs::write(dir.path().join("marker.txt"), "ok").unwrap();
        assert!(path_exists_non_empty(dir.path()));
    }

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

    #[test]
    fn formats_mirrorc_expiry_for_frontend_display() {
        assert!(format_mirrorc_expiry(Some(1_784_199_615)).is_some());
        assert_eq!(format_mirrorc_expiry(None), None);
    }

    #[test]
    fn parses_non_empty_path_only() {
        assert_eq!(non_empty_path(""), None);
        assert_eq!(non_empty_path("   "), None);
        assert_eq!(non_empty_path("D:/BAAS"), Some(PathBuf::from("D:/BAAS")));
    }

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
