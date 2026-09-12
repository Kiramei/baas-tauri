use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidBackendServiceInfo {
    pub pipe_path: String,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidGameInfo {
    pub package_name: String,
    pub label: String,
    pub icon_png_base64: String,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidGameList {
    pub games: Vec<AndroidGameInfo>,
    pub shizuku_installed: bool,
    pub shizuku_running: bool,
    pub shizuku_granted: bool,
    pub shizuku_uid: Option<i32>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidGameScreenshot {
    pub png_base64: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageRequest<'a> {
    package_name: &'a str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GestureRequest<'a> {
    package_name: &'a str,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    duration_ms: u64,
}

#[derive(serde::Serialize)]
struct InstallPackageRequest<'a> {
    path: &'a str,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidShizukuState {
    pub shizuku_installed: bool,
    pub shizuku_running: bool,
    pub shizuku_granted: bool,
    pub shizuku_uid: Option<i32>,
    pub shizuku_display_id: i32,
}

#[derive(serde::Serialize)]
struct ShizukuShellRequest<'a> {
    command: &'a str,
}

#[derive(serde::Deserialize)]
struct ShizukuShellResult {
    output: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShizukuDisplayRequest {
    width: u32,
    height: u32,
    density: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShizukuDisplayResult {
    display_id: i32,
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

pub fn list_games<R: Runtime>(app: &AppHandle<R>) -> Result<AndroidGameList, String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin("listGames", ())
        .map_err(|error| format!("failed to list installed Android games: {error}"))
}

pub fn launch_game<R: Runtime>(app: &AppHandle<R>, package_name: &str) -> Result<(), String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin("launchGame", PackageRequest { package_name })
        .map_err(|error| format!("failed to launch Android game: {error}"))
}

pub fn game_screenshot<R: Runtime>(
    app: &AppHandle<R>,
    package_name: &str,
) -> Result<AndroidGameScreenshot, String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin("gameScreenshot", PackageRequest { package_name })
        .map_err(|error| format!("failed to capture Android game: {error}"))
}

pub fn game_gesture<R: Runtime>(
    app: &AppHandle<R>,
    package_name: &str,
    start: (i32, i32),
    end: (i32, i32),
    duration_ms: u64,
) -> Result<(), String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin(
            "gameGesture",
            GestureRequest {
                package_name,
                x1: start.0,
                y1: start.1,
                x2: end.0,
                y2: end.1,
                duration_ms,
            },
        )
        .map_err(|error| format!("failed to control Android game: {error}"))
}

pub fn install_package<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<(), String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin("installPackage", InstallPackageRequest { path })
        .map_err(|error| format!("failed to open Android package installer: {error}"))
}

pub fn shizuku_status<R: Runtime>(app: &AppHandle<R>) -> Result<AndroidShizukuState, String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin("shizukuStatus", ())
        .map_err(|error| format!("failed to read Shizuku status: {error}"))
}

pub fn request_shizuku_permission<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin("requestShizukuPermission", ())
        .map_err(|error| format!("failed to request Shizuku permission: {error}"))
}

pub fn shizuku_shell<R: Runtime>(app: &AppHandle<R>, command: &str) -> Result<String, String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin::<ShizukuShellResult>("shizukuShell", ShizukuShellRequest { command })
        .map(|result| result.output)
        .map_err(|error| format!("Shizuku command failed: {error}"))
}

pub fn start_shizuku_display<R: Runtime>(
    app: &AppHandle<R>,
    width: u32,
    height: u32,
    density: u32,
) -> Result<i32, String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin::<ShizukuDisplayResult>(
            "startShizukuDisplay",
            ShizukuDisplayRequest {
                width,
                height,
                density,
            },
        )
        .map(|result| result.display_id)
        .map_err(|error| format!("failed to create Shizuku virtual display: {error}"))
}

pub fn stop_shizuku_display<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.state::<AndroidBackendService<R>>()
        .0
        .run_mobile_plugin("stopShizukuDisplay", ())
        .map_err(|error| format!("failed to stop Shizuku virtual display: {error}"))
}
