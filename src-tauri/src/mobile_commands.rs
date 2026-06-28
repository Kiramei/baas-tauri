#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const ANDROID_BACKEND_MESSAGE: &str =
    "Android embeds Python 3.9 through Chaquopy and does not use uv. The Android application layer starts a Python bootstrap which unpacks the bundled BAAS service backend into app-private storage and reports missing Android-compatible runtime dependencies through /health.";
const ANDROID_PACKAGE_NAME: &str = "io.github.kiramei.baas_tauri";
const ANDROID_STORAGE_ROOT_MARKER: &str = "baas-android-storage-root.txt";

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

#[tauri::command]
pub fn updater_path_exists_non_empty(_path: PathBuf) -> bool {
    false
}

#[tauri::command]
pub fn updater_get_storage_state(app: AppHandle) -> Result<StorageStartupState, String> {
    let storage_file_path = android_storage_root(&app)?.join(".app_storage.json");
    Ok(StorageStartupState {
        store_path: storage_file_path.clone(),
        storage_file_path,
        portable: false,
    })
}

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

#[tauri::command]
pub fn updater_validate_mirrorc_cdk(_request: MirrorCValidateRequest) -> Value {
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

#[tauri::command]
pub fn updater_start_workflow(_request: UpdaterWorkflowRequest) -> Result<Value, String> {
    Err(ANDROID_BACKEND_MESSAGE.to_string())
}

#[tauri::command]
pub fn updater_reset_backend_auth_and_restart() -> Result<Value, String> {
    Err(ANDROID_BACKEND_MESSAGE.to_string())
}

#[tauri::command]
pub fn updater_abort_workflow(_request: Option<WorkflowAbortRequest>) -> Value {
    json!({
        "aborted": false,
        "cleanupRequested": false,
        "message": ANDROID_BACKEND_MESSAGE
    })
}

#[tauri::command]
pub fn updater_terminal_snapshot() -> Value {
    json!({
        "sessionId": null,
        "running": false,
        "tasks": [],
        "logs": []
    })
}

#[tauri::command]
pub fn updater_resize_term(_rows: u16, _cols: u16) -> Result<(), String> {
    Ok(())
}

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

#[tauri::command]
pub fn open_main_devtools(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

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

fn mobile_config(root: &PathBuf) -> Value {
    mobile_config_with_request(root, None)
}

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
        .unwrap_or("auto");
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
            "backend_install_source": "bundled-baas-dev",
            "message": ANDROID_BACKEND_MESSAGE
        }
    })
}

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
    let git_backend = request.git_backend.as_deref().unwrap_or("auto");
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

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
