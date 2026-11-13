use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::{
    Channel, Importance, NotificationBuilder, NotificationExt, Visibility,
};

const NOTIFICATION_CHANNEL_ID: &str = "baas_script_events";

pub(super) fn channel_builder<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri_plugin_notification::Result<NotificationBuilder<R>> {
    let notification = app.notification();
    notification.create_channel(
        Channel::builder(NOTIFICATION_CHANNEL_ID, "BAAS script events")
            .description("Script start, completion, and failure notifications")
            .importance(Importance::Default)
            .visibility(Visibility::Public)
            .build(),
    )?;
    Ok(notification.builder().channel_id(NOTIFICATION_CHANNEL_ID))
}
