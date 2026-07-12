use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[cfg(target_os = "android")]
const NOTIFICATION_CHANNEL_ID: &str = "baas_script_events";

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

    ensure_notification_channel(app).map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    {
        register_windows_identity(app)?;

        let mut notification = notify_rust::Notification::new();
        notification
            .summary(&payload.title)
            .body(&payload.body)
            .app_id(&app.config().identifier)
            .auto_icon();
        notification.show().map_err(|error| error.to_string())?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut builder = app
            .notification()
            .builder()
            .title(payload.title)
            .body(payload.body)
            .auto_cancel();

        #[cfg(target_os = "android")]
        {
            builder = builder.channel_id(NOTIFICATION_CHANNEL_ID);
        }

        if let Some(tag) = payload.tag.filter(|value| !value.trim().is_empty()) {
            builder = builder.group(tag);
        }

        builder.show().map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "windows")]
/// Registers the unpackaged development build so Windows attributes toasts to BAAS.
fn register_windows_identity<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let key_path = format!(
        r"SOFTWARE\Classes\AppUserModelId\{}",
        app.config().identifier
    );
    let key = windows_registry::CURRENT_USER
        .create(key_path)
        .map_err(|error| error.to_string())?;
    key.set_string("DisplayName", "Blue Archive Auto Script")
        .map_err(|error| error.to_string())?;
    key.set_string("IconBackgroundColor", "0")
        .map_err(|error| error.to_string())
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

#[cfg(target_os = "android")]
/// Creates the Android notification channel required before notifications can be posted.
fn ensure_notification_channel<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri_plugin_notification::Result<()> {
    use tauri_plugin_notification::{Channel, Importance, Visibility};

    app.notification().create_channel(
        Channel::builder(NOTIFICATION_CHANNEL_ID, "BAAS script events")
            .description("Script start, completion, and failure notifications")
            .importance(Importance::Default)
            .visibility(Visibility::Public)
            .build(),
    )
}

#[cfg(not(target_os = "android"))]
/// Skips channel setup on desktop platforms because the OS notification APIs do not need it.
fn ensure_notification_channel<R: Runtime>(
    _app: &AppHandle<R>,
) -> tauri_plugin_notification::Result<()> {
    Ok(())
}
