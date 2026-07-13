use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidBackendServiceInfo {
    pub pipe_path: String,
}

struct AndroidBackendService<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-backend-service")
        .setup(|app, api| {
            let handle = api
                .register_android_plugin("io.github.kiramei.baas_tauri", "BackendServicePlugin")?;
            app.manage(AndroidBackendService(handle));
            Ok(())
        })
        .build()
}

pub fn ensure_started<R: Runtime>(app: &AppHandle<R>) -> Result<AndroidBackendServiceInfo, String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin("ensureStarted", ())
        .map_err(|error| format!("failed to start Android backend service: {error}"))
}
