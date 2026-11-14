use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[cfg(target_os = "android")]
#[path = "platform/android.rs"]
mod android;

#[cfg(windows)]
#[path = "platform/windows.rs"]
mod windows;
#[cfg(windows)]
use windows::send_notification;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPayload {
    pub title: String,
    pub body: String,
    pub tag: Option<String>,
}

/// Registers the native notification plugin used by BAAS desktop and Android builds.
pub fn init_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_notification::init()
}

/// Shows a native notification after ensuring platform permission and Android channel setup.
pub fn show_notification<R: Runtime>(
    app: &AppHandle<R>,
    payload: NotifyPayload,
) -> Result<(), String> {
    if !ensure_notification_permission(app).map_err(|error| error.to_string())? {
        return Ok(());
    }

    send_notification(app, payload)
}

#[cfg(not(windows))]
fn send_notification<R: Runtime>(app: &AppHandle<R>, payload: NotifyPayload) -> Result<(), String> {
    #[cfg(target_os = "android")]
    let builder = android::channel_builder(app).map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "android"))]
    let builder = app.notification().builder();

    let mut builder = builder
        .title(payload.title)
        .body(payload.body)
        .auto_cancel();
    if let Some(tag) = payload.tag.filter(|value| !value.trim().is_empty()) {
        builder = builder.group(tag);
    }
    builder.show().map_err(|error| error.to_string())
}

/// Requests notification permission when the platform requires it and reports whether sending is allowed.
fn ensure_notification_permission<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri_plugin_notification::Result<bool> {
    match app.notification().permission_state()? {
        PermissionState::Granted => Ok(true),
        PermissionState::Prompt | PermissionState::PromptWithRationale => Ok(matches!(
            app.notification().request_permission()?,
            PermissionState::Granted
        )),
        PermissionState::Denied => Ok(false),
    }
}
