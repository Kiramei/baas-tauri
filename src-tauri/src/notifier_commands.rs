use crate::system_logs::system_log;
use baas_notifier::NotifyPayload;
use tauri::{AppHandle, Runtime};

/// Bridges frontend script lifecycle events to the shared native notification crate.
#[tauri::command]
pub fn baas_notify<R: Runtime>(app: AppHandle<R>, payload: NotifyPayload) -> Result<(), String> {
    system_log("DEBUG", "notification", "System notification requested");
    baas_notifier::show_notification(&app, payload).map_err(|error| error.to_string())
}
