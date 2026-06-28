#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const ANDROID_BACKEND_MESSAGE: &str =
    "Android embeds Python 3.9 through Chaquopy and does not use uv. The Android application layer starts a Python bootstrap which unpacks the bundled BAAS service backend into app-private storage and reports missing Android-compatible runtime dependencies through /health.";

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
    let storage_file_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(".app_storage.json");
    Ok(StorageStartupState {
        store_path: storage_file_path.clone(),
        storage_file_path,
        portable: false,
    })
}

#[tauri::command]
pub fn updater_get_startup_state(app: AppHandle) -> Result<Value, String> {
    let config_path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("setup.toml");
    Ok(json!({
        "configPath": config_path,
        "config": mobile_config(),
        "defaultInstallPath": "",
        "installPath": "",
        "portable": false,
        "baasRootExistsNonEmpty": false,
        "platformUnsupported": false,
        "message": ANDROID_BACKEND_MESSAGE
    }))
}

#[tauri::command]
pub fn updater_update_config(_request: UpdaterConfigUpdateRequest) -> Value {
    mobile_config()
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

fn mobile_config() -> Value {
    json!({
        "general": {
            "channel": "dev",
            "mirrorc_cdk": "",
            "no_update": true,
            "launch": false,
            "git_backend": "auto"
        },
        "paths": {
            "baas_root_path": ""
        },
        "python": {
            "runtime_path": "embedded-python-3.9"
        },
        "android": {
            "embedded_python": true,
            "uses_uv": false,
            "backend_install_source": "bundled-baas-dev",
            "message": ANDROID_BACKEND_MESSAGE
        }
    })
}
