use baas_updater::{
    android::{
        android_repository_local_sha, android_repository_remote_sha, AndroidTerminalSnapshot,
        AndroidUpdaterTermManager, AndroidWorkflowAbortReport, AndroidWorkflowAbortRequest,
    },
    repo::repository_urls,
    RepositoryKind, UpdateChannel, WorkflowOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tokio::{task::JoinSet, time};

const ANDROID_BACKEND_MESSAGE: &str =
    "Android embeds Python 3.9 through Chaquopy and does not use uv. The Android application layer starts a Python bootstrap which unpacks the bundled BAAS service backend into app-private storage and reports missing Android-compatible runtime dependencies through /health.";
const ANDROID_PACKAGE_NAME: &str = "io.github.kiramei.baas_tauri";
const ANDROID_STORAGE_ROOT_MARKER: &str = "baas-android-storage-root.txt";
const SHA_TEST_TIMEOUT_SECONDS: f64 = 10.0;
const TAURI_UPDATE_ENDPOINTS: &[&str] = &[
    "https://cnb.cool/kiramei/baas-tauri/-/releases/download/updater/update-cnb.json",
    "https://baas-cdn.kiramei.workers.dev/https://github.com/Kiramei/baas-tauri/releases/download/updater/update-proxy.json",
    "https://gh-proxy.org/https://github.com/Kiramei/baas-tauri/releases/download/updater/update-proxy.json",
    "https://github.com/Kiramei/baas-tauri/releases/download/updater/update.json",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStartupState {
    pub store_path: PathBuf,
    pub storage_file_path: PathBuf,
    pub portable: bool,
}

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorCValidateRequest {
    pub cdk: String,
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterWorkflowRequest {
    pub install_path: Option<PathBuf>,
    pub launch: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterVersionCheckRequest {
    pub channel: Option<String>,
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
pub struct WorkflowAbortRequest {
    pub cleanup: Option<bool>,
    pub emit_events: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBindingRequest {
    pub id: String,
    pub config_id: String,
    pub accelerator: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutRejectedBinding {
    pub id: String,
    pub config_id: String,
    pub accelerator: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutRegistrationReport {
    pub registered: Vec<Value>,
    pub rejected: Vec<ShortcutRejectedBinding>,
}

/// Performs the updater path exists non empty operation.
#[tauri::command]
pub fn updater_path_exists_non_empty(_path: PathBuf) -> bool {
    false
}

/// Performs the updater get storage state operation.
#[tauri::command]
pub fn updater_get_storage_state(app: AppHandle) -> Result<StorageStartupState, String> {
    let storage_file_path = android_storage_root(&app)?.join(".app_storage.json");
    Ok(StorageStartupState {
        store_path: storage_file_path.clone(),
        storage_file_path,
        portable: false,
    })
}

/// Performs the updater get startup state operation.
#[tauri::command]
pub fn updater_get_startup_state(app: AppHandle) -> Result<Value, String> {
    let root = android_storage_root(&app)?;
    let config_path = root.join("setup.toml");
    Ok(json!({
        "configPath": config_path,
        "config": mobile_config(&root),
        "defaultInstallPath": "",
        "installPath": root,
        "portable": true,
        "baasRootExistsNonEmpty": root.join("main.service.py").exists(),
        "platformUnsupported": false,
        "message": ANDROID_BACKEND_MESSAGE
    }))
}

/// Performs the updater update config operation.
#[tauri::command]
pub fn updater_update_config(
    app: AppHandle,
    request: UpdaterConfigUpdateRequest,
) -> Result<Value, String> {
    let root = android_storage_root(&app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let setup_path = root.join("setup.toml");
    let config = mobile_config_with_request(&root, Some(&request));
    let current_sha = read_setup_value(&setup_path, "current_baas_sha").unwrap_or_default();
    let current_cpp_sha = read_setup_value(&setup_path, "current_baas_cpp_sha").unwrap_or_default();
    let remote_sha_method =
        read_setup_value(&setup_path, "get_remote_sha_method").unwrap_or_default();
    fs::write(
        setup_path,
        mobile_setup_toml(
            &root,
            &request,
            &current_sha,
            &current_cpp_sha,
            &remote_sha_method,
        ),
    )
    .map_err(|error| error.to_string())?;
    Ok(config)
}

/// Performs the updater validate mirrorc cdk operation.
#[tauri::command]
pub fn updater_validate_mirrorc_cdk(request: MirrorCValidateRequest) -> Value {
    let _requested_cdk = request.cdk.trim();
    let _requested_channel = request.channel.as_deref().unwrap_or_default();
    json!({
        "success": false,
        "code": null,
        "message": ANDROID_BACKEND_MESSAGE,
        "mirrorcMessage": null,
        "latestVersion": null,
        "expiresAt": null,
        "expiresAtIso": null
    })
}

/// Handles the tauri client check update workflow.
#[tauri::command]
pub fn tauri_client_check_update(request: TauriClientUpdateRequest) -> Result<Value, String> {
    let current_version = request
        .current_version
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let mut last_error = None;
    for endpoint in TAURI_UPDATE_ENDPOINTS {
        match fetch_android_update_metadata(endpoint) {
            Ok(update) => {
                let remote_version = normalize_version(
                    update
                        .get("version")
                        .or_else(|| update.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
                .unwrap_or_else(|| "0.0.0".to_string());
                let platform = android_update_platform(&update);
                let update_url = platform
                    .and_then(|value| value.get("url"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let update_available = update_url.is_some()
                    && compare_versions(&remote_version, &current_version).is_gt();
                return Ok(json!({
                    "updateAvailable": update_available,
                    "checking": false,
                    "currentVersion": current_version,
                    "version": remote_version,
                    "body": update.get("notes").or_else(|| update.get("body")).and_then(Value::as_str).unwrap_or_default(),
                    "date": update.get("pub_date").or_else(|| update.get("date")).and_then(Value::as_str).unwrap_or_default(),
                    "url": update_url,
                    "endpoint": endpoint,
                    "androidPackageAvailable": update_url.is_some(),
                    "lastChecked": current_time_millis(),
                    "error": null
                }));
            }
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    Err(last_error.unwrap_or_else(|| "failed to fetch updater metadata".to_string()))
}

/// Handles the fetch android update metadata workflow.
fn fetch_android_update_metadata(endpoint: &str) -> Result<Value, String> {
    let response = minreq::get(endpoint)
        .with_header("cache-control", "no-cache")
        .with_header("accept", "application/json")
        .with_timeout(15)
        .send()
        .map_err(|error| error.to_string())?;
    if !(200..300).contains(&response.status_code) {
        return Err(format!(
            "{} returned HTTP {} {}",
            endpoint, response.status_code, response.reason_phrase
        ));
    }
    serde_json::from_str(response.as_str().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

/// Performs the updater check version operation.
#[tauri::command]
pub fn updater_check_version(
    app: AppHandle,
    request: UpdaterVersionCheckRequest,
) -> Result<Value, String> {
    let root = android_storage_root(&app)?;
    let setup_path = ensure_android_setup_toml(&root)?;
    let channel = android_requested_channel(request.channel.as_deref(), &setup_path)?;
    let local = read_setup_value(&setup_path, "current_baas_sha")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| android_repository_local_sha(&root, RepositoryKind::Main).ok());
    let preferred_method = normalize_android_sha_method(
        &read_setup_value(&setup_path, "get_remote_sha_method").unwrap_or_default(),
    );
    let (method, remote) = android_first_remote_sha(&root, channel, &preferred_method)?;
    Ok(json!({
        "local": local,
        "remote": remote,
        "updateAvailable": local.as_deref() != Some(remote.as_str()),
        "channel": channel.as_str(),
        "method": method
    }))
}

/// Verifies the updater test sha methods behavior.
#[tauri::command]
pub async fn updater_test_sha_methods(
    app: AppHandle,
    request: UpdaterShaTestRequest,
) -> Result<Value, String> {
    let root = android_storage_root(&app)?;
    let setup_path = ensure_android_setup_toml(&root)?;
    let channel = android_requested_channel(request.channel.as_deref(), &setup_path)?;
    let timeout = sha_test_timeout(request.timeout);
    let mut tasks = JoinSet::new();
    for (name, url) in android_sha_method_sources(channel) {
        let root = root.clone();
        tasks.spawn(run_android_sha_probe(root, channel, name, url, timeout));
    }

    let mut results = Vec::new();
    while let Some(result) = tasks.join_next().await {
        results.push(result.map_err(|error| error.to_string())?);
    }
    Ok(json!(results))
}

/// Verifies the updater test sha method behavior.
#[tauri::command]
pub async fn updater_test_sha_method(
    app: AppHandle,
    request: UpdaterSingleShaTestRequest,
) -> Result<Value, String> {
    let root = android_storage_root(&app)?;
    let setup_path = ensure_android_setup_toml(&root)?;
    let channel = android_requested_channel(request.channel.as_deref(), &setup_path)?;
    let timeout = sha_test_timeout(request.timeout);
    let name = request.method.trim().to_string();
    let url = android_sha_method_sources(channel)
        .into_iter()
        .find(|(method, _)| method == &name)
        .and_then(|(_, url)| url);
    Ok(run_android_sha_probe(root, channel, name, url, timeout).await)
}

/// Performs the updater start workflow operation.
#[tauri::command]
pub fn updater_start_workflow(
    app: AppHandle,
    request: UpdaterWorkflowRequest,
    manager: State<'_, AndroidUpdaterTermManager>,
) -> Result<Value, String> {
    let root = android_storage_root(&app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let setup_path = ensure_android_setup_toml(&root)?;
    let install_path = request
        .install_path
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(root);
    let session = manager.start(
        app,
        WorkflowOptions {
            config_path: Some(setup_path),
            install_path: Some(install_path),
            launch: request.launch.unwrap_or(false),
        },
    )?;
    serde_json::to_value(session).map_err(|error| error.to_string())
}

/// Performs the updater reset backend auth and restart operation.
#[tauri::command]
pub fn updater_reset_backend_auth_and_restart() -> Result<Value, String> {
    Err(ANDROID_BACKEND_MESSAGE.to_string())
}

/// Performs the updater abort workflow operation.
#[tauri::command]
pub fn updater_abort_workflow(
    request: Option<WorkflowAbortRequest>,
    manager: State<'_, AndroidUpdaterTermManager>,
) -> Result<AndroidWorkflowAbortReport, String> {
    let _cleanup_requested = request.as_ref().and_then(|request| request.cleanup);
    manager.abort(AndroidWorkflowAbortRequest {
        emit_events: request
            .and_then(|request| request.emit_events)
            .unwrap_or(true),
    })
}

/// Performs the updater terminal snapshot operation.
#[tauri::command]
pub fn updater_terminal_snapshot(
    manager: State<'_, AndroidUpdaterTermManager>,
) -> Result<AndroidTerminalSnapshot, String> {
    manager.snapshot()
}

/// Performs the updater resize term operation.
#[tauri::command]
pub fn updater_resize_term(
    manager: State<'_, AndroidUpdaterTermManager>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    manager.resize(rows, cols)
}

/// Handles the shortcut apply bindings workflow.
#[tauri::command]
pub fn shortcut_apply_bindings(
    bindings: Vec<ShortcutBindingRequest>,
) -> ShortcutRegistrationReport {
    ShortcutRegistrationReport {
        registered: Vec::new(),
        rejected: bindings
            .into_iter()
            .filter(|binding| binding.enabled)
            .map(|binding| ShortcutRejectedBinding {
                id: binding.id,
                config_id: binding.config_id,
                accelerator: binding.accelerator,
                reason: "Global shortcuts are not supported on Android.".to_string(),
            })
            .collect(),
    }
}

/// Performs the open main devtools operation.
#[tauri::command]
pub fn open_main_devtools(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

/// Handles the android requested channel workflow.
fn android_requested_channel(
    requested: Option<&str>,
    setup_path: &Path,
) -> Result<UpdateChannel, String> {
    let value = requested
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| read_setup_value(setup_path, "channel"))
        .unwrap_or_else(|| "dev".to_string());
    UpdateChannel::parse(&value).map_err(|error| error.message())
}

/// Returns the normalize android sha method result.
fn normalize_android_sha_method(value: &str) -> String {
    match value.trim() {
        "" | "git2" | "git_cli" | "auto" => "github".to_string(),
        other => other.to_string(),
    }
}

/// Handles the android first remote sha workflow.
fn android_first_remote_sha(
    root: &Path,
    channel: UpdateChannel,
    preferred_method: &str,
) -> Result<(String, String), String> {
    let methods = android_sha_method_sources(channel);
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
        match android_repository_remote_sha(root, RepositoryKind::Main, channel, url) {
            Ok(sha) => return Ok((method, sha)),
            Err(error) => last_error = Some(error.message()),
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

/// Performs the run android sha probe operation.
async fn run_android_sha_probe(
    root: PathBuf,
    channel: UpdateChannel,
    name: String,
    url: Option<String>,
    timeout: Duration,
) -> Value {
    let start = Instant::now();
    let worker_name = name.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || match url {
        Some(url) => {
            match android_repository_remote_sha(&root, RepositoryKind::Main, channel, &url) {
                Ok(value) => json!({
                    "success": true,
                    "name": worker_name,
                    "duration": start.elapsed().as_secs_f64(),
                    "value": value,
                    "error": null
                }),
                Err(error) => json!({
                    "success": false,
                    "name": worker_name,
                    "duration": start.elapsed().as_secs_f64(),
                    "value": null,
                    "error": error.message()
                }),
            }
        }
        None => json!({
            "success": false,
            "name": worker_name,
            "duration": start.elapsed().as_secs_f64(),
            "value": null,
            "error": "not a git source"
        }),
    });

    match time::timeout(timeout, worker).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => json!({
            "success": false,
            "name": name,
            "duration": start.elapsed().as_secs_f64(),
            "value": null,
            "error": error.to_string()
        }),
        Err(_) => json!({
            "success": false,
            "name": name,
            "duration": timeout.as_secs_f64(),
            "value": null,
            "error": format!("remote SHA probe timed out after {:.1}s", timeout.as_secs_f64())
        }),
    }
}

/// Handles the android sha method sources workflow.
fn android_sha_method_sources(channel: UpdateChannel) -> Vec<(String, Option<String>)> {
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

/// Handles the android storage root workflow.
fn android_storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let marker_path = app_data_dir.join("files").join(ANDROID_STORAGE_ROOT_MARKER);
    if let Ok(value) = fs::read_to_string(&marker_path) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    Ok(PathBuf::from(format!(
        "/storage/emulated/0/Android/data/{ANDROID_PACKAGE_NAME}"
    )))
}

/// Handles the android update platform workflow.
fn android_update_platform(update: &Value) -> Option<&Value> {
    let platforms = update.get("platforms")?.as_object()?;
    let arch = match std::env::consts::ARCH {
        "aarch64" => "android-arm64-v8a",
        "arm" | "armv7" => "android-armeabi-v7a",
        "x86_64" => "android-x86_64",
        "x86" => "android-x86",
        _ => "android",
    };
    platforms
        .get(arch)
        .or_else(|| platforms.get("android"))
        .or_else(|| {
            platforms
                .iter()
                .find(|(key, _)| key.to_ascii_lowercase().starts_with("android"))
                .map(|(_, value)| value)
        })
}

/// Returns the normalize version result.
fn normalize_version(value: &str) -> Option<String> {
    let mut started = false;
    let mut output = String::new();
    for ch in value.chars() {
        if ch.is_ascii_digit() || (started && ch == '.') {
            started = true;
            output.push(ch);
        } else if started {
            break;
        }
    }
    if output.is_empty() {
        None
    } else {
        Some(output.trim_matches('.').to_string())
    }
}

/// Handles the compare versions workflow.
fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |value: &str| {
        normalize_version(value)
            .unwrap_or_default()
            .split('.')
            .filter_map(|part| part.parse::<u64>().ok())
            .collect::<Vec<_>>()
    };
    let left = parse(left);
    let right = parse(right);
    let len = left.len().max(right.len()).max(3);
    for index in 0..len {
        let order = left
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right.get(index).copied().unwrap_or(0));
        if !order.is_eq() {
            return order;
        }
    }
    std::cmp::Ordering::Equal
}

/// Handles the current time millis workflow.
fn current_time_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

/// Handles the mobile config workflow.
fn mobile_config(root: &PathBuf) -> Value {
    mobile_config_with_request(root, None)
}

/// Handles the mobile config with request workflow.
fn mobile_config_with_request(
    root: &PathBuf,
    request: Option<&UpdaterConfigUpdateRequest>,
) -> Value {
    let channel = request
        .and_then(|request| request.channel.as_deref())
        .unwrap_or("dev");
    let mirrorc_cdk = request
        .and_then(|request| request.mirrorc_cdk.as_deref())
        .unwrap_or("");
    let no_update = request
        .and_then(|request| request.no_update)
        .unwrap_or(false);
    let git_backend = request
        .and_then(|request| request.git_backend.as_deref())
        .unwrap_or("git2");
    let runtime_path = request
        .and_then(|request| request.runtime_path.as_deref())
        .unwrap_or("embedded-python-3.9");

    json!({
        "general": {
            "channel": channel,
            "mirrorc_cdk": mirrorc_cdk,
            "no_update": no_update,
            "launch": false,
            "git_backend": git_backend,
            "current_baas_sha": ""
        },
        "paths": {
            "baas_root_path": root
        },
        "python": {
            "runtime_path": runtime_path
        },
        "android": {
            "embedded_python": true,
            "uses_uv": false,
            "backend_install_source": "git2",
            "message": ANDROID_BACKEND_MESSAGE
        }
    })
}

/// Handles the mobile setup toml workflow.
fn mobile_setup_toml(
    root: &Path,
    request: &UpdaterConfigUpdateRequest,
    current_sha: &str,
    current_cpp_sha: &str,
    remote_sha_method: &str,
) -> String {
    let channel = request.channel.as_deref().unwrap_or("dev");
    let mirrorc_cdk = request.mirrorc_cdk.as_deref().unwrap_or("");
    let no_update = request.no_update.unwrap_or(false);
    let git_backend = request.git_backend.as_deref().unwrap_or("git2");
    let runtime_path = request
        .runtime_path
        .as_deref()
        .unwrap_or("embedded-python-3.9");
    let baas_root = request
        .baas_root_path
        .as_deref()
        .unwrap_or(root)
        .to_string_lossy();

    format!(
        "schema_version = 1\n\n\
         [general]\n\
         mirrorc_cdk = \"{}\"\n\
         channel = \"{}\"\n\
         current_baas_sha = \"{}\"\n\
         current_baas_cpp_sha = \"{}\"\n\
         get_remote_sha_method = \"{}\"\n\
         launch = false\n\
         force_launch = false\n\
         debug = false\n\
         no_update = {}\n\
         git_backend = \"{}\"\n\
         source_list = []\n\n\
         [paths]\n\
         baas_root_path = \"{}\"\n\
         tmp_path = \"tmp\"\n\
         toolkit_path = \"toolkit\"\n\n\
         [python]\n\
         runtime_path = \"{}\"\n\
         python_version = \"3.9.0\"\n\n\
         [repositories]\n\
         main_sources = []\n\
         cpp_sources = []\n",
        escape_toml_string(mirrorc_cdk),
        escape_toml_string(channel),
        escape_toml_string(current_sha),
        escape_toml_string(current_cpp_sha),
        escape_toml_string(remote_sha_method),
        no_update,
        escape_toml_string(git_backend),
        escape_toml_string(&baas_root),
        escape_toml_string(runtime_path),
    )
}

/// Performs the ensure android setup toml operation.
fn ensure_android_setup_toml(root: &Path) -> Result<PathBuf, String> {
    let setup_path = root.join("setup.toml");
    if setup_path.exists() {
        return Ok(setup_path);
    }
    let request = UpdaterConfigUpdateRequest {
        baas_root_path: Some(root.to_path_buf()),
        mirrorc_cdk: None,
        channel: Some("dev".to_string()),
        runtime_path: Some("embedded-python-3.9".to_string()),
        no_update: Some(false),
        git_backend: Some("git2".to_string()),
    };
    fs::write(
        &setup_path,
        mobile_setup_toml(&root, &request, "", "", "github"),
    )
    .map_err(|error| error.to_string())?;
    Ok(setup_path)
}

/// Returns the read setup value result.
fn read_setup_value(path: &Path, key: &str) -> Option<String> {
    let prefix = format!("{key} = ");
    let content = fs::read_to_string(path).ok()?;
    content.lines().find_map(|line| {
        let value = line.trim().strip_prefix(&prefix)?.trim();
        value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .map(|value| value.replace("\\\"", "\"").replace("\\\\", "\\"))
    })
}

/// Handles the escape toml string workflow.
fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
