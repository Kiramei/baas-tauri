use crate::system_logs::system_log;
use baas_updater::{
    android::{
        android_repository_local_sha, android_repository_remote_sha, AndroidTerminalSnapshot,
        AndroidUpdaterTermManager, AndroidWorkflowAbortReport, AndroidWorkflowAbortRequest,
    },
    repo::repository_urls,
    RepositoryKind, UpdateChannel, WorkflowOptions,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rand::rngs::OsRng;
use rsa::{
    pkcs1v15::Pkcs1v15Sign,
    pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding},
    traits::PublicKeyParts,
    RsaPrivateKey,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use std::{
    fs,
    io::{ErrorKind, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tokio::{task::JoinSet, time};

const ANDROID_BACKEND_MESSAGE: &str =
    "Android embeds Python 3.9 through Chaquopy and does not use uv. The Android application layer starts a Python bootstrap which unpacks the bundled BAAS service backend into app-private storage and reports missing Android-compatible runtime dependencies through /health.";
const ANDROID_PACKAGE_NAME: &str = "io.github.kiramei.baas_tauri";
const ANDROID_STORAGE_ROOT_MARKER: &str = "baas-android-storage-root.txt";
const ANDROID_ADB_PRIVATE_KEY: &str = "adbkey";
const ANDROID_ADBD_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const ANDROID_ADBD_AUTH_TIMEOUT: Duration = Duration::from_secs(90);
const ANDROID_ADBD_FAST_TIMEOUT: Duration = Duration::from_secs(4);
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
    pub transport: Option<String>,
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
pub struct AndroidScrcpyVirtualDisplayRequest {
    pub serial: Option<String>,
    pub config_id: Option<String>,
    pub package_name: Option<String>,
    pub activity_name: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub density: Option<u32>,
    pub adb_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidScrcpyVirtualDisplayReport {
    pub serial: String,
    pub display_id: u32,
    pub package_name: String,
    pub activity_name: String,
    pub display_id_file: PathBuf,
    pub mode: String,
    pub log: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidScrcpyVirtualDisplayStatus {
    pub active: bool,
    pub serial: String,
    pub display_id: Option<u32>,
    pub display_id_file: PathBuf,
    pub setting: Option<String>,
    pub mode: String,
    pub log: Vec<String>,
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

#[tauri::command]
pub async fn android_prepare_scrcpy_virtual_display(
    app: AppHandle,
    request: AndroidScrcpyVirtualDisplayRequest,
) -> Result<Value, String> {
    system_log(
        "INFO",
        "android_display",
        format!(
            "Android virtual display preparation requested serial={:?}",
            request.serial
        ),
    );
    tauri::async_runtime::spawn_blocking(move || {
        android_prepare_scrcpy_virtual_display_blocking(app, request)
    })
    .await
    .map_err(|error| format!("Android virtual display preparation worker failed: {error}"))?
}

fn android_prepare_scrcpy_virtual_display_blocking(
    app: AppHandle,
    request: AndroidScrcpyVirtualDisplayRequest,
) -> Result<Value, String> {
    eprintln!("[BAAS_ANDROID_VD] prepare begin: {:?}", request);
    let mut failures = Vec::new();

    match prepare_scrcpy_virtual_display_with_adbd(&app, &request) {
        Ok(report) => {
            eprintln!(
                "[BAAS_ANDROID_VD] prepare success via embedded adbd: {:?}",
                report
            );
            return Ok(json!(report));
        }
        Err(error) => {
            eprintln!("[BAAS_ANDROID_VD] embedded adbd failed: {error}");
            failures.push(format!("embedded adbd: {error}"));
        }
    }

    match prepare_scrcpy_virtual_display_with_shell(&app, &request) {
        Ok(report) => {
            eprintln!(
                "[BAAS_ANDROID_VD] prepare success via app shell: {:?}",
                report
            );
            return Ok(json!(report));
        }
        Err(error) => {
            eprintln!("[BAAS_ANDROID_VD] app shell failed: {error}");
            failures.push(format!("app shell: {error}"));
        }
    }

    match prepare_scrcpy_virtual_display_with_adb(&app, &request) {
        Ok(report) => {
            eprintln!(
                "[BAAS_ANDROID_VD] prepare success via local adb: {:?}",
                report
            );
            return Ok(json!(report));
        }
        Err(error) => {
            eprintln!("[BAAS_ANDROID_VD] local adb failed: {error}");
            failures.push(format!("local adb: {error}"));
        }
    }

    Err(format!(
        "Android virtual display preparation failed. A normal APK UID cannot write \
         overlay_display_devices directly; embedded adbd requires an accessible adbd TCP endpoint, \
         and local adb requires an adb binary and an authorized wireless-debugging/adbd endpoint.\n{}",
        failures.join("\n")
    ))
}

#[tauri::command]
pub async fn android_cleanup_scrcpy_virtual_display(
    app: AppHandle,
    serial: Option<String>,
) -> Result<(), String> {
    system_log(
        "INFO",
        "android_display",
        format!("Android virtual display cleanup requested serial={serial:?}"),
    );
    tauri::async_runtime::spawn_blocking(move || {
        android_cleanup_scrcpy_virtual_display_blocking(app, serial)
    })
    .await
    .map_err(|error| format!("Android virtual display cleanup worker failed: {error}"))?
}

#[tauri::command]
pub async fn android_scrcpy_virtual_display_status(
    app: AppHandle,
    serial: Option<String>,
) -> Result<Value, String> {
    system_log(
        "DEBUG",
        "android_display",
        format!("Android virtual display status requested serial={serial:?}"),
    );
    tauri::async_runtime::spawn_blocking(move || {
        android_scrcpy_virtual_display_status_blocking(app, serial)
    })
    .await
    .map_err(|error| format!("Android virtual display status worker failed: {error}"))?
}

fn android_cleanup_scrcpy_virtual_display_blocking(
    app: AppHandle,
    serial: Option<String>,
) -> Result<(), String> {
    eprintln!("[BAAS_ANDROID_VD] cleanup begin: {:?}", serial);
    let mut log = Vec::new();
    let mut failures = Vec::new();
    let adb_serial = normalized_android_adb_serial(serial.as_deref());
    let auth_dir = android_storage_root(&app)
        .ok()
        .map(|root| root.join("config"));
    let force_stop_command = android_blue_archive_force_stop_shell_command();
    match adb_direct_shell_with_timeout(
        &adb_serial,
        "settings delete global overlay_display_devices",
        &mut log,
        auth_dir.as_deref(),
        Duration::from_secs(12),
    ) {
        Ok(_) => {}
        Err(error) => failures.push(format!("embedded adbd delete overlay: {error}")),
    }
    let _ = adb_direct_shell_with_timeout(
        &adb_serial,
        &force_stop_command,
        &mut log,
        auth_dir.as_deref(),
        ANDROID_ADBD_FAST_TIMEOUT,
    );
    let _ = adb_direct_shell_with_timeout(
        &adb_serial,
        "pkill -f com.genymobile.scrcpy.Server",
        &mut log,
        auth_dir.as_deref(),
        ANDROID_ADBD_FAST_TIMEOUT,
    );
    let _ = run_android_shell_command("settings delete global overlay_display_devices", &mut log)
        .map_err(|error| failures.push(format!("app shell delete overlay: {error}")));
    let _ = run_android_shell_command(&force_stop_command, &mut log);
    let _ = run_android_shell_command("pkill -f com.genymobile.scrcpy.Server", &mut log);
    for adb_path in android_adb_candidates(None) {
        let adb_serial = normalized_android_adb_serial(serial.as_deref());
        let _ = run_command(&adb_path, &["connect", &adb_serial], &mut log);
        let _ = run_command(
            &adb_path,
            &[
                "-s",
                &adb_serial,
                "shell",
                "settings",
                "delete",
                "global",
                "overlay_display_devices",
            ],
            &mut log,
        )
        .map_err(|error| failures.push(format!("{adb_path} delete overlay: {error}")));
        let _ = run_command(
            &adb_path,
            &["-s", &adb_serial, "shell", &force_stop_command],
            &mut log,
        );
        let _ = run_command(
            &adb_path,
            &[
                "-s",
                &adb_serial,
                "shell",
                "pkill",
                "-f",
                "com.genymobile.scrcpy.Server",
            ],
            &mut log,
        );
    }

    if wait_android_overlay_setting_inactive_with_adbd(
        &adb_serial,
        auth_dir.as_deref(),
        &mut log,
        Duration::from_secs(3),
    ) || wait_android_overlay_setting_inactive(&mut log, Duration::from_millis(500))
    {
        if let Ok(root) = android_storage_root(&app) {
            let _ = fs::remove_file(root.join("config").join("scrcpy_display_id.txt"));
        }
        eprintln!("[BAAS_ANDROID_VD] cleanup completed");
        return Ok(());
    }

    Err(format!(
        "Android virtual display cleanup did not clear overlay_display_devices.\n{}",
        failures.join("\n")
    ))
}

fn android_scrcpy_virtual_display_status_blocking(
    app: AppHandle,
    serial: Option<String>,
) -> Result<Value, String> {
    let serial = normalized_android_adb_serial(serial.as_deref());
    let config_dir = android_storage_root(&app)?.join("config");
    let display_id_file = config_dir.join("scrcpy_display_id.txt");
    let mut log = Vec::new();
    let marker_display_id = fs::read_to_string(&display_id_file)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok());

    let auth_dir = Some(config_dir.as_path());
    if let Ok(status) = android_virtual_display_status_from_shell(
        "embedded-adbd",
        &serial,
        &display_id_file,
        marker_display_id,
        &mut log,
        |command, log| {
            adb_direct_shell_with_timeout(
                &serial,
                command,
                log,
                auth_dir,
                ANDROID_ADBD_FAST_TIMEOUT,
            )
        },
    ) {
        return Ok(json!(status));
    }

    if let Ok(status) = android_virtual_display_status_from_shell(
        "app-shell",
        &serial,
        &display_id_file,
        marker_display_id,
        &mut log,
        |command, log| run_android_shell_command(command, log),
    ) {
        return Ok(json!(status));
    }

    for adb_path in android_adb_candidates(None) {
        let adb_path_for_shell = adb_path.clone();
        if serial.contains(':') {
            let _ = run_command(&adb_path, &["connect", &serial], &mut log);
        }
        if let Ok(status) = android_virtual_display_status_from_shell(
            "local-adb",
            &serial,
            &display_id_file,
            marker_display_id,
            &mut log,
            |command, log| {
                run_command(&adb_path_for_shell, &["-s", &serial, "shell", command], log)
            },
        ) {
            return Ok(json!(status));
        }
    }

    Ok(json!(AndroidScrcpyVirtualDisplayStatus {
        active: marker_display_id.is_some(),
        serial,
        display_id: marker_display_id,
        display_id_file,
        setting: None,
        mode: "marker-only".to_string(),
        log,
    }))
}

/// Performs the updater get storage state operation.
#[tauri::command]
pub fn updater_get_storage_state(app: AppHandle) -> Result<StorageStartupState, String> {
    system_log(
        "DEBUG",
        "storage",
        "Android frontend storage state requested",
    );
    let storage_file_path = android_storage_root(&app)?.join(".app_storage.json");
    Ok(StorageStartupState {
        store_path: storage_file_path.clone(),
        storage_file_path,
        portable: false,
    })
}

fn prepare_scrcpy_virtual_display_with_adbd(
    app: &AppHandle,
    request: &AndroidScrcpyVirtualDisplayRequest,
) -> Result<AndroidScrcpyVirtualDisplayReport, String> {
    let width = request.width.unwrap_or(1280);
    let height = request.height.unwrap_or(720);
    let density = request.density.unwrap_or(240);
    let serial = normalized_android_adb_serial(request.serial.as_deref());
    let auth_dir = android_storage_root(app)?.join("config");
    let activity_name = request
        .activity_name
        .clone()
        .unwrap_or_else(|| "com.yostar.sdk.bridge.YoStarUnityPlayerActivity".to_string());
    let mut log = Vec::new();

    adb_direct_shell(
        &serial,
        &format!("settings put global overlay_display_devices {width}x{height}/{density}"),
        &mut log,
        Some(&auth_dir),
    )?;
    thread::sleep(Duration::from_secs(2));
    let display_dump = adb_direct_shell(
        &serial,
        "dumpsys window displays",
        &mut log,
        Some(&auth_dir),
    )?;
    let display_id =
        parse_android_overlay_display_id(&display_dump, width, height).ok_or_else(|| {
            format!("failed to find overlay display in dumpsys output:\n{display_dump}")
        })?;
    let package_name = match request.package_name.clone() {
        Some(package) if !package.trim().is_empty() => package,
        _ => resolve_android_blue_archive_package_with_adbd(&serial, &mut log, &auth_dir)?,
    };

    start_android_activity_on_display_with_adbd(
        &serial,
        display_id,
        &package_name,
        &activity_name,
        &mut log,
        &auth_dir,
    )?;

    finish_android_scrcpy_virtual_display(
        app,
        "embedded-adbd",
        &serial,
        request.config_id.as_deref(),
        display_id,
        package_name,
        activity_name,
        log,
    )
}

fn start_android_activity_on_display_with_adbd(
    serial: &str,
    display_id: u32,
    package_name: &str,
    activity_name: &str,
    log: &mut Vec<String>,
    auth_dir: &Path,
) -> Result<(), String> {
    let component = format!("{package_name}/{activity_name}");
    let command = format!("am start-activity --display {display_id} -n {component}");
    let mut last_start_output = String::new();
    let mut last_display_dump = String::new();

    for attempt in 1..=6 {
        log.push(format!(
            "starting {component} on Android display {display_id}, attempt {attempt}/6"
        ));
        last_start_output = adb_direct_shell(serial, &command, log, Some(auth_dir))?;
        thread::sleep(Duration::from_secs(2));
        last_display_dump =
            adb_direct_shell(serial, "dumpsys window displays", log, Some(auth_dir))?;
        if android_display_contains_activity(
            &last_display_dump,
            display_id,
            package_name,
            activity_name,
        ) {
            log.push(format!(
                "verified {component} is running on Android display {display_id}"
            ));
            return Ok(());
        }
    }

    Err(format!(
        "{component} did not become visible on Android display {display_id} after retries.\nLast start output:\n{last_start_output}\nLast display dump:\n{last_display_dump}"
    ))
}

fn android_display_contains_activity(
    display_dump: &str,
    display_id: u32,
    package_name: &str,
    activity_name: &str,
) -> bool {
    let display_marker = format!("Display: mDisplayId={display_id}");
    let activity_leaf = activity_name
        .rsplit_once('.')
        .map(|(_, leaf)| leaf)
        .unwrap_or(activity_name);
    let mut in_target_display = false;

    for line in display_dump.lines() {
        if line.contains("Display: mDisplayId=") {
            in_target_display = line.contains(&display_marker);
            continue;
        }
        if in_target_display
            && line.contains(package_name)
            && (line.contains(activity_name) || line.contains(activity_leaf))
        {
            return true;
        }
    }
    false
}

fn prepare_scrcpy_virtual_display_with_shell(
    app: &AppHandle,
    request: &AndroidScrcpyVirtualDisplayRequest,
) -> Result<AndroidScrcpyVirtualDisplayReport, String> {
    let width = request.width.unwrap_or(1280);
    let height = request.height.unwrap_or(720);
    let density = request.density.unwrap_or(240);
    let activity_name = request
        .activity_name
        .clone()
        .unwrap_or_else(|| "com.yostar.sdk.bridge.YoStarUnityPlayerActivity".to_string());
    let mut log = Vec::new();

    run_command(
        "settings",
        &[
            "put",
            "global",
            "overlay_display_devices",
            &format!("{width}x{height}/{density}"),
        ],
        &mut log,
    )?;
    thread::sleep(Duration::from_secs(2));
    let display_dump = run_command("dumpsys", &["window", "displays"], &mut log)?;
    let display_id =
        parse_android_overlay_display_id(&display_dump, width, height).ok_or_else(|| {
            format!("failed to find overlay display in dumpsys output:\n{display_dump}")
        })?;
    let package_name = match request.package_name.clone() {
        Some(package) if !package.trim().is_empty() => package,
        _ => resolve_android_blue_archive_package_with_shell(&mut log)?,
    };

    run_command(
        "am",
        &[
            "start-activity",
            "--display",
            &display_id.to_string(),
            "-n",
            &format!("{package_name}/{activity_name}"),
        ],
        &mut log,
    )?;

    finish_android_scrcpy_virtual_display(
        app,
        "app-shell",
        "",
        request.config_id.as_deref(),
        display_id,
        package_name,
        activity_name,
        log,
    )
}

fn prepare_scrcpy_virtual_display_with_adb(
    app: &AppHandle,
    request: &AndroidScrcpyVirtualDisplayRequest,
) -> Result<AndroidScrcpyVirtualDisplayReport, String> {
    let width = request.width.unwrap_or(1280);
    let height = request.height.unwrap_or(720);
    let density = request.density.unwrap_or(240);
    let serial = normalized_android_adb_serial(request.serial.as_deref());
    let activity_name = request
        .activity_name
        .clone()
        .unwrap_or_else(|| "com.yostar.sdk.bridge.YoStarUnityPlayerActivity".to_string());
    let mut errors = Vec::new();

    for adb_path in android_adb_candidates(request.adb_path.as_deref()) {
        let mut log = Vec::new();
        if serial.contains(':') {
            let _ = run_command(&adb_path, &["connect", &serial], &mut log);
        }
        let result = (|| {
            run_command(
                &adb_path,
                &[
                    "-s",
                    &serial,
                    "shell",
                    "settings",
                    "put",
                    "global",
                    "overlay_display_devices",
                    &format!("{width}x{height}/{density}"),
                ],
                &mut log,
            )?;
            thread::sleep(Duration::from_secs(2));
            let display_dump = run_command(
                &adb_path,
                &["-s", &serial, "shell", "dumpsys", "window", "displays"],
                &mut log,
            )?;
            let display_id = parse_android_overlay_display_id(&display_dump, width, height)
                .ok_or_else(|| {
                    format!("failed to find overlay display in dumpsys output:\n{display_dump}")
                })?;
            let package_name = match request.package_name.clone() {
                Some(package) if !package.trim().is_empty() => package,
                _ => resolve_android_blue_archive_package_with_adb(&adb_path, &serial, &mut log)?,
            };
            run_command(
                &adb_path,
                &[
                    "-s",
                    &serial,
                    "shell",
                    "am",
                    "start-activity",
                    "--display",
                    &display_id.to_string(),
                    "-n",
                    &format!("{package_name}/{activity_name}"),
                ],
                &mut log,
            )?;
            finish_android_scrcpy_virtual_display(
                app,
                "local-adb",
                &serial,
                request.config_id.as_deref(),
                display_id,
                package_name,
                activity_name.clone(),
                log,
            )
        })();

        match result {
            Ok(report) => return Ok(report),
            Err(error) => errors.push(format!("{adb_path}: {error}")),
        }
    }

    Err(errors.join("\n"))
}

fn finish_android_scrcpy_virtual_display(
    app: &AppHandle,
    mode: &str,
    serial: &str,
    config_id: Option<&str>,
    display_id: u32,
    package_name: String,
    activity_name: String,
    log: Vec<String>,
) -> Result<AndroidScrcpyVirtualDisplayReport, String> {
    let config_dir = android_storage_root(app)?.join("config");
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let display_id_file = config_dir.join("scrcpy_display_id.txt");
    fs::write(&display_id_file, display_id.to_string()).map_err(|error| error.to_string())?;
    let patched_backend = patch_android_scrcpy_backend_runtime(app)?;
    if patched_backend {
        eprintln!(
            "[BAAS_ANDROID_VD] backend runtime patched; keeping current Android backend alive"
        );
    }
    patch_android_scrcpy_profile_config(app, config_id, serial)?;
    Ok(AndroidScrcpyVirtualDisplayReport {
        serial: serial.to_string(),
        display_id,
        package_name,
        activity_name,
        display_id_file,
        mode: mode.to_string(),
        log,
    })
}

fn patch_android_scrcpy_profile_config(
    app: &AppHandle,
    config_id: Option<&str>,
    serial: &str,
) -> Result<(), String> {
    let Some(config_id) = config_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if config_id.contains('/') || config_id.contains('\\') || config_id.contains("..") {
        return Err(format!(
            "invalid config id for Android scrcpy patch: {config_id}"
        ));
    }
    let config_path = android_storage_root(app)?
        .join("config")
        .join(config_id)
        .join("config.json");
    if !config_path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&config_path).map_err(|error| error.to_string())?;
    let mut value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| format!("config is not a JSON object: {}", config_path.display()))?;
    let (adb_ip, adb_port) = serial
        .rsplit_once(':')
        .map(|(host, port)| (host.to_string(), port.to_string()))
        .unwrap_or_else(|| ("127.0.0.1".to_string(), "5555".to_string()));
    object.insert("screenshot_method".to_string(), json!("adb"));
    object.insert("control_method".to_string(), json!("adb"));
    object.insert("adbIP".to_string(), json!(adb_ip));
    object.insert("adbPort".to_string(), json!(adb_port));
    let pretty = serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?;
    fs::write(&config_path, format!("{pretty}\n")).map_err(|error| error.to_string())?;
    Ok(())
}

fn patch_android_scrcpy_backend_runtime(app: &AppHandle) -> Result<bool, String> {
    let root = android_storage_root(app)?;
    let mut patched_any = false;
    let mut errors = Vec::new();

    for result in [
        patch_android_scrcpy_connection(&root),
        patch_android_scrcpy_screenshot(&root),
        patch_android_scrcpy_control(&root),
        patch_android_scrcpy_core(&root),
        patch_android_scrcpy_config_manager(&root),
        patch_android_virtual_display_adb_io(&root),
        patch_android_virtual_display_loading_detection(&root),
    ] {
        match result {
            Ok(true) => patched_any = true,
            Ok(false) => {}
            Err(error) => errors.push(error),
        }
    }

    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    if !patched_any {
        eprintln!(
            "[BAAS_ANDROID_VD] backend runtime patch skipped; backend files are not unpacked yet under {}",
            root.display()
        );
    }
    Ok(patched_any)
}

fn patch_android_scrcpy_connection(root: &Path) -> Result<bool, String> {
    let path = root.join("core").join("device").join("connection.py");
    let import_patched = ensure_python_import_os(&path)?;
    let method_patched = patch_python_file(
        &path,
        "BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V3",
        "        self.adbIP = self.config.adbIP\n        self.adbPort = self.config.adbPort\n",
        "        self.adbIP = self.config.adbIP\n        self.adbPort = self.config.adbPort\n        # BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V3\n        display_id_candidates = [\n            os.getenv(\"BAAS_SCRCPY_DISPLAY_ID_FILE\", \"\").strip(),\n            os.path.join(os.getcwd(), \"config\", \"scrcpy_display_id.txt\"),\n            \"/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri/config/scrcpy_display_id.txt\",\n        ]\n        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.adbIP = \"127.0.0.1\"\n            self.adbPort = \"5555\"\n",
    )?;
    let upgraded = upgrade_old_android_scrcpy_runtime_block(&path)?;
    let scrcpy_method_patched = replace_python_file_fragments(
        &path,
        &[(
            "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.method = \"android_local\"\n",
            "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.method = \"scrcpy\"\n",
        )],
    )?;
    Ok(import_patched || method_patched || upgraded || scrcpy_method_patched)
}

fn patch_android_scrcpy_screenshot(root: &Path) -> Result<bool, String> {
    let path = root.join("core").join("device").join("Screenshot.py");
    let import_patched = ensure_python_import_os(&path)?;
    let method_patched = patch_python_file(
        &path,
        "BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V3",
        "        self.method = self.config.screenshot_method\n        self.logger.info(\"Screenshot method : \" + self.method)\n",
        "        self.method = self.config.screenshot_method\n        # BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V3\n        display_id_candidates = [\n            os.getenv(\"BAAS_SCRCPY_DISPLAY_ID_FILE\", \"\").strip(),\n            os.path.join(os.getcwd(), \"config\", \"scrcpy_display_id.txt\"),\n            \"/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri/config/scrcpy_display_id.txt\",\n        ]\n        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.method = \"adb\"\n        self.logger.info(\"Screenshot method : \" + self.method)\n",
    )?;
    let upgraded = upgrade_old_android_scrcpy_runtime_block(&path)?;
    let adb_method_patched = replace_python_file_fragments(
        &path,
        &[(
            "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.method = \"scrcpy\"\n",
            "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.method = \"adb\"\n",
        )],
    )?;
    Ok(import_patched || method_patched || upgraded || adb_method_patched)
}

fn patch_android_scrcpy_control(root: &Path) -> Result<bool, String> {
    let path = root.join("core").join("device").join("Control.py");
    let import_patched = ensure_python_import_os(&path)?;
    let method_patched = patch_python_file(
        &path,
        "BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V3",
        "        self.method = self.config.control_method\n        self.logger.info(\"Control method : \" + self.method)\n",
        "        self.method = self.config.control_method\n        # BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V3\n        display_id_candidates = [\n            os.getenv(\"BAAS_SCRCPY_DISPLAY_ID_FILE\", \"\").strip(),\n            os.path.join(os.getcwd(), \"config\", \"scrcpy_display_id.txt\"),\n            \"/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri/config/scrcpy_display_id.txt\",\n        ]\n        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.method = \"adb\"\n        self.logger.info(\"Control method : \" + self.method)\n",
    )?;
    let upgraded = upgrade_old_android_scrcpy_runtime_block(&path)?;
    let adb_method_patched = replace_python_file_fragments(
        &path,
        &[
            (
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.method = \"android_local\"\n",
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.method = \"adb\"\n",
            ),
            (
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.method = \"scrcpy\"\n",
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            self.method = \"adb\"\n",
            ),
        ],
    )?;
    Ok(import_patched || method_patched || upgraded || adb_method_patched)
}

fn patch_android_scrcpy_config_manager(root: &Path) -> Result<bool, String> {
    let path = root.join("service").join("conf").join("manager.py");
    let import_patched = ensure_python_import_os(&path)?;
    let method_patched = patch_python_file(
        &path,
        "BAAS_ANDROID_SCRCPY_CONFIG_MANAGER_PATCH_V1",
        "        normalized[\"control_method\"] = ANDROID_LOCAL_METHOD\n        normalized[\"screenshot_method\"] = ANDROID_LOCAL_METHOD\n        return normalized\n",
        "        # BAAS_ANDROID_SCRCPY_CONFIG_MANAGER_PATCH_V1\n        display_id_candidates = [\n            os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n            os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n            '/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri/config/scrcpy_display_id.txt',\n        ]\n        if any(path and os.path.exists(path) for path in display_id_candidates):\n            normalized['adbIP'] = '127.0.0.1'\n            normalized['adbPort'] = '5555'\n            normalized['control_method'] = 'adb'\n            normalized['screenshot_method'] = 'adb'\n            return normalized\n        normalized[\"control_method\"] = ANDROID_LOCAL_METHOD\n        normalized[\"screenshot_method\"] = ANDROID_LOCAL_METHOD\n        return normalized\n",
    )?;
    let adb_method_patched = replace_python_file_fragments(
        &path,
        &[
            (
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            normalized['adbIP'] = '127.0.0.1'\n            normalized['adbPort'] = '5555'\n            normalized['control_method'] = ANDROID_LOCAL_METHOD\n            normalized['screenshot_method'] = ANDROID_LOCAL_METHOD\n            return normalized\n",
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            normalized['adbIP'] = '127.0.0.1'\n            normalized['adbPort'] = '5555'\n            normalized['control_method'] = 'adb'\n            normalized['screenshot_method'] = 'adb'\n            return normalized\n",
            ),
            (
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            normalized['adbIP'] = '127.0.0.1'\n            normalized['adbPort'] = '5555'\n            normalized['control_method'] = 'scrcpy'\n            normalized['screenshot_method'] = 'scrcpy'\n            return normalized\n",
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n            normalized['adbIP'] = '127.0.0.1'\n            normalized['adbPort'] = '5555'\n            normalized['control_method'] = 'adb'\n            normalized['screenshot_method'] = 'adb'\n            return normalized\n",
            ),
        ],
    )?;
    Ok(import_patched || method_patched || adb_method_patched)
}

fn patch_android_scrcpy_core(root: &Path) -> Result<bool, String> {
    let path = root
        .join("core")
        .join("device")
        .join("scrcpy")
        .join("core.py");
    let import_patched = ensure_python_import_os(&path)?;
    let method_patched = patch_python_file(
        &path,
        "BAAS_ANDROID_SCRCPY_DISPLAY_ID_PATCH",
        "            \"clipboard_autosync=false\",\n        ]\n\n        self.__server_stream: AdbConnection = self.device.shell(\n",
        "            \"clipboard_autosync=false\",\n        ]\n        # BAAS_ANDROID_SCRCPY_DISPLAY_ID_PATCH\n        display_id = os.getenv(\"BAAS_SCRCPY_DISPLAY_ID\", \"\").strip()\n        if not display_id:\n            display_id_file = os.getenv(\"BAAS_SCRCPY_DISPLAY_ID_FILE\", \"\").strip()\n            if not display_id_file:\n                display_id_file = os.path.join(os.getcwd(), \"config\", \"scrcpy_display_id.txt\")\n            try:\n                with open(display_id_file, \"r\", encoding=\"utf-8\") as handle:\n                    display_id = handle.read().strip()\n            except OSError:\n                display_id = \"\"\n        if display_id:\n            commands.append(f\"display_id={display_id}\")\n\n        self.__server_stream: AdbConnection = self.device.shell(\n",
    )?;
    Ok(import_patched || method_patched)
}

fn patch_android_virtual_display_adb_io(root: &Path) -> Result<bool, String> {
    let marker = "BAAS_ANDROID_VIRTUAL_DISPLAY_ADB_IO_PATCH_V1";
    let helper_marker = "BAAS_ANDROID_VIRTUAL_DISPLAY_ADB_IO_PATCH_V1_HELPER";

    let screenshot_path = root
        .join("core")
        .join("device")
        .join("screenshot")
        .join("adb.py");
    let screenshot_import = ensure_python_import_os(&screenshot_path)?;
    let screenshot_command = patch_python_file(
        &screenshot_path,
        marker,
        "        data = self.adb.shell(['screencap', '-p'], stream=False, encoding=None)\n",
        "        # BAAS_ANDROID_VIRTUAL_DISPLAY_ADB_IO_PATCH_V1\n        display_id = _baas_android_virtual_display_id()\n        command = ['screencap', '-d', display_id, '-p'] if display_id else ['screencap', '-p']\n        data = self.adb.shell(command, stream=False, encoding=None)\n",
    )?;
    let screenshot_helper = append_python_file_once(
        &screenshot_path,
        helper_marker,
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_ADB_IO_PATCH_V1_HELPER\ndef _baas_android_virtual_display_id():\n    candidates = [\n        os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n        os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n        '/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri/config/scrcpy_display_id.txt',\n    ]\n    for path in candidates:\n        if not path:\n            continue\n        try:\n            with open(path, 'r', encoding='utf-8') as handle:\n                value = handle.read().strip()\n            if value:\n                return value\n        except OSError:\n            pass\n    return ''\n",
    )?;

    let control_path = root
        .join("core")
        .join("device")
        .join("control")
        .join("adb.py");
    let control_import = ensure_python_import_os(&control_path)?;
    let control_init = patch_python_file(
        &control_path,
        marker,
        "        self.adb = adb.device(self.serial)\n",
        "        self.adb = adb.device(self.serial)\n        # BAAS_ANDROID_VIRTUAL_DISPLAY_ADB_IO_PATCH_V1\n        self.display_id = _baas_android_virtual_display_id()\n",
    )?;
    let control_commands = replace_python_file_fragments(
        &control_path,
        &[
            (
                "        self.adb.shell(f'input tap {x} {y}')\n",
                "        self.adb.shell(_baas_android_input_command(self.display_id, f'tap {x} {y}'))\n",
            ),
            (
                "        self.adb.shell(f'input swipe {x1} {y1} {x2} {y2} {duration}')\n",
                "        self.adb.shell(_baas_android_input_command(self.display_id, f'swipe {x1} {y1} {x2} {y2} {duration}'))\n",
            ),
            (
                "        self.adb.shell(f'input swipe {x} {y} {x} {y} {duration}')\n",
                "        self.adb.shell(_baas_android_input_command(self.display_id, f'swipe {x} {y} {x} {y} {duration}'))\n",
            ),
        ],
    )?;
    let control_helper = append_python_file_once(
        &control_path,
        helper_marker,
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_ADB_IO_PATCH_V1_HELPER\ndef _baas_android_virtual_display_id():\n    candidates = [\n        os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n        os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n        '/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri/config/scrcpy_display_id.txt',\n    ]\n    for path in candidates:\n        if not path:\n            continue\n        try:\n            with open(path, 'r', encoding='utf-8') as handle:\n                value = handle.read().strip()\n            if value:\n                return value\n        except OSError:\n            pass\n    return ''\n\n\ndef _baas_android_input_command(display_id, operation):\n    return f'input -d {display_id} {operation}' if display_id else f'input {operation}'\n",
    )?;

    Ok(screenshot_import
        || screenshot_command
        || screenshot_helper
        || control_import
        || control_init
        || control_commands
        || control_helper)
}

fn patch_android_virtual_display_loading_detection(root: &Path) -> Result<bool, String> {
    let marker = "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_PATCH_V1";
    let helper_marker = "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_PATCH_V1_HELPER";
    let path = root.join("core").join("color.py");
    let import_patched = ensure_python_import_os(&path)?;
    let condition_patched = patch_python_file(
        &path,
        marker,
        "    while (self.flag_run and\n           match_rgb_feature(self, \"loadingNotWhite\") and match_rgb_feature(self, \"loadingWhite\")):\n",
        "    # BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_PATCH_V1\n    while (self.flag_run and\n           ((match_rgb_feature(self, \"loadingNotWhite\") and match_rgb_feature(self, \"loadingWhite\"))\n            or _baas_android_virtual_display_loading(self))):\n",
    )?;
    let helper_patched = append_python_file_once(
        &path,
        helper_marker,
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_PATCH_V1_HELPER\ndef _baas_android_virtual_display_loading(self):\n    if os.getenv('BAAS_ANDROID', '').strip().lower() not in {'1', 'true', 'yes', 'on'}:\n        return False\n    display_id_candidates = [\n        os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n        os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n        '/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri/config/scrcpy_display_id.txt',\n    ]\n    if not any(path and os.path.exists(path) for path in display_id_candidates):\n        return False\n    return match_rgb_feature(self, 'loadingNotWhite')\n",
    )?;
    let news_guard_patched = replace_python_file_fragments(
        &path,
        &[
            (
                "    return match_rgb_feature(self, 'loadingNotWhite')\n",
                "    return (match_rgb_feature(self, 'loadingNotWhite')\n            and not _baas_android_virtual_display_news_modal(self)\n            and not _baas_android_virtual_display_normal_ui(self))\n",
            ),
            (
                "    return match_rgb_feature(self, 'loadingNotWhite') and not _baas_android_virtual_display_news_modal(self)\n",
                "    return (match_rgb_feature(self, 'loadingNotWhite')\n            and not _baas_android_virtual_display_news_modal(self)\n            and not _baas_android_virtual_display_normal_ui(self))\n",
            ),
            (
                "    return (match_rgb_feature(self, 'loadingNotWhite')\n            and not _baas_android_virtual_display_news_modal(self)\n            and not _baas_android_virtual_display_normal_ui(self))\n",
                "    return (match_rgb_feature(self, 'loadingNotWhite')\n            and not _baas_android_virtual_display_news_modal(self)\n            and not _baas_android_virtual_display_normal_ui(self)\n            and not _baas_android_virtual_display_result_modal(self))\n",
            ),
        ],
    )?;
    let news_helper_patched = append_python_file_once(
        &path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NEWS_GUARD_V1",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NEWS_GUARD_V1\ndef _baas_android_virtual_display_news_modal(self):\n    img = getattr(self, 'latest_img_array', None)\n    if img is None or getattr(img, 'ndim', 0) < 3:\n        return False\n    height, width = img.shape[:2]\n    if width != 1280 or height != 720:\n        return False\n    white = (230, 255, 230, 255, 230, 255)\n    blue = (20, 90, 120, 190, 220, 255)\n    modal_gray = (80, 140, 95, 145, 110, 165)\n    close_white_points = ((1132, 94), (1142, 104), (1152, 114))\n    close_blue_points = ((1100, 100), (1120, 104), (1160, 104), (1140, 80), (1140, 130))\n    header_points = ((130, 170), (450, 170), (900, 170))\n    white_hits = sum(1 for x, y in close_white_points if _pixel_in_range_xy(self, x, y, white))\n    blue_hits = sum(1 for x, y in close_blue_points if _pixel_in_range_xy(self, x, y, blue))\n    header_hits = sum(1 for x, y in header_points if _pixel_in_range_xy(self, x, y, modal_gray))\n    return white_hits >= 2 and blue_hits >= 4 and header_hits >= 2\n\n\ndef _pixel_in_range_xy(self, x, y, rgb_range):\n    pixel = _get_rgb_at_index(self, int(y), int(x))\n    if pixel is None:\n        return False\n    return _pixel_in_rgb_range(pixel, *rgb_range)\n",
    )?;

    let normal_ui_helper_patched = append_python_file_once(
        &path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V1",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V1\ndef _baas_android_virtual_display_normal_ui(self):\n    white = (220, 255, 220, 255, 220, 255)\n    yellow = (180, 255, 150, 235, 0, 90)\n    dark = (0, 95, 0, 95, 0, 120)\n    top_hits = sum(1 for x, y in ((520, 40), (640, 40), (760, 40), (1030, 40)) if _pixel_in_range_xy(self, x, y, white))\n    modal_hits = sum(1 for x, y in ((520, 90), (640, 90), (760, 90), (1000, 90)) if _pixel_in_range_xy(self, x, y, white))\n    result_hits = sum(1 for x, y in ((520, 190), (640, 190), (760, 190), (900, 190)) if _pixel_in_range_xy(self, x, y, white))\n    large_modal_hits = sum(1 for x, y in ((80, 90), (640, 90), (1200, 90), (80, 610), (640, 610), (1200, 610)) if _pixel_in_range_xy(self, x, y, white))\n    yellow_action_hits = sum(1 for x, y in ((940, 590), (1060, 590), (1190, 590)) if _pixel_in_range_xy(self, x, y, yellow))\n    overlay_hits = sum(1 for x, y in ((15, 55), (1265, 55), (15, 690), (1265, 690)) if _pixel_in_range_xy(self, x, y, dark))\n    return (top_hits >= 2 or modal_hits >= 3 or result_hits >= 3\n            or (large_modal_hits >= 4 and yellow_action_hits >= 2 and overlay_hits >= 2))\n",
    )?;
    let result_modal_helper_patched = append_python_file_once(
        &path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_RESULT_MODAL_GUARD_V1",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_RESULT_MODAL_GUARD_V1\ndef _baas_android_virtual_display_result_modal(self):\n    try:\n        if match_rgb_feature(self, 'reward_acquired'):\n            return True\n    except Exception:\n        pass\n    yellow = (220, 255, 180, 255, 40, 130)\n    dark = (0, 95, 0, 95, 0, 120)\n    title_hits = sum(1 for x, y in ((535, 150), (640, 150), (745, 150), (590, 185), (690, 185)) if _pixel_in_range_xy(self, x, y, yellow))\n    continue_hits = sum(1 for x, y in ((585, 635), (640, 635), (695, 635)) if _pixel_in_range_xy(self, x, y, (230, 255, 230, 255, 230, 255)))\n    edge_hits = sum(1 for x, y in ((95, 90), (1185, 90), (95, 680), (1185, 680)) if _pixel_in_range_xy(self, x, y, dark))\n    return title_hits >= 3 and (continue_hits >= 2 or edge_hits >= 2)\n",
    )?;
    let lesson_report_helper_patched = append_python_file_once(
        &path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V2",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V2\ndef _baas_android_virtual_display_normal_ui(self):\n    white = (220, 255, 220, 255, 220, 255)\n    yellow = (180, 255, 150, 235, 0, 90)\n    dark = (0, 95, 0, 95, 0, 120)\n    top_hits = sum(1 for x, y in ((520, 40), (640, 40), (760, 40), (1030, 40)) if _pixel_in_range_xy(self, x, y, white))\n    modal_hits = sum(1 for x, y in ((520, 90), (640, 90), (760, 90), (1000, 90)) if _pixel_in_range_xy(self, x, y, white))\n    result_hits = sum(1 for x, y in ((520, 190), (640, 190), (760, 190), (900, 190)) if _pixel_in_range_xy(self, x, y, white))\n    large_modal_hits = sum(1 for x, y in ((80, 90), (640, 90), (1200, 90), (80, 610), (640, 610), (1200, 610)) if _pixel_in_range_xy(self, x, y, white))\n    yellow_action_hits = sum(1 for x, y in ((940, 590), (1060, 590), (1190, 590)) if _pixel_in_range_xy(self, x, y, yellow))\n    overlay_hits = sum(1 for x, y in ((15, 55), (1265, 55), (15, 690), (1265, 690)) if _pixel_in_range_xy(self, x, y, dark))\n    report_panel = (190, 255, 220, 255, 230, 255)\n    report_button = (80, 155, 190, 245, 230, 255)\n    report_frame = (25, 75, 55, 105, 85, 140)\n    report_panel_hits = sum(1 for x, y in ((420, 115), (640, 115), (860, 115), (420, 625), (640, 625), (860, 625)) if _pixel_in_range_xy(self, x, y, report_panel))\n    report_button_hits = sum(1 for x, y in ((560, 555), (640, 555), (720, 555), (640, 525), (640, 590)) if _pixel_in_range_xy(self, x, y, report_button))\n    report_frame_hits = sum(1 for x, y in ((400, 100), (888, 640), (400, 640), (888, 100), (640, 400)) if _pixel_in_range_xy(self, x, y, report_frame))\n    return (top_hits >= 2 or modal_hits >= 3 or result_hits >= 3\n            or (large_modal_hits >= 4 and yellow_action_hits >= 2 and overlay_hits >= 2)\n            or (report_panel_hits >= 4 and report_button_hits >= 3 and report_frame_hits >= 2))\n",
    )?;
    let social_menu_helper_patched = append_python_file_once(
        &path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V3",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V3\ndef _baas_android_virtual_display_normal_ui(self):\n    white = (220, 255, 220, 255, 220, 255)\n    yellow = (180, 255, 150, 235, 0, 90)\n    dark = (0, 95, 0, 95, 0, 120)\n    top_hits = sum(1 for x, y in ((520, 40), (640, 40), (760, 40), (1030, 40)) if _pixel_in_range_xy(self, x, y, white))\n    modal_hits = sum(1 for x, y in ((520, 90), (640, 90), (760, 90), (1000, 90)) if _pixel_in_range_xy(self, x, y, white))\n    result_hits = sum(1 for x, y in ((520, 190), (640, 190), (760, 190), (900, 190)) if _pixel_in_range_xy(self, x, y, white))\n    large_modal_hits = sum(1 for x, y in ((80, 90), (640, 90), (1200, 90), (80, 610), (640, 610), (1200, 610)) if _pixel_in_range_xy(self, x, y, white))\n    yellow_action_hits = sum(1 for x, y in ((940, 590), (1060, 590), (1190, 590)) if _pixel_in_range_xy(self, x, y, yellow))\n    overlay_hits = sum(1 for x, y in ((15, 55), (1265, 55), (15, 690), (1265, 690)) if _pixel_in_range_xy(self, x, y, dark))\n    report_panel = (190, 255, 220, 255, 230, 255)\n    report_button = (80, 155, 190, 245, 230, 255)\n    report_frame = (25, 75, 55, 105, 85, 140)\n    report_panel_hits = sum(1 for x, y in ((420, 115), (640, 115), (860, 115), (420, 625), (640, 625), (860, 625)) if _pixel_in_range_xy(self, x, y, report_panel))\n    report_button_hits = sum(1 for x, y in ((560, 555), (640, 555), (720, 555), (640, 525), (640, 590)) if _pixel_in_range_xy(self, x, y, report_button))\n    report_frame_hits = sum(1 for x, y in ((400, 100), (888, 640), (400, 640), (888, 100), (640, 400)) if _pixel_in_range_xy(self, x, y, report_frame))\n    social_card_hits = sum(1 for x, y in ((300, 330), (640, 330), (970, 330), (300, 375), (640, 375), (970, 375)) if _pixel_in_range_xy(self, x, y, white))\n    social_blue = (0, 95, 80, 180, 135, 255)\n    social_blue_hits = sum(1 for x, y in ((580, 205), (640, 205), (500, 300), (840, 300)) if _pixel_in_range_xy(self, x, y, social_blue))\n    social_title_hits = sum(1 for x, y in ((670, 205), (700, 205), (730, 205)) if _pixel_in_range_xy(self, x, y, white))\n    return (top_hits >= 2 or modal_hits >= 3 or result_hits >= 3\n            or (large_modal_hits >= 4 and yellow_action_hits >= 2 and overlay_hits >= 2)\n            or (report_panel_hits >= 4 and report_button_hits >= 3 and report_frame_hits >= 2)\n            or (social_card_hits >= 4 and social_blue_hits >= 2 and (social_title_hits >= 1 or overlay_hits >= 2)))\n",
    )?;
    let help_modal_helper_patched = append_python_file_once(
        &path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V4",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V4\ndef _baas_android_virtual_display_normal_ui(self):\n    white = (220, 255, 220, 255, 220, 255)\n    yellow = (180, 255, 150, 235, 0, 90)\n    dark = (0, 95, 0, 95, 0, 120)\n    top_hits = sum(1 for x, y in ((520, 40), (640, 40), (760, 40), (1030, 40)) if _pixel_in_range_xy(self, x, y, white))\n    modal_hits = sum(1 for x, y in ((520, 90), (640, 90), (760, 90), (1000, 90)) if _pixel_in_range_xy(self, x, y, white))\n    result_hits = sum(1 for x, y in ((520, 190), (640, 190), (760, 190), (900, 190)) if _pixel_in_range_xy(self, x, y, white))\n    large_modal_hits = sum(1 for x, y in ((80, 90), (640, 90), (1200, 90), (80, 610), (640, 610), (1200, 610)) if _pixel_in_range_xy(self, x, y, white))\n    yellow_action_hits = sum(1 for x, y in ((940, 590), (1060, 590), (1190, 590)) if _pixel_in_range_xy(self, x, y, yellow))\n    overlay_hits = sum(1 for x, y in ((15, 55), (1265, 55), (15, 690), (1265, 690)) if _pixel_in_range_xy(self, x, y, dark))\n    report_panel = (190, 255, 220, 255, 230, 255)\n    report_button = (80, 155, 190, 245, 230, 255)\n    report_frame = (25, 75, 55, 105, 85, 140)\n    report_panel_hits = sum(1 for x, y in ((420, 115), (640, 115), (860, 115), (420, 625), (640, 625), (860, 625)) if _pixel_in_range_xy(self, x, y, report_panel))\n    report_button_hits = sum(1 for x, y in ((560, 555), (640, 555), (720, 555), (640, 525), (640, 590)) if _pixel_in_range_xy(self, x, y, report_button))\n    report_frame_hits = sum(1 for x, y in ((400, 100), (888, 640), (400, 640), (888, 100), (640, 400)) if _pixel_in_range_xy(self, x, y, report_frame))\n    social_card_hits = sum(1 for x, y in ((300, 330), (640, 330), (970, 330), (300, 375), (640, 375), (970, 375)) if _pixel_in_range_xy(self, x, y, white))\n    social_blue = (0, 95, 80, 180, 135, 255)\n    social_blue_hits = sum(1 for x, y in ((580, 205), (640, 205), (500, 300), (840, 300)) if _pixel_in_range_xy(self, x, y, social_blue))\n    social_title_hits = sum(1 for x, y in ((670, 205), (700, 205), (730, 205)) if _pixel_in_range_xy(self, x, y, white))\n    help_panel = (190, 255, 215, 255, 225, 255)\n    help_close = (0, 75, 20, 100, 45, 125)\n    help_panel_hits = sum(1 for x, y in ((260, 130), (640, 130), (1010, 130), (260, 600), (640, 600), (1010, 600)) if _pixel_in_range_xy(self, x, y, help_panel))\n    help_close_hits = sum(1 for x, y in ((1008, 122), (1018, 132), (1028, 142)) if _pixel_in_range_xy(self, x, y, help_close))\n    return (top_hits >= 2 or modal_hits >= 3 or result_hits >= 3\n            or (large_modal_hits >= 4 and yellow_action_hits >= 2 and overlay_hits >= 2)\n            or (report_panel_hits >= 4 and report_button_hits >= 3 and report_frame_hits >= 2)\n            or (social_card_hits >= 4 and social_blue_hits >= 2 and (social_title_hits >= 1 or overlay_hits >= 2))\n            or (help_panel_hits >= 5 and help_close_hits >= 2))\n",
    )?;

    Ok(import_patched
        || condition_patched
        || helper_patched
        || news_guard_patched
        || news_helper_patched
        || normal_ui_helper_patched
        || result_modal_helper_patched
        || lesson_report_helper_patched
        || social_menu_helper_patched
        || help_modal_helper_patched)
}

fn ensure_python_import_os(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let uses_crlf = text.contains("\r\n");
    let text = text.replace("\r\n", "\n");
    if text.lines().any(|line| line.trim() == "import os") {
        return Ok(false);
    }
    let mut next_text = if text.contains("import sys\n") {
        text.replacen("import sys\n", "import sys\nimport os\n", 1)
    } else {
        let mut insert_at = None;
        for (index, _) in text.match_indices('\n') {
            let line_start = text[..index].rfind('\n').map(|pos| pos + 1).unwrap_or(0);
            let current = &text[line_start..index];
            if current.starts_with("import ") || current.starts_with("from ") {
                insert_at = Some(index + 1);
            }
        }
        let Some(insert_at) = insert_at else {
            return Ok(false);
        };
        let mut patched = text.clone();
        patched.insert_str(insert_at, "import os\n");
        patched
    };
    if uses_crlf {
        next_text = next_text.replace('\n', "\r\n");
    }
    fs::write(path, next_text)
        .map_err(|error| format!("failed to patch {}: {error}", path.display()))?;
    remove_python_cache(path);
    Ok(true)
}

fn patch_python_file(
    path: &Path,
    marker: &str,
    needle: &str,
    replacement: &str,
) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let uses_crlf = text.contains("\r\n");
    let text = text.replace("\r\n", "\n");
    if text.contains(marker) || !text.contains(needle) {
        return Ok(false);
    }
    let mut next_text = text.replacen(needle, replacement, 1);
    if uses_crlf {
        next_text = next_text.replace('\n', "\r\n");
    }
    fs::write(path, next_text)
        .map_err(|error| format!("failed to patch {}: {error}", path.display()))?;
    remove_python_cache(path);
    Ok(true)
}

fn replace_python_file_fragments(
    path: &Path,
    replacements: &[(&str, &str)],
) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let uses_crlf = text.contains("\r\n");
    let mut next_text = text.replace("\r\n", "\n");
    let original = next_text.clone();
    for (needle, replacement) in replacements {
        next_text = next_text.replace(needle, replacement);
    }
    if next_text == original {
        return Ok(false);
    }
    if uses_crlf {
        next_text = next_text.replace('\n', "\r\n");
    }
    fs::write(path, next_text)
        .map_err(|error| format!("failed to patch {}: {error}", path.display()))?;
    remove_python_cache(path);
    Ok(true)
}

fn append_python_file_once(path: &Path, marker: &str, addition: &str) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    if text.contains(marker) {
        return Ok(false);
    }
    let next_text = format!("{}\n{}", text.trim_end(), addition.trim_start_matches('\n'));
    fs::write(path, next_text)
        .map_err(|error| format!("failed to patch {}: {error}", path.display()))?;
    remove_python_cache(path);
    Ok(true)
}

fn upgrade_old_android_scrcpy_runtime_block(path: &Path) -> Result<bool, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return Ok(false),
    };
    let uses_crlf = text.contains("\r\n");
    let text = text.replace("\r\n", "\n");
    if text.contains("BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V3") {
        return Ok(false);
    }
    let old_v2 = "        # BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V2\n        if os.getenv('BAAS_ANDROID', '').lower() in {'1', 'true', 'yes', 'on'}:\n            display_id_candidates = [\n                os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n                os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n                '/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri/config/scrcpy_display_id.txt',\n            ]\n            if any(path and os.path.exists(path) for path in display_id_candidates):\n";
    let new = "        # BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V3\n        display_id_candidates = [\n            os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n            os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n            '/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri/config/scrcpy_display_id.txt',\n        ]\n        if any(path and os.path.exists(path) for path in display_id_candidates):\n";
    if text.contains(old_v2) {
        let mut next_text = text.replacen(old_v2, new, 1);
        if uses_crlf {
            next_text = next_text.replace('\n', "\r\n");
        }
        fs::write(path, next_text)
            .map_err(|error| format!("failed to upgrade {}: {error}", path.display()))?;
        remove_python_cache(path);
        return Ok(true);
    }
    let old = "        # BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH\n        if os.getenv('BAAS_ANDROID', '').lower() in {'1', 'true', 'yes', 'on'}:\n            display_id_file = os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt')\n            if os.path.exists(display_id_file):\n";
    if !text.contains(old) {
        return Ok(false);
    }
    let mut next_text = text.replacen(old, new, 1);
    if uses_crlf {
        next_text = next_text.replace('\n', "\r\n");
    }
    fs::write(path, next_text)
        .map_err(|error| format!("failed to upgrade {}: {error}", path.display()))?;
    remove_python_cache(path);
    Ok(true)
}

fn remove_python_cache(path: &Path) {
    let Some(parent) = path.parent() else {
        return;
    };
    let _ = fs::remove_dir_all(parent.join("__pycache__"));
}

fn run_command(program: &str, args: &[&str], log: &mut Vec<String>) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("{program} not executable: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    log.push(format!("{program} {}", args.join(" ")));
    if !stdout.trim().is_empty() {
        log.push(stdout.trim().to_string());
    }
    if !stderr.trim().is_empty() {
        log.push(stderr.trim().to_string());
    }
    if !output.status.success() {
        return Err(format!(
            "{program} {} failed\n{}{}",
            args.join(" "),
            stdout,
            stderr
        ));
    }
    Ok(stdout)
}

fn run_android_shell_command(command: &str, log: &mut Vec<String>) -> Result<String, String> {
    if command.trim().is_empty() {
        return Err("empty Android shell command".to_string());
    }
    run_command("sh", &["-c", command], log)
}

fn android_blue_archive_force_stop_shell_command() -> String {
    android_blue_archive_package_candidates()
        .iter()
        .map(|package| format!("am force-stop {package} >/dev/null 2>&1 || true"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn android_overlay_setting_is_inactive(log: &mut Vec<String>) -> bool {
    match run_command(
        "settings",
        &["get", "global", "overlay_display_devices"],
        log,
    ) {
        Ok(value) => {
            let trimmed = value.trim();
            trimmed.is_empty() || trimmed == "null" || trimmed.eq_ignore_ascii_case("deleted")
        }
        Err(_) => false,
    }
}

fn wait_android_overlay_setting_inactive(log: &mut Vec<String>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if android_overlay_setting_is_inactive(log) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn android_overlay_setting_is_inactive_with_adbd(
    serial: &str,
    auth_dir: Option<&Path>,
    log: &mut Vec<String>,
) -> bool {
    match adb_direct_shell_with_timeout(
        serial,
        "settings get global overlay_display_devices",
        log,
        auth_dir,
        ANDROID_ADBD_FAST_TIMEOUT,
    ) {
        Ok(value) => {
            let trimmed = value.trim();
            trimmed.is_empty() || trimmed == "null" || trimmed.eq_ignore_ascii_case("deleted")
        }
        Err(_) => false,
    }
}

fn wait_android_overlay_setting_inactive_with_adbd(
    serial: &str,
    auth_dir: Option<&Path>,
    log: &mut Vec<String>,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if android_overlay_setting_is_inactive_with_adbd(serial, auth_dir, log) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn android_virtual_display_status_from_shell<F>(
    mode: &str,
    serial: &str,
    display_id_file: &Path,
    marker_display_id: Option<u32>,
    log: &mut Vec<String>,
    mut shell: F,
) -> Result<AndroidScrcpyVirtualDisplayStatus, String>
where
    F: FnMut(&str, &mut Vec<String>) -> Result<String, String>,
{
    let setting = shell("settings get global overlay_display_devices", log)
        .map(|value| value.trim().to_string())?;
    let active_setting =
        !setting.is_empty() && setting != "null" && setting.to_ascii_lowercase() != "deleted";
    let display_dump = shell("dumpsys window displays", log).unwrap_or_default();
    let display_id = parse_android_overlay_display_id(&display_dump, 1280, 720)
        .or_else(|| parse_android_overlay_display_id_from_display_dump(&display_dump))
        .or(marker_display_id);

    if !active_setting {
        let _ = fs::remove_file(display_id_file);
    }

    Ok(AndroidScrcpyVirtualDisplayStatus {
        active: active_setting,
        serial: serial.to_string(),
        display_id: if active_setting { display_id } else { None },
        display_id_file: display_id_file.to_path_buf(),
        setting: if setting.is_empty() {
            None
        } else {
            Some(setting)
        },
        mode: mode.to_string(),
        log: log.clone(),
    })
}

fn parse_android_overlay_display_id(dump: &str, width: u32, height: u32) -> Option<u32> {
    let mut current_id = None;
    let mut candidates = Vec::new();
    let expected_size = format!("cur={width}x{height}");
    for line in dump.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Display: mDisplayId=") {
            let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
            current_id = digits.parse::<u32>().ok();
            continue;
        }
        if let Some(display_id) = current_id {
            if display_id != 0 && trimmed.contains(&expected_size) {
                candidates.push(display_id);
                current_id = None;
            }
        }
    }
    candidates.into_iter().max()
}

fn parse_android_overlay_display_id_from_display_dump(dump: &str) -> Option<u32> {
    let mut candidates = Vec::new();
    for line in dump.lines() {
        let trimmed = line.trim();
        if !(trimmed.contains("Display: mDisplayId=") && trimmed.contains("overlay")) {
            continue;
        }
        let Some(rest) = trimmed.split("Display: mDisplayId=").nth(1) else {
            continue;
        };
        let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
        if let Ok(display_id) = digits.parse::<u32>() {
            if display_id != 0 {
                candidates.push(display_id);
            }
        }
    }
    candidates.into_iter().max()
}

fn android_blue_archive_package_candidates() -> &'static [&'static str] {
    &[
        "com.RoamingStar.BlueArchive.bilibili",
        "com.RoamingStar.BlueArchive",
        "com.YostarJP.BlueArchive",
        "com.nexon.bluearchive",
    ]
}

fn resolve_android_blue_archive_package_with_shell(
    log: &mut Vec<String>,
) -> Result<String, String> {
    for package in android_blue_archive_package_candidates() {
        if run_command("pm", &["path", package], log)
            .map(|output| output.contains("package:"))
            .unwrap_or(false)
        {
            return Ok(package.to_string());
        }
    }
    Err("Blue Archive package not found".to_string())
}

fn resolve_android_blue_archive_package_with_adb(
    adb_path: &str,
    serial: &str,
    log: &mut Vec<String>,
) -> Result<String, String> {
    for package in android_blue_archive_package_candidates() {
        if run_command(
            adb_path,
            &["-s", serial, "shell", "pm", "path", package],
            log,
        )
        .map(|output| output.contains("package:"))
        .unwrap_or(false)
        {
            return Ok(package.to_string());
        }
    }
    Err("Blue Archive package not found".to_string())
}

fn resolve_android_blue_archive_package_with_adbd(
    serial: &str,
    log: &mut Vec<String>,
    auth_dir: &Path,
) -> Result<String, String> {
    for package in android_blue_archive_package_candidates() {
        if adb_direct_shell(serial, &format!("pm path {package}"), log, Some(auth_dir))
            .map(|output| output.contains("package:"))
            .unwrap_or(false)
        {
            return Ok(package.to_string());
        }
    }
    Err("Blue Archive package not found".to_string())
}

fn normalized_android_adb_serial(serial: Option<&str>) -> String {
    let serial = serial.unwrap_or("").trim();
    if serial.is_empty() || serial == "auto" || serial.starts_with("emulator-") {
        return "127.0.0.1:5555".to_string();
    }
    serial.to_string()
}

fn android_adb_candidates(configured: Option<&str>) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(path) = configured.map(str::trim).filter(|path| !path.is_empty()) {
        candidates.push(path.to_string());
    }
    candidates.push("/data/local/tmp/adb".to_string());
    candidates.push("adb".to_string());
    candidates
}

#[derive(Debug)]
struct AdbPacket {
    command: [u8; 4],
    arg0: u32,
    arg1: u32,
    payload: Vec<u8>,
}

fn adb_direct_shell(
    serial: &str,
    command: &str,
    log: &mut Vec<String>,
    auth_dir: Option<&Path>,
) -> Result<String, String> {
    adb_direct_shell_with_timeout(serial, command, log, auth_dir, ANDROID_ADBD_AUTH_TIMEOUT)
}

fn adb_direct_shell_with_timeout(
    serial: &str,
    command: &str,
    log: &mut Vec<String>,
    auth_dir: Option<&Path>,
    io_timeout: Duration,
) -> Result<String, String> {
    log.push(format!("embedded-adbd -s {serial} shell {command}"));
    let mut stream = adb_connect_with_timeout(serial, io_timeout)?;
    adb_write_packet(&mut stream, *b"CNXN", 0x0100_0000, 256 * 1024, b"host::\0")?;
    let mut auth_attempted = false;
    loop {
        let packet = adb_read_packet(&mut stream)?;
        match &packet.command {
            b"CNXN" => break,
            b"AUTH" => {
                let auth_dir = auth_dir.ok_or_else(|| {
                    "adbd requires AUTH but no Android adb auth key directory is available"
                        .to_string()
                })?;
                let auth_key = load_or_create_adb_auth_key(auth_dir)?;
                match packet.arg0 {
                    1 if !auth_attempted => {
                        log.push(
                            "embedded adbd requested AUTH; sending BAAS Android adb key signature"
                                .to_string(),
                        );
                        eprintln!(
                            "[BAAS_ANDROID_VD] embedded adbd requested AUTH; sending signature"
                        );
                        let signature = sign_adb_auth_token(&auth_key, &packet.payload)?;
                        adb_write_packet(&mut stream, *b"AUTH", 2, 0, &signature)?;
                        auth_attempted = true;
                    }
                    1 => {
                        log.push(
                            "embedded adbd still requires AUTH; sending public key baas-tauri@android. Approve the USB debugging dialog on the phone if it appears."
                                .to_string(),
                        );
                        eprintln!(
                            "[BAAS_ANDROID_VD] waiting for Android adb authorization for baas-tauri@android"
                        );
                        let public_key = encode_adb_public_key(&auth_key)?;
                        adb_write_packet(&mut stream, *b"AUTH", 3, 0, public_key.as_bytes())?;
                    }
                    other => {
                        return Err(format!("unsupported adbd AUTH type: {other}"));
                    }
                }
            }
            other => {
                return Err(format!(
                    "unexpected packet during CNXN: {}",
                    String::from_utf8_lossy(other)
                ));
            }
        }
    }

    let local_id = 1;
    let mut service = format!("shell:{command}").into_bytes();
    service.push(0);
    adb_write_packet(&mut stream, *b"OPEN", local_id, 0, &service)?;

    let mut remote_id = 0;
    let mut output = Vec::new();
    loop {
        let packet = adb_read_packet(&mut stream)?;
        match &packet.command {
            b"OKAY" => {
                remote_id = packet.arg0;
            }
            b"WRTE" => {
                if remote_id == 0 {
                    remote_id = packet.arg0;
                }
                output.extend_from_slice(&packet.payload);
                adb_write_packet(&mut stream, *b"OKAY", local_id, remote_id, b"")?;
            }
            b"CLSE" => {
                let _ = adb_write_packet(&mut stream, *b"CLSE", local_id, remote_id, b"");
                break;
            }
            b"FAIL" => {
                return Err(String::from_utf8_lossy(&packet.payload).to_string());
            }
            other => {
                return Err(format!(
                    "unexpected packet during shell: {}",
                    String::from_utf8_lossy(other)
                ));
            }
        }
    }
    let text = String::from_utf8_lossy(&output).trim_end().to_string();
    if !text.trim().is_empty() {
        log.push(text.clone());
    }
    Ok(text)
}

fn load_or_create_adb_auth_key(auth_dir: &Path) -> Result<RsaPrivateKey, String> {
    fs::create_dir_all(auth_dir).map_err(|error| {
        format!(
            "failed to create adb auth dir {}: {error}",
            auth_dir.display()
        )
    })?;
    let key_path = auth_dir.join(ANDROID_ADB_PRIVATE_KEY);
    if key_path.exists() {
        let pem = fs::read_to_string(&key_path).map_err(|error| {
            format!(
                "failed to read adb auth key {}: {error}",
                key_path.display()
            )
        })?;
        return RsaPrivateKey::from_pkcs8_pem(&pem).map_err(|error| {
            format!(
                "failed to parse adb auth key {}: {error}",
                key_path.display()
            )
        });
    }

    let mut rng = OsRng;
    let key = RsaPrivateKey::new(&mut rng, 2048)
        .map_err(|error| format!("failed to generate adb auth key: {error}"))?;
    let pem = key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|error| format!("failed to encode adb auth key: {error}"))?;
    fs::write(&key_path, pem.as_bytes()).map_err(|error| {
        format!(
            "failed to write adb auth key {}: {error}",
            key_path.display()
        )
    })?;
    Ok(key)
}

fn sign_adb_auth_token(key: &RsaPrivateKey, token: &[u8]) -> Result<Vec<u8>, String> {
    if token.len() != 20 {
        return Err(format!(
            "unexpected adbd AUTH token length: {}",
            token.len()
        ));
    }
    key.sign(Pkcs1v15Sign::new::<Sha1>(), token)
        .map_err(|error| format!("failed to sign adbd AUTH token: {error}"))
}

fn encode_adb_public_key(key: &RsaPrivateKey) -> Result<String, String> {
    const ADB_RSA_BITS: usize = 2048;
    const ADB_RSA_BYTES: usize = ADB_RSA_BITS / 8;
    const ADB_RSA_WORDS: u32 = (ADB_RSA_BYTES / 4) as u32;

    let n = key.n();
    if n.bits() > ADB_RSA_BITS {
        return Err(format!(
            "adb auth key modulus is too large: {} bits",
            n.bits()
        ));
    }

    let mut modulus = n.to_bytes_le();
    modulus.resize(ADB_RSA_BYTES, 0);
    let n0 = u32::from_le_bytes([modulus[0], modulus[1], modulus[2], modulus[3]]);
    let n0inv = 0u32.wrapping_sub(mod_inverse_u32(n0)?);

    let r = rsa::BigUint::from(1u8) << ADB_RSA_BITS;
    let rr = (&r * &r) % n;
    let mut rr_bytes = rr.to_bytes_le();
    rr_bytes.resize(ADB_RSA_BYTES, 0);

    let exponent_bytes = key.e().to_bytes_le();
    let exponent = match exponent_bytes.as_slice() {
        [] => 0,
        [a] => u32::from(*a),
        [a, b] => u32::from_le_bytes([*a, *b, 0, 0]),
        [a, b, c] => u32::from_le_bytes([*a, *b, *c, 0]),
        [a, b, c, d, ..] => u32::from_le_bytes([*a, *b, *c, *d]),
    };

    let mut blob = Vec::with_capacity(4 + 4 + ADB_RSA_BYTES + ADB_RSA_BYTES + 4);
    blob.extend_from_slice(&ADB_RSA_WORDS.to_le_bytes());
    blob.extend_from_slice(&n0inv.to_le_bytes());
    blob.extend_from_slice(&modulus);
    blob.extend_from_slice(&rr_bytes);
    blob.extend_from_slice(&exponent.to_le_bytes());

    Ok(format!(
        "{} baas-tauri@android\0",
        BASE64_STANDARD.encode(blob)
    ))
}

fn mod_inverse_u32(value: u32) -> Result<u32, String> {
    if value % 2 == 0 {
        return Err("adb auth modulus low word is not odd".to_string());
    }
    let modulus = 1i64 << 32;
    let mut t = 0i64;
    let mut new_t = 1i64;
    let mut r = modulus;
    let mut new_r = i64::from(value);

    while new_r != 0 {
        let quotient = r / new_r;
        (t, new_t) = (new_t, t - quotient * new_t);
        (r, new_r) = (new_r, r - quotient * new_r);
    }

    if r > 1 {
        return Err("adb auth modulus low word is not invertible".to_string());
    }
    if t < 0 {
        t += modulus;
    }
    Ok(t as u32)
}

fn adb_connect(serial: &str) -> Result<TcpStream, String> {
    adb_connect_with_timeout(serial, ANDROID_ADBD_AUTH_TIMEOUT)
}

fn adb_connect_with_timeout(serial: &str, io_timeout: Duration) -> Result<TcpStream, String> {
    let (host, port) = parse_adbd_serial(serial)?;
    let mut addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("invalid adbd address {serial}: {error}"))?;
    let addr = addrs
        .next()
        .ok_or_else(|| format!("invalid adbd address {serial}: no socket address"))?;
    let stream = TcpStream::connect_timeout(&addr, ANDROID_ADBD_CONNECT_TIMEOUT)
        .map_err(|error| format!("failed to connect adbd at {host}:{port}: {error}"))?;
    stream
        .set_read_timeout(Some(io_timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(io_timeout))
        .map_err(|error| error.to_string())?;
    Ok(stream)
}

fn parse_adbd_serial(serial: &str) -> Result<(String, u16), String> {
    let serial = serial.trim();
    let (host, port) = serial
        .rsplit_once(':')
        .ok_or_else(|| format!("embedded adbd serial must be host:port, got {serial}"))?;
    let port = port
        .parse::<u16>()
        .map_err(|error| format!("invalid adbd port in {serial}: {error}"))?;
    if host.trim().is_empty() {
        return Err(format!("invalid adbd host in {serial}"));
    }
    Ok((host.to_string(), port))
}

fn adb_command_to_u32(command: [u8; 4]) -> u32 {
    u32::from_le_bytes(command)
}

fn adb_write_packet(
    stream: &mut TcpStream,
    command: [u8; 4],
    arg0: u32,
    arg1: u32,
    payload: &[u8],
) -> Result<(), String> {
    let command_u32 = adb_command_to_u32(command);
    let checksum = payload
        .iter()
        .fold(0u32, |sum, byte| sum.wrapping_add(*byte as u32));
    let mut header = Vec::with_capacity(24);
    for value in [
        command_u32,
        arg0,
        arg1,
        payload.len() as u32,
        checksum,
        command_u32 ^ 0xffff_ffff,
    ] {
        header.extend_from_slice(&value.to_le_bytes());
    }
    stream
        .write_all(&header)
        .map_err(|error| error.to_string())?;
    stream
        .write_all(payload)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn adb_read_packet(stream: &mut TcpStream) -> Result<AdbPacket, String> {
    let mut header = [0u8; 24];
    stream
        .read_exact(&mut header)
        .map_err(|error| format_adb_read_error("header", error))?;
    let command = [header[0], header[1], header[2], header[3]];
    let command_u32 = u32::from_le_bytes(command);
    let arg0 = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    let arg1 = u32::from_le_bytes([header[8], header[9], header[10], header[11]]);
    let payload_len = u32::from_le_bytes([header[12], header[13], header[14], header[15]]) as usize;
    let checksum = u32::from_le_bytes([header[16], header[17], header[18], header[19]]);
    let magic = u32::from_le_bytes([header[20], header[21], header[22], header[23]]);
    if magic != (command_u32 ^ 0xffff_ffff) {
        return Err(format!(
            "invalid adb packet magic for {}",
            String::from_utf8_lossy(&command)
        ));
    }
    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 {
        stream
            .read_exact(&mut payload)
            .map_err(|error| format_adb_read_error("payload", error))?;
    }
    let actual_checksum = payload
        .iter()
        .fold(0u32, |sum, byte| sum.wrapping_add(*byte as u32));
    if actual_checksum != checksum {
        return Err(format!(
            "invalid adb packet checksum for {}",
            String::from_utf8_lossy(&command)
        ));
    }
    Ok(AdbPacket {
        command,
        arg0,
        arg1,
        payload,
    })
}

fn format_adb_read_error(part: &str, error: std::io::Error) -> String {
    match error.kind() {
        ErrorKind::WouldBlock | ErrorKind::TimedOut => format!(
            "timed out waiting for adb packet {part} after {}s. If Android shows a USB debugging prompt for baas-tauri@android, approve it and retry.",
            ANDROID_ADBD_AUTH_TIMEOUT.as_secs()
        ),
        _ => format!("failed to read adb packet {part}: {error}"),
    }
}

/// Performs the updater get startup state operation.
#[tauri::command]
pub fn updater_get_startup_state(app: AppHandle) -> Result<Value, String> {
    system_log(
        "DEBUG",
        "updater",
        "Android updater startup state requested",
    );
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
    system_log(
        "INFO",
        "updater",
        format!(
            "Android updater config change requested channel={:?} no_update={:?} cdk_present={}",
            request.channel,
            request.no_update,
            request
                .mirrorc_cdk
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
        ),
    );
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
    system_log(
        "DEBUG",
        "updater",
        format!(
            "Android backend version check requested channel={:?}",
            request.channel
        ),
    );
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
    system_log(
        "INFO",
        "updater",
        "Android SHA connectivity tests requested",
    );
    let root = android_storage_root(&app)?;
    let setup_path = ensure_android_setup_toml(&root)?;
    let channel = android_requested_channel(request.channel.as_deref(), &setup_path)?;
    let timeout = sha_test_timeout(request.timeout);
    let mut tasks = JoinSet::new();
    for (order, (name, url)) in android_sha_method_sources(channel).into_iter().enumerate() {
        let root = root.clone();
        tasks.spawn(run_android_sha_probe(
            root,
            channel,
            name,
            order as i32,
            url,
            timeout,
        ));
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
    system_log(
        "DEBUG",
        "updater",
        format!(
            "Android SHA connectivity test requested method={}",
            request.method
        ),
    );
    let root = android_storage_root(&app)?;
    let setup_path = ensure_android_setup_toml(&root)?;
    let channel = android_requested_channel(request.channel.as_deref(), &setup_path)?;
    let timeout = sha_test_timeout(request.timeout);
    let name = request.method.trim().to_string();
    let (order, url) = android_sha_method_sources(channel)
        .into_iter()
        .enumerate()
        .find(|(_, (method, _))| method == &name)
        .map(|(index, (_, url))| (index as i32, url))
        .unwrap_or((-1, None));
    Ok(run_android_sha_probe(root, channel, name, order, url, timeout).await)
}

/// Performs the updater start workflow operation.
#[tauri::command]
pub fn updater_start_workflow(
    app: AppHandle,
    request: UpdaterWorkflowRequest,
    manager: State<'_, AndroidUpdaterTermManager>,
) -> Result<Value, String> {
    system_log(
        "INFO",
        "updater",
        format!(
            "Android updater workflow requested launch={:?}",
            request.launch
        ),
    );
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
    system_log(
        "WARNING",
        "backend_auth",
        "Android backend authentication reset requested",
    );
    restart_android_backend_service()?;
    Ok(json!({
        "base_backend_addr": "127.0.0.1",
        "base_backend_port": 8190,
        "restarted": false,
        "restart_deferred": true
    }))
}

/// Android always uses its loopback WebSocket transport.
#[tauri::command]
pub fn backend_transport_start(mode: String) -> Result<Value, String> {
    if mode != "websocket" {
        return Err("Named pipe transport is unavailable on Android".to_string());
    }
    Ok(serde_json::json!({
        "baseBackendAddr": "127.0.0.1",
        "baseBackendPort": 8190,
    }))
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
    order: i32,
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
                    "order": order,
                    "duration": start.elapsed().as_secs_f64(),
                    "value": value,
                    "error": null
                }),
                Err(error) => json!({
                    "success": false,
                    "name": worker_name,
                    "order": -1,
                    "duration": start.elapsed().as_secs_f64(),
                    "value": null,
                    "error": error.message()
                }),
            }
        }
        None => json!({
            "success": false,
            "name": worker_name,
            "order": -1,
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
            "order": -1,
            "duration": start.elapsed().as_secs_f64(),
            "value": null,
            "error": error.to_string()
        }),
        Err(_) => json!({
            "success": false,
            "name": name,
            "order": -1,
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
        .unwrap_or("auto");
    let runtime_path = request
        .and_then(|request| request.runtime_path.as_deref())
        .unwrap_or("embedded-python-3.9");

    json!({
        "general": {
            "transport": "websocket",
            "channel": channel,
            "mirrorc_cdk": mirrorc_cdk,
            "no_update": no_update,
            "launch": true,
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
            "backend_install_source": "apk_bundle",
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
    let git_backend = request.git_backend.as_deref().unwrap_or("auto");
    let _requested_transport = request.transport.as_deref().unwrap_or("websocket");
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
         transport = \"websocket\"\n\
         mirrorc_cdk = \"{}\"\n\
         channel = \"{}\"\n\
         current_baas_sha = \"{}\"\n\
         current_baas_cpp_sha = \"{}\"\n\
         get_remote_sha_method = \"{}\"\n\
         launch = true\n\
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
        git_backend: Some("auto".to_string()),
        transport: Some("websocket".to_string()),
    };
    fs::write(
        &setup_path,
        mobile_setup_toml(&root, &request, "", "", "github"),
    )
    .map_err(|error| error.to_string())?;
    Ok(setup_path)
}

/// Verifies the Chaquopy backend after an Android update without killing it.
fn restart_android_backend_service() -> Result<(), String> {
    let response = minreq::get("http://127.0.0.1:8190/health")
        .with_timeout(5)
        .send()
        .map_err(|error| format!("failed to contact Android backend after update: {error}"))?;
    if (200..300).contains(&response.status_code) {
        return Ok(());
    }
    Err(format!(
        "Android backend health check returned HTTP {}: {}",
        response.status_code,
        response.as_str().unwrap_or("")
    ))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Handles the android setup keeps backend launch enabled workflow.
    #[test]
    fn android_setup_keeps_backend_launch_enabled() {
        let root = Path::new("/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri");
        let request = UpdaterConfigUpdateRequest {
            baas_root_path: Some(root.to_path_buf()),
            mirrorc_cdk: None,
            channel: Some("dev".to_string()),
            runtime_path: Some("embedded-python-3.9".to_string()),
            no_update: Some(false),
            git_backend: Some("auto".to_string()),
            transport: Some("websocket".to_string()),
        };

        let setup = mobile_setup_toml(root, &request, "main-sha", "cpp-sha", "github");

        assert!(setup.contains("launch = true"));
        assert!(setup.contains("git_backend = \"auto\""));
        assert!(setup.contains("transport = \"websocket\""));
        assert!(setup.contains("current_baas_sha = \"main-sha\""));
        assert!(setup.contains("current_baas_cpp_sha = \"cpp-sha\""));
    }
}
