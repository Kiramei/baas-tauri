use crate::NotifyPayload;
use tauri::{AppHandle, Runtime};

pub(super) fn send_notification<R: Runtime>(
    app: &AppHandle<R>,
    payload: NotifyPayload,
) -> Result<(), String> {
    register_windows_identity(app)?;

    crate::windows_toast::show(
        &app.config().identifier,
        &payload.title,
        &payload.body,
        payload.tag.as_deref(),
    )
}

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
