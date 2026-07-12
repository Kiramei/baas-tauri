use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    ipc::{Channel, InvokeBody, InvokeResponseBody, Request},
    AppHandle, State,
};
use uuid::Uuid;

const START_TIMEOUT: Duration = Duration::from_secs(3);
const SHM_REGION_BYTES: u32 = 16 * 1024 * 1024;
const WEBVIEW_FRAME_MAGIC: &[u8; 4] = b"BIPC";
const WEBVIEW_FRAME_VERSION: u8 = 1;
const WEBVIEW_FRAME_HEADER_BYTES: usize = 20;
const WEBVIEW_KIND_JSON: u8 = 1;
const WEBVIEW_KIND_BYTES: u8 = 2;
const WEBVIEW_KIND_CLOSE: u8 = 3;
const WEBVIEW_KIND_ERROR: u8 = 4;
const MAX_PENDING_MESSAGES_PER_CHANNEL: usize = 4096;
const MAX_PENDING_REMOTE_MESSAGES: usize = 256;
const MAX_PENDING_REMOTE_BYTES: usize = 8 * 1024 * 1024;
const WEBVIEW_REQUEST_MAGIC: &[u8; 4] = b"BIPR";
const WEBVIEW_REQUEST_VERSION: u8 = 1;
const WEBVIEW_REQUEST_HEADER_BYTES: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendIpcStatus {
    pub transport_mode: &'static str,
    pub phase: &'static str,
    pub ipc_instance: Option<String>,
    pub shm_name: Option<String>,
    pub notify_name: Option<String>,
    pub generation_id: Option<String>,
    pub backend_pid: Option<u32>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendIpcMessage {
    pub channel: String,
    pub name: String,
    pub stream_id: u16,
    pub kind: String,
    pub sequence_number: u64,
    pub json: Option<Value>,
    pub bytes: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewCopyBenchmarkRequest {
    pub payload_size: usize,
    pub iterations: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewCopyBenchmarkResult {
    pub payload_size: usize,
    pub iterations: u32,
    pub rust_emit_ms: f64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewCopyBenchmarkRunConfig {
    pub output_path: String,
    pub payload_sizes: Vec<usize>,
    pub iterations: u32,
    pub timeout_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteE2eBenchmarkRunConfig {
    pub output_path: String,
    pub config_id: String,
    pub duration_ms: u32,
    pub timeout_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportStartupBenchmarkRunConfig {
    pub output_path: String,
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewCopyBenchmarkReport {
    pub success: bool,
    pub results: Option<Value>,
    pub error: Option<String>,
}

struct BackendIpcRun {
    ipc_instance: String,
    shm_name: String,
    rust_to_python_notify_name: String,
    python_to_rust_notify_name: String,
    generation_id: Uuid,
    backend_pid: u32,
    region: baas_ipc::native::SharedMemoryRegion,
    rust_to_python_event: baas_ipc::native::NotificationEvent,
    child: Child,
    pid_file: PathBuf,
    next_sequence: u64,
    next_stream_id: u16,
    connection_streams: HashMap<String, u16>,
    stream_names: HashMap<(u16, u16), String>,
    pending_messages: HashMap<String, Vec<BackendIpcMessage>>,
    subscribers: HashMap<String, Vec<Channel<InvokeResponseBody>>>,
    reader_started: bool,
}

#[derive(Default)]
struct BackendIpcState {
    run: Option<BackendIpcRun>,
    last_failure: Option<String>,
}

/// Owns the Rust-side client IPC lifecycle. The native shared-memory data plane
/// is still attached in a later step; this manager already owns backend launch
/// metadata and prevents any WebSocket fallback in client mode.
#[derive(Default)]
pub struct BackendIpcManager {
    inner: Arc<Mutex<BackendIpcState>>,
}

impl BackendIpcManager {
    fn status_for_state(state: &BackendIpcState) -> BackendIpcStatus {
        if let Some(run) = &state.run {
            BackendIpcStatus {
                transport_mode: "shared-memory",
                phase: "ready",
                ipc_instance: Some(run.ipc_instance.clone()),
                shm_name: Some(run.shm_name.clone()),
                notify_name: Some(run.rust_to_python_notify_name.clone()),
                generation_id: Some(run.generation_id.to_string()),
                backend_pid: Some(run.backend_pid),
                message: Some("shared-memory backend process is running".to_string()),
            }
        } else {
            BackendIpcStatus {
                transport_mode: "shared-memory",
                phase: if state.last_failure.is_some() {
                    "failed"
                } else {
                    "idle"
                },
                ipc_instance: None,
                shm_name: None,
                notify_name: None,
                generation_id: None,
                backend_pid: None,
                message: state.last_failure.clone(),
            }
        }
    }

    fn close_locked(state: &mut BackendIpcState) {
        if let Some(mut run) = state.run.take() {
            let _ = run.child.kill();
            let _ = run.child.wait();
            let _ = std::fs::remove_file(&run.pid_file);
        }
    }
}

impl Drop for BackendIpcManager {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.lock() {
            Self::close_locked(&mut state);
        }
    }
}

#[cfg(not(mobile))]
#[tauri::command]
pub async fn backend_ipc_start(
    app: AppHandle,
    manager: State<'_, BackendIpcManager>,
    backend: State<'_, crate::commands::BackendProcessManager>,
) -> Result<BackendIpcStatus, String> {
    use crate::commands::updater_get_startup_state;
    use baas_ipc::{
        native::{NativeIpcError, NotificationEvent, SharedMemoryRegion},
        protocol::PROTOCOL_VERSION,
    };
    use baas_updater::environ::{
        backend_pid_path, launch_backend_command_with_options, BackendLaunchOptions,
        BackendTransportMode,
    };

    let startup = updater_get_startup_state(app)?;
    if !startup.baas_root_exists_non_empty {
        return Err("BackendLaunchFailed: BAAS backend is not installed".to_string());
    }
    backend.stop_for_config(&startup.config)?;

    let generation_id = Uuid::new_v4();
    let ipc_instance = format!("baas-ipc-{}-{}", std::process::id(), generation_id);
    let shm_name = platform_resource_name("shm", &generation_id);
    let rust_to_python_notify_name = platform_resource_name("r2p-notify", &generation_id);
    let python_to_rust_notify_name = platform_resource_name("p2r-notify", &generation_id);
    let mut region = SharedMemoryRegion::create(&shm_name, SHM_REGION_BYTES as usize)
        .map_err(|error| format!("TransportUnavailable: {error}"))?;
    let rust_to_python_event = NotificationEvent::create(&rust_to_python_notify_name)
        .map_err(|error| format!("TransportUnavailable: {error}"))?;
    let python_to_rust_event = NotificationEvent::create(&python_to_rust_notify_name)
        .map_err(|error| format!("TransportUnavailable: {error}"))?;
    initialize_shared_memory_header(&mut region, generation_id, std::process::id())?;

    let options = BackendLaunchOptions {
        transport: BackendTransportMode::SharedMemory {
            ipc_instance: ipc_instance.clone(),
            parent_pid: std::process::id(),
            shm_name: Some(shm_name.clone()),
            notify_name: None,
            rust_to_python_notify_name: Some(rust_to_python_notify_name.clone()),
            python_to_rust_notify_name: Some(python_to_rust_notify_name.clone()),
            protocol_version: PROTOCOL_VERSION,
        },
        no_ocr_update_check: true,
    };
    let command = launch_backend_command_with_options(&startup.config, &options);
    let pid_file = command
        .detached_pid_file
        .clone()
        .unwrap_or_else(|| backend_pid_path(&startup.config));

    {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
        BackendIpcManager::close_locked(&mut state);
    }

    let mut process = Command::new(&command.program);
    process.args(&command.args);
    if let Some(cwd) = &command.cwd {
        process.current_dir(cwd);
    }
    for (key, value) in &command.env {
        process.env(key, value);
    }
    process
        .env("BAAS_IPC_REGION_BYTES", SHM_REGION_BYTES.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }

    let mut child = process
        .spawn()
        .map_err(|error| format!("BackendLaunchFailed: {error}"))?;
    let backend_pid = child.id();
    if let Some(parent) = pid_file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("BackendLaunchFailed: {error}"))?;
    }
    std::fs::write(&pid_file, backend_pid.to_string())
        .map_err(|error| format!("BackendLaunchFailed: {error}"))?;

    let started = Instant::now();
    loop {
        match python_to_rust_event.wait(Duration::from_millis(50)) {
            Ok(()) => {
                let header = read_shared_memory_header(&region)?;
                if let Err(message) = require_backend_lifecycle_ready(&header) {
                    let mut state = manager.inner.lock().map_err(|_| {
                        "BackendInitializationFailed: backend IPC state lock poisoned"
                    })?;
                    state.last_failure = Some(message.clone());
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(&pid_file);
                    return Err(message);
                }
                let mut state = manager
                    .inner
                    .lock()
                    .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
                state.last_failure = None;
                state.run = Some(BackendIpcRun {
                    ipc_instance,
                    shm_name,
                    rust_to_python_notify_name,
                    python_to_rust_notify_name,
                    generation_id,
                    backend_pid,
                    region,
                    rust_to_python_event,
                    child,
                    pid_file,
                    next_sequence: 1,
                    next_stream_id: 1,
                    connection_streams: HashMap::new(),
                    stream_names: HashMap::new(),
                    pending_messages: HashMap::new(),
                    subscribers: HashMap::new(),
                    reader_started: false,
                });
                return Ok(BackendIpcStatus {
                    transport_mode: "shared-memory",
                    phase: "ready",
                    ipc_instance: state.run.as_ref().map(|run| run.ipc_instance.clone()),
                    shm_name: state.run.as_ref().map(|run| run.shm_name.clone()),
                    notify_name: state
                        .run
                        .as_ref()
                        .map(|run| run.rust_to_python_notify_name.clone()),
                    generation_id: Some(generation_id.to_string()),
                    backend_pid: Some(header.peer_pid),
                    message: None,
                });
            }
            Err(NativeIpcError::TimedOut) => {}
            Err(error) => {
                let message =
                    format!("BackendInitializationFailed: notification wait failed: {error}");
                let mut state = manager
                    .inner
                    .lock()
                    .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
                state.last_failure = Some(message.clone());
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&pid_file);
                return Err(message);
            }
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("BackendInitializationFailed: {error}"))?
        {
            let output = read_child_output(&mut child);
            let message = format!(
                "BackendInitializationFailed: shared-memory backend exited with status {status}; {output}"
            );
            let mut state = manager
                .inner
                .lock()
                .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
            state.last_failure = Some(message.clone());
            let _ = std::fs::remove_file(&pid_file);
            return Err(message);
        }
        if started.elapsed() >= START_TIMEOUT {
            break;
        }
    }

    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
    state.run = Some(BackendIpcRun {
        ipc_instance,
        shm_name,
        rust_to_python_notify_name,
        python_to_rust_notify_name,
        generation_id,
        backend_pid,
        region,
        rust_to_python_event,
        child,
        pid_file,
        next_sequence: 1,
        next_stream_id: 1,
        connection_streams: HashMap::new(),
        stream_names: HashMap::new(),
        pending_messages: HashMap::new(),
        subscribers: HashMap::new(),
        reader_started: false,
    });
    state.last_failure = Some(
        "BackendInitializationFailed: native shared-memory readiness is not implemented in this build"
            .to_string(),
    );
    BackendIpcManager::close_locked(&mut state);
    Err(state.last_failure.clone().unwrap_or_else(|| {
        "BackendInitializationFailed: native shared-memory readiness is not implemented".to_string()
    }))
}

#[cfg(mobile)]
#[tauri::command]
pub async fn backend_ipc_start(
    _app: AppHandle,
    manager: State<'_, BackendIpcManager>,
) -> Result<BackendIpcStatus, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
    BackendIpcManager::close_locked(&mut state);
    state.last_failure =
        Some("UnsupportedTransport: mobile shared-memory adapter is not implemented".to_string());
    Err(state.last_failure.clone().unwrap())
}

#[tauri::command]
pub async fn backend_ipc_close(
    manager: State<'_, BackendIpcManager>,
) -> Result<BackendIpcStatus, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
    BackendIpcManager::close_locked(&mut state);
    Ok(BackendIpcManager::status_for_state(&state))
}

#[tauri::command]
pub async fn backend_ipc_open_channel(
    manager: State<'_, BackendIpcManager>,
    channel: String,
    name: String,
) -> Result<(), String> {
    let payload = serde_json::to_vec(&serde_json::json!({ "name": name }))
        .map_err(|error| error.to_string())?;
    write_backend_frame(
        &manager,
        &channel,
        Some(&name),
        baas_ipc::protocol::MESSAGE_KIND_OPEN_CHANNEL,
        payload,
    )
}

#[tauri::command]
pub async fn backend_ipc_close_channel(
    manager: State<'_, BackendIpcManager>,
    channel: String,
    name: Option<String>,
) -> Result<(), String> {
    let key = connection_key(&channel, name.as_deref());
    let is_open = {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
        if let Some(run) = state.run.as_mut() {
            let is_open = run.connection_streams.contains_key(&key);
            run.subscribers.remove(&key);
            run.pending_messages.remove(&key);
            is_open
        } else {
            false
        }
    };
    if !is_open {
        return Ok(());
    }
    write_backend_frame(
        &manager,
        &channel,
        name.as_deref(),
        baas_ipc::protocol::MESSAGE_KIND_CLOSE_CHANNEL,
        Vec::new(),
    )
}

#[tauri::command]
pub async fn backend_ipc_send_json(
    manager: State<'_, BackendIpcManager>,
    channel: String,
    name: Option<String>,
    payload: Value,
) -> Result<(), String> {
    let payload = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    write_backend_frame(
        &manager,
        &channel,
        name.as_deref(),
        baas_ipc::protocol::MESSAGE_KIND_JSON,
        payload,
    )
}

#[cfg(not(mobile))]
#[tauri::command]
pub async fn backend_ipc_send_bytes(
    manager: State<'_, BackendIpcManager>,
    request: Request<'_>,
) -> Result<(), String> {
    let raw = match request.body() {
        InvokeBody::Raw(raw) => raw,
        InvokeBody::Json(_) => {
            return Err("SharedMemoryCorrupted: binary IPC command requires a raw body".to_string())
        }
    };
    let (channel, name, payload) = decode_webview_binary_request(raw)?;
    write_backend_frame(
        &manager,
        channel,
        Some(name),
        baas_ipc::protocol::MESSAGE_KIND_BYTES,
        payload.to_vec(),
    )
}

#[cfg(mobile)]
#[tauri::command]
pub async fn backend_ipc_send_bytes(
    _manager: State<'_, BackendIpcManager>,
    _payload: Vec<u8>,
) -> Result<(), String> {
    Err("UnsupportedTransport: mobile shared-memory adapter is not implemented".to_string())
}

#[tauri::command]
pub async fn backend_ipc_subscribe(
    manager: State<'_, BackendIpcManager>,
    channel: String,
    name: Option<String>,
    on_message: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let key = connection_key(&channel, name.as_deref());
    {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
        drain_backend_messages_locked(&mut state)?;
        let last_failure = state.last_failure.clone();
        let run = state.run.as_mut().ok_or_else(|| {
            last_failure.unwrap_or_else(|| {
                "TransportUnavailable: shared-memory backend is not ready; WebSocket fallback is disabled"
                    .to_string()
            })
        })?;
        run.subscribers.insert(key.clone(), vec![on_message]);
        flush_pending_messages_for_key(run, &key);
        if run.reader_started {
            return Ok(());
        }
        run.reader_started = true;
    }

    start_backend_reader(manager.inner.clone());
    Ok(())
}

#[tauri::command]
pub async fn backend_ipc_recv(
    manager: State<'_, BackendIpcManager>,
    channel: String,
    name: Option<String>,
) -> Result<Vec<BackendIpcMessage>, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
    drain_backend_messages_locked(&mut state)?;
    let key = connection_key(&channel, name.as_deref());
    Ok(state
        .run
        .as_mut()
        .and_then(|run| run.pending_messages.remove(&key))
        .unwrap_or_default())
}

#[tauri::command]
pub async fn backend_ipc_benchmark_webview_copy(
    request: WebviewCopyBenchmarkRequest,
    on_message: Channel<InvokeResponseBody>,
) -> Result<WebviewCopyBenchmarkResult, String> {
    if request.iterations == 0 || request.iterations > 10_000 {
        return Err(
            "MessageTooLarge: benchmark iterations must be between 1 and 10000".to_string(),
        );
    }
    if request.payload_size == 0 || request.payload_size > 16 * 1024 * 1024 {
        return Err(
            "MessageTooLarge: benchmark payload size must be between 1 byte and 16 MiB".to_string(),
        );
    }

    let payload = vec![0xA5; request.payload_size];
    let started = Instant::now();
    for _ in 0..request.iterations {
        on_message
            .send(InvokeResponseBody::Raw(payload.clone()))
            .map_err(|error| format!("ChannelClosed: benchmark channel send failed: {error}"))?;
    }
    Ok(WebviewCopyBenchmarkResult {
        payload_size: request.payload_size,
        iterations: request.iterations,
        rust_emit_ms: started.elapsed().as_secs_f64() * 1000.0,
        total_bytes: request.payload_size as u64 * u64::from(request.iterations),
    })
}

#[tauri::command]
pub async fn backend_ipc_webview_benchmark_config(
) -> Result<Option<WebviewCopyBenchmarkRunConfig>, String> {
    let output_path = match std::env::var("BAAS_WEBVIEW_COPY_BENCHMARK_OUT") {
        Ok(path) if !path.trim().is_empty() => path,
        _ => return Ok(None),
    };
    let payload_sizes =
        parse_benchmark_sizes(std::env::var("BAAS_WEBVIEW_COPY_BENCHMARK_SIZES").ok())?;
    let iterations = parse_benchmark_u32(
        "BAAS_WEBVIEW_COPY_BENCHMARK_ITERATIONS",
        std::env::var("BAAS_WEBVIEW_COPY_BENCHMARK_ITERATIONS").ok(),
        60,
        1,
        10_000,
    )?;
    let timeout_ms = parse_benchmark_u32(
        "BAAS_WEBVIEW_COPY_BENCHMARK_TIMEOUT_MS",
        std::env::var("BAAS_WEBVIEW_COPY_BENCHMARK_TIMEOUT_MS").ok(),
        30_000,
        1_000,
        600_000,
    )?;
    Ok(Some(WebviewCopyBenchmarkRunConfig {
        output_path,
        payload_sizes,
        iterations,
        timeout_ms,
    }))
}

#[tauri::command]
pub async fn backend_ipc_remote_benchmark_config(
) -> Result<Option<RemoteE2eBenchmarkRunConfig>, String> {
    let output_path = match std::env::var("BAAS_REMOTE_E2E_BENCHMARK_OUT") {
        Ok(path) if !path.trim().is_empty() => path,
        _ => return Ok(None),
    };
    let config_id = std::env::var("BAAS_REMOTE_E2E_CONFIG_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "default_config".to_string());
    let duration_ms = parse_benchmark_u32(
        "BAAS_REMOTE_E2E_DURATION_MS",
        std::env::var("BAAS_REMOTE_E2E_DURATION_MS").ok(),
        5_000,
        500,
        120_000,
    )?;
    let timeout_ms = parse_benchmark_u32(
        "BAAS_REMOTE_E2E_TIMEOUT_MS",
        std::env::var("BAAS_REMOTE_E2E_TIMEOUT_MS").ok(),
        60_000,
        5_000,
        300_000,
    )?;
    Ok(Some(RemoteE2eBenchmarkRunConfig {
        output_path,
        config_id,
        duration_ms,
        timeout_ms,
    }))
}

#[tauri::command]
pub async fn backend_transport_startup_benchmark_config(
) -> Result<Option<TransportStartupBenchmarkRunConfig>, String> {
    let output_path = match std::env::var("BAAS_TRANSPORT_STARTUP_BENCHMARK_OUT") {
        Ok(path) if !path.trim().is_empty() => path,
        _ => return Ok(None),
    };
    let mode = std::env::var("BAAS_TRANSPORT_STARTUP_MODE")
        .unwrap_or_else(|_| "shared-memory".to_string());
    if mode != "shared-memory" && mode != "websocket" {
        return Err(format!(
            "UnsupportedTransport: invalid benchmark mode {mode}"
        ));
    }
    Ok(Some(TransportStartupBenchmarkRunConfig {
        output_path,
        mode,
    }))
}

#[tauri::command]
pub async fn backend_ipc_finish_webview_benchmark(
    app: AppHandle,
    report: WebviewCopyBenchmarkReport,
) -> Result<(), String> {
    let output_path = std::env::var("BAAS_WEBVIEW_COPY_BENCHMARK_OUT")
        .or_else(|_| std::env::var("BAAS_REMOTE_E2E_BENCHMARK_OUT"))
        .or_else(|_| std::env::var("BAAS_TRANSPORT_STARTUP_BENCHMARK_OUT"))
        .map_err(|_| "BenchmarkUnavailable: output path is not configured".to_string())?;
    let path = PathBuf::from(output_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("BenchmarkWriteFailed: {error}"))?;
    }
    let body = serde_json::to_string_pretty(&report)
        .map_err(|error| format!("BenchmarkWriteFailed: {error}"))?;
    std::fs::write(&path, body).map_err(|error| format!("BenchmarkWriteFailed: {error}"))?;
    app.exit(if report.success { 0 } else { 1 });
    Ok(())
}

fn write_backend_frame(
    manager: &BackendIpcManager,
    channel: &str,
    name: Option<&str>,
    message_kind: u16,
    payload: Vec<u8>,
) -> Result<(), String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "BackendInitializationFailed: backend IPC state lock poisoned")?;
    let last_failure = state.last_failure.clone();
    let run = state.run.as_mut().ok_or_else(|| {
        last_failure.unwrap_or_else(|| {
            "TransportUnavailable: shared-memory backend is not ready; WebSocket fallback is disabled"
                .to_string()
        })
    })?;
    let channel_id = baas_ipc::protocol::logical_channel_id(channel)
        .map_err(|error| format!("UnsupportedTransport: {error}"))?;
    let stream_id = resolve_stream_id(run, channel_id, channel, name, message_kind)?;
    let header = read_shared_memory_header(&run.region)?;
    require_backend_lifecycle_ready(&header)?;
    let sequence_number = run.next_sequence;
    run.next_sequence = run.next_sequence.wrapping_add(1).max(1);
    let frames = baas_ipc::protocol::fragment_payload(
        channel_id,
        stream_id,
        message_kind,
        0,
        sequence_number,
        0,
        &payload,
        (baas_ipc::protocol::MAX_FRAME_LENGTH as usize).min(64 * 1024),
    )
    .map_err(|error| format!("MessageTooLarge: {error}"))?;
    let start = header.rust_to_python_ring_offset as usize;
    let end = start + header.rust_to_python_ring_length as usize;
    let region = run.region.as_mut_slice();
    if end > region.len() {
        return Err("SharedMemoryCorrupted: rust_to_python ring is out of bounds".to_string());
    }
    let mut ring = baas_ipc::ring_buffer::SharedRingBuffer::open(&mut region[start..end])
        .map_err(|error| format!("SharedMemoryCorrupted: {error}"))?;
    for frame in frames {
        ring.write_frame(&frame)
            .map_err(|error| format!("SharedMemoryQueueFull: {error}"))?;
    }
    run.rust_to_python_event
        .set()
        .map_err(|error| format!("OperationTimedOut: notification failed: {error}"))?;
    Ok(())
}

fn start_backend_reader(state: Arc<Mutex<BackendIpcState>>) {
    thread::spawn(move || {
        let notify_name = match state.lock() {
            Ok(guard) => guard
                .run
                .as_ref()
                .map(|run| run.python_to_rust_notify_name.clone()),
            Err(_) => None,
        };
        let Some(notify_name) = notify_name else {
            return;
        };
        let notify_event = match baas_ipc::native::NotificationEvent::open(&notify_name) {
            Ok(event) => event,
            Err(error) => {
                if let Ok(mut guard) = state.lock() {
                    guard.last_failure = Some(format!(
                        "TransportUnavailable: Python-to-Rust notification open failed: {error}"
                    ));
                }
                return;
            }
        };

        loop {
            match notify_event.wait(Duration::from_secs(1)) {
                Ok(()) | Err(baas_ipc::native::NativeIpcError::TimedOut) => {}
                Err(error) => {
                    if let Ok(mut guard) = state.lock() {
                        guard.last_failure = Some(format!(
                            "OperationTimedOut: notification wait failed: {error}"
                        ));
                    }
                    return;
                }
            }
            let mut guard = match state.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            if guard.run.is_none() {
                return;
            }
            if let Err(error) = drain_backend_messages_locked(&mut guard) {
                if let Some(run) = guard.run.as_mut() {
                    notify_subscribers_transport_error(run, &error);
                }
                guard.last_failure = Some(error);
                BackendIpcManager::close_locked(&mut guard);
                return;
            }
            if let Some(run) = guard.run.as_mut() {
                flush_all_pending_messages(run);
                if let Some(status) = run.child.try_wait().ok().flatten() {
                    let output = read_child_output(&mut run.child);
                    let message = format!(
                        "BackendExited: shared-memory backend process exited with status {status}; {output}"
                    );
                    notify_subscribers_transport_error(run, &message);
                    guard.last_failure = Some(message);
                    BackendIpcManager::close_locked(&mut guard);
                    return;
                }
            }
        }
    });
}

fn drain_backend_messages_locked(state: &mut BackendIpcState) -> Result<(), String> {
    let run = state.run.as_mut().ok_or_else(|| {
        state.last_failure.clone().unwrap_or_else(|| {
            "TransportUnavailable: shared-memory backend is not ready; WebSocket fallback is disabled"
                .to_string()
        })
    })?;
    let header = read_shared_memory_header(&run.region)?;
    let start = header.python_to_rust_ring_offset as usize;
    let end = start + header.python_to_rust_ring_length as usize;
    if end > run.region.len() {
        return Err("SharedMemoryCorrupted: python_to_rust ring is out of bounds".to_string());
    }
    let frames = {
        let region = run.region.as_mut_slice();
        let mut ring = baas_ipc::ring_buffer::SharedRingBuffer::open(&mut region[start..end])
            .map_err(|error| format!("SharedMemoryCorrupted: {error}"))?;
        let mut frames = Vec::new();
        loop {
            match ring.read_frame(baas_ipc::protocol::MAX_FRAME_LENGTH as usize) {
                Ok(frame) => frames.push(frame),
                Err(baas_ipc::ring_buffer::RingBufferError::NotEnoughData) => break,
                Err(error) => return Err(format!("SharedMemoryCorrupted: {error}")),
            }
        }
        frames
    };
    for frame in frames {
        let message = backend_message_from_frame(frame, &run.stream_names)?;
        queue_pending_message(run, message)?;
    }
    let header = read_shared_memory_header(&run.region)?;
    require_backend_lifecycle_ready(&header)?;
    Ok(())
}

fn queue_pending_message(
    run: &mut BackendIpcRun,
    message: BackendIpcMessage,
) -> Result<(), String> {
    let is_remote = message.channel == "remote";
    let key = connection_key(&message.channel, Some(&message.name));
    let pending = run.pending_messages.entry(key).or_default();
    pending.push(message);
    if !is_remote {
        if pending.len() > MAX_PENDING_MESSAGES_PER_CHANNEL {
            return Err(
                "SharedMemoryQueueFull: reliable WebView IPC queue exceeded its message limit"
                    .to_string(),
            );
        }
        return Ok(());
    }

    while pending.len() > MAX_PENDING_REMOTE_MESSAGES
        || pending
            .iter()
            .filter_map(|item| item.bytes.as_ref())
            .map(Vec::len)
            .sum::<usize>()
            > MAX_PENDING_REMOTE_BYTES
    {
        let Some(index) = pending.iter().position(|item| item.kind == "bytes") else {
            break;
        };
        pending.remove(index);
    }
    if pending.len() > MAX_PENDING_REMOTE_MESSAGES {
        return Err(
            "SharedMemoryQueueFull: reliable remote control queue exceeded its message limit"
                .to_string(),
        );
    }
    Ok(())
}

fn require_backend_lifecycle_ready(
    header: &baas_ipc::protocol::SharedMemoryHeader,
) -> Result<(), String> {
    match header.lifecycle_state {
        baas_ipc::protocol::LIFECYCLE_READY => Ok(()),
        baas_ipc::protocol::LIFECYCLE_STARTING => {
            Err("BackendInitializationFailed: shared-memory backend is still starting".to_string())
        }
        baas_ipc::protocol::LIFECYCLE_STOPPED => {
            Err("BackendExited: shared-memory backend stopped".to_string())
        }
        baas_ipc::protocol::LIFECYCLE_FAILED => Err(
            "BackendInitializationFailed: shared-memory backend entered failed lifecycle state"
                .to_string(),
        ),
        other => Err(format!(
            "SharedMemoryCorrupted: unknown shared-memory lifecycle state {other}"
        )),
    }
}

fn notify_subscribers_transport_error(run: &mut BackendIpcRun, message: &str) {
    let error = BackendIpcMessage {
        channel: "control".to_string(),
        name: "transport".to_string(),
        stream_id: 0,
        kind: "error".to_string(),
        sequence_number: 0,
        json: Some(serde_json::json!({
            "type": "transport_error",
            "error": message,
        })),
        bytes: None,
    };
    for subscribers in run.subscribers.values_mut() {
        subscribers.retain(|subscriber| send_webview_message(subscriber, &error).is_ok());
    }
}

fn flush_all_pending_messages(run: &mut BackendIpcRun) {
    let keys: Vec<String> = run.pending_messages.keys().cloned().collect();
    for key in keys {
        flush_pending_messages_for_key(run, &key);
    }
}

fn flush_pending_messages_for_key(run: &mut BackendIpcRun, key: &str) {
    let Some(messages) = run.pending_messages.remove(key) else {
        return;
    };
    let Some(subscribers) = run.subscribers.get_mut(key) else {
        run.pending_messages.insert(key.to_string(), messages);
        return;
    };
    subscribers.retain(|subscriber| {
        let mut alive = true;
        for message in &messages {
            if send_webview_message(subscriber, message).is_err() {
                alive = false;
                break;
            }
        }
        alive
    });
    if subscribers.is_empty() {
        run.subscribers.remove(key);
    }
}

fn send_webview_message(
    subscriber: &Channel<InvokeResponseBody>,
    message: &BackendIpcMessage,
) -> Result<(), String> {
    subscriber
        .send(InvokeResponseBody::Raw(encode_webview_message(message)?))
        .map_err(|error| format!("ChannelClosed: WebView IPC channel send failed: {error}"))
}

fn encode_webview_message(message: &BackendIpcMessage) -> Result<Vec<u8>, String> {
    let (kind, payload) = match message.kind.as_str() {
        "json" => (
            WEBVIEW_KIND_JSON,
            message
                .json
                .as_ref()
                .map(serde_json::to_vec)
                .transpose()
                .map_err(|error| format!("SharedMemoryCorrupted: JSON encode failed: {error}"))?
                .unwrap_or_default(),
        ),
        "bytes" => (
            WEBVIEW_KIND_BYTES,
            message.bytes.clone().unwrap_or_default(),
        ),
        "close" => (WEBVIEW_KIND_CLOSE, Vec::new()),
        "error" => (
            WEBVIEW_KIND_ERROR,
            message
                .json
                .as_ref()
                .map(serde_json::to_vec)
                .transpose()
                .map_err(|error| {
                    format!("SharedMemoryCorrupted: error JSON encode failed: {error}")
                })?
                .unwrap_or_default(),
        ),
        _ => (
            WEBVIEW_KIND_ERROR,
            b"{\"error\":\"unknown IPC message kind\"}".to_vec(),
        ),
    };
    let mut frame = Vec::with_capacity(WEBVIEW_FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(WEBVIEW_FRAME_MAGIC);
    frame.push(WEBVIEW_FRAME_VERSION);
    frame.push(kind);
    frame.extend_from_slice(&message.stream_id.to_le_bytes());
    frame.extend_from_slice(&message.sequence_number.to_le_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

fn decode_webview_binary_request(raw: &[u8]) -> Result<(&str, &str, &[u8]), String> {
    if raw.len() < WEBVIEW_REQUEST_HEADER_BYTES {
        return Err("SharedMemoryCorrupted: truncated WebView binary request".to_string());
    }
    if &raw[..4] != WEBVIEW_REQUEST_MAGIC {
        return Err("SharedMemoryCorrupted: invalid WebView binary request magic".to_string());
    }
    if raw[4] != WEBVIEW_REQUEST_VERSION {
        return Err(format!(
            "ProtocolVersionMismatch: unsupported WebView binary request version {}",
            raw[4]
        ));
    }
    let channel = baas_ipc::protocol::logical_channel_name(u16::from(raw[5]))
        .map_err(|error| format!("SharedMemoryCorrupted: {error}"))?;
    let name_length = u16::from_le_bytes([raw[6], raw[7]]) as usize;
    let name_end = WEBVIEW_REQUEST_HEADER_BYTES
        .checked_add(name_length)
        .ok_or_else(|| {
            "SharedMemoryCorrupted: WebView binary request length overflow".to_string()
        })?;
    if name_end > raw.len() {
        return Err("SharedMemoryCorrupted: truncated WebView binary request name".to_string());
    }
    let name = std::str::from_utf8(&raw[WEBVIEW_REQUEST_HEADER_BYTES..name_end])
        .map_err(|error| format!("SharedMemoryCorrupted: request name is not UTF-8: {error}"))?;
    Ok((channel, name, &raw[name_end..]))
}

fn backend_message_from_frame(
    frame: baas_ipc::protocol::EncodedFrame,
    stream_names: &HashMap<(u16, u16), String>,
) -> Result<BackendIpcMessage, String> {
    let channel = baas_ipc::protocol::logical_channel_name(frame.header.logical_channel_id)
        .map_err(|error| format!("SharedMemoryCorrupted: {error}"))?
        .to_string();
    let name = stream_names
        .get(&(frame.header.logical_channel_id, frame.header.stream_id))
        .cloned()
        .unwrap_or_else(|| channel.clone());
    let kind = match frame.header.message_kind {
        baas_ipc::protocol::MESSAGE_KIND_JSON => "json",
        baas_ipc::protocol::MESSAGE_KIND_BYTES => "bytes",
        baas_ipc::protocol::MESSAGE_KIND_CLOSE_CHANNEL => "close",
        baas_ipc::protocol::MESSAGE_KIND_ERROR => "error",
        other => {
            return Err(format!(
                "SharedMemoryCorrupted: unsupported inbound message kind {other}"
            ))
        }
    };
    let (json, bytes) = match frame.header.message_kind {
        baas_ipc::protocol::MESSAGE_KIND_JSON | baas_ipc::protocol::MESSAGE_KIND_ERROR => (
            Some(serde_json::from_slice(&frame.payload).map_err(|error| {
                format!("SharedMemoryCorrupted: invalid JSON payload: {error}")
            })?),
            None,
        ),
        baas_ipc::protocol::MESSAGE_KIND_BYTES => (None, Some(frame.payload)),
        _ => (None, None),
    };
    Ok(BackendIpcMessage {
        channel,
        name,
        stream_id: frame.header.stream_id,
        kind: kind.to_string(),
        sequence_number: frame.header.sequence_number,
        json,
        bytes,
    })
}

fn resolve_stream_id(
    run: &mut BackendIpcRun,
    channel_id: u16,
    channel: &str,
    name: Option<&str>,
    message_kind: u16,
) -> Result<u16, String> {
    let key = connection_key(channel, name);
    if let Some(stream_id) = run.connection_streams.get(&key) {
        return Ok(*stream_id);
    }
    if message_kind != baas_ipc::protocol::MESSAGE_KIND_OPEN_CHANNEL {
        return Err(format!(
            "ChannelClosed: shared-memory channel is not open: {key}"
        ));
    }
    let stream_id = if name.unwrap_or(channel) == channel {
        0
    } else {
        allocate_stream_id(run)
    };
    run.connection_streams.insert(key, stream_id);
    run.stream_names
        .insert((channel_id, stream_id), name.unwrap_or(channel).to_string());
    Ok(stream_id)
}

fn allocate_stream_id(run: &mut BackendIpcRun) -> u16 {
    let selected = run.next_stream_id.max(1);
    run.next_stream_id = run.next_stream_id.wrapping_add(1).max(1);
    selected
}

fn connection_key(channel: &str, name: Option<&str>) -> String {
    let name = name.unwrap_or(channel);
    format!("{channel}\u{1f}{name}")
}

fn read_child_output(child: &mut Child) -> String {
    let mut chunks = Vec::new();
    if let Some(stdout) = child.stdout.as_mut() {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        if !text.trim().is_empty() {
            chunks.push(format!("stdout: {}", text.trim()));
        }
    }
    if let Some(stderr) = child.stderr.as_mut() {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        if !text.trim().is_empty() {
            chunks.push(format!("stderr: {}", text.trim()));
        }
    }
    if chunks.is_empty() {
        "no backend output captured".to_string()
    } else {
        chunks.join("; ")
    }
}

fn initialize_shared_memory_header(
    region: &mut baas_ipc::native::SharedMemoryRegion,
    generation_id: Uuid,
    owner_pid: u32,
) -> Result<(), String> {
    let generation = generation_id.as_u128();
    let data_offset = 128_u32;
    let ring_length = (SHM_REGION_BYTES - data_offset) / 2;
    let header = baas_ipc::protocol::SharedMemoryHeader {
        magic: baas_ipc::protocol::MAGIC,
        protocol_version: baas_ipc::protocol::PROTOCOL_VERSION,
        abi_version: baas_ipc::protocol::ABI_VERSION,
        header_size: baas_ipc::protocol::SHARED_MEMORY_HEADER_LEN as u32,
        total_size: SHM_REGION_BYTES,
        generation_id_low: generation as u64,
        generation_id_high: (generation >> 64) as u64,
        owner_pid,
        peer_pid: 0,
        lifecycle_state: baas_ipc::protocol::LIFECYCLE_STARTING,
        last_error_code: 0,
        owner_heartbeat_ns: 0,
        peer_heartbeat_ns: 0,
        rust_to_python_ring_offset: data_offset,
        rust_to_python_ring_length: ring_length,
        python_to_rust_ring_offset: data_offset + ring_length,
        python_to_rust_ring_length: ring_length,
        control_lane_offset: data_offset,
        control_lane_length: ring_length / 8,
        message_lane_offset: data_offset + ring_length / 8,
        message_lane_length: ring_length / 2,
        bulk_lane_offset: data_offset + ring_length,
        bulk_lane_length: ring_length / 4,
        remote_lane_offset: data_offset + ring_length + ring_length / 4,
        remote_lane_length: ring_length - ring_length / 4,
        last_error_offset: 0,
        last_error_length: 0,
    };
    let encoded = header
        .encode()
        .map_err(|error| format!("ProtocolVersionMismatch: {error}"))?;
    let region_len = region.len();
    if region_len < encoded.len() {
        return Err(format!(
            "SharedMemoryCorrupted: region {} is smaller than ABI header {}",
            region_len,
            encoded.len()
        ));
    }
    region.as_mut_slice()[..encoded.len()].copy_from_slice(&encoded);
    initialize_ring_region(
        region.as_mut_slice(),
        header.rust_to_python_ring_offset,
        header.rust_to_python_ring_length,
        header.generation_id_low,
        header.generation_id_high,
    )?;
    initialize_ring_region(
        region.as_mut_slice(),
        header.python_to_rust_ring_offset,
        header.python_to_rust_ring_length,
        header.generation_id_low,
        header.generation_id_high,
    )?;
    Ok(())
}

fn initialize_ring_region(
    region: &mut [u8],
    offset: u32,
    length: u32,
    generation_id_low: u64,
    generation_id_high: u64,
) -> Result<(), String> {
    let offset = offset as usize;
    let length = length as usize;
    let end = offset
        .checked_add(length)
        .ok_or_else(|| "SharedMemoryCorrupted: ring region overflows usize".to_string())?;
    if end > region.len() {
        return Err(format!(
            "SharedMemoryCorrupted: ring region {}..{} exceeds shared memory size {}",
            offset,
            end,
            region.len()
        ));
    }
    baas_ipc::ring_buffer::SharedRingBuffer::initialize(
        &mut region[offset..end],
        generation_id_low,
        generation_id_high,
    )
    .map_err(|error| format!("SharedMemoryCorrupted: {error}"))?;
    Ok(())
}

fn read_shared_memory_header(
    region: &baas_ipc::native::SharedMemoryRegion,
) -> Result<baas_ipc::protocol::SharedMemoryHeader, String> {
    let header_len = baas_ipc::protocol::SHARED_MEMORY_HEADER_LEN;
    if region.len() < header_len {
        return Err(format!(
            "SharedMemoryCorrupted: region {} is smaller than ABI header {}",
            region.len(),
            header_len
        ));
    }
    baas_ipc::protocol::SharedMemoryHeader::decode(&region.as_slice()[..header_len])
        .map_err(|error| format!("SharedMemoryCorrupted: {error}"))
}

fn platform_resource_name(kind: &str, generation_id: &Uuid) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("Local\\BAAS-{}-{}", kind, generation_id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let token = match kind {
            "shm" => "s",
            "r2p-notify" => "r",
            "p2r-notify" => "p",
            _ => "x",
        };
        let nonce = generation_id.simple().to_string();
        format!("/baas_{}_{}", token, &nonce[..20])
    }
}

fn parse_benchmark_sizes(raw: Option<String>) -> Result<Vec<usize>, String> {
    let Some(raw) = raw else {
        return Ok(vec![1024, 64 * 1024, 1024 * 1024]);
    };
    let mut sizes = Vec::new();
    for part in raw.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let size = trimmed.parse::<usize>().map_err(|_| {
            format!("BenchmarkConfigurationInvalid: invalid payload size '{trimmed}'")
        })?;
        if size == 0 || size > 16 * 1024 * 1024 {
            return Err(format!(
                "BenchmarkConfigurationInvalid: payload size {size} is outside 1..=16777216"
            ));
        }
        sizes.push(size);
    }
    if sizes.is_empty() {
        return Err("BenchmarkConfigurationInvalid: no payload sizes configured".to_string());
    }
    Ok(sizes)
}

fn parse_benchmark_u32(
    name: &str,
    raw: Option<String>,
    default_value: u32,
    min: u32,
    max: u32,
) -> Result<u32, String> {
    let Some(raw) = raw else {
        return Ok(default_value);
    };
    let value = raw
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("BenchmarkConfigurationInvalid: {name} must be an integer"))?;
    if value < min || value > max {
        return Err(format!(
            "BenchmarkConfigurationInvalid: {name} must be between {min} and {max}"
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_ready_is_accepted() {
        let header = test_header(baas_ipc::protocol::LIFECYCLE_READY);

        assert_eq!(require_backend_lifecycle_ready(&header), Ok(()));
    }

    #[test]
    fn lifecycle_stopped_reports_backend_exited() {
        let header = test_header(baas_ipc::protocol::LIFECYCLE_STOPPED);

        assert_eq!(
            require_backend_lifecycle_ready(&header),
            Err("BackendExited: shared-memory backend stopped".to_string())
        );
    }

    #[test]
    fn lifecycle_failed_reports_initialization_failure() {
        let header = test_header(baas_ipc::protocol::LIFECYCLE_FAILED);

        assert_eq!(
            require_backend_lifecycle_ready(&header),
            Err(
                "BackendInitializationFailed: shared-memory backend entered failed lifecycle state"
                    .to_string()
            )
        );
    }

    #[test]
    fn unknown_lifecycle_state_reports_corruption() {
        let header = test_header(99);

        assert_eq!(
            require_backend_lifecycle_ready(&header),
            Err("SharedMemoryCorrupted: unknown shared-memory lifecycle state 99".to_string())
        );
    }

    #[test]
    fn webview_binary_frame_preserves_raw_payload_and_metadata() {
        let message = BackendIpcMessage {
            channel: "remote".to_string(),
            name: "screen".to_string(),
            stream_id: 7,
            kind: "bytes".to_string(),
            sequence_number: 99,
            json: None,
            bytes: Some(vec![0, 1, 2, 255]),
        };

        let encoded = encode_webview_message(&message).unwrap();

        assert_eq!(&encoded[..4], WEBVIEW_FRAME_MAGIC);
        assert_eq!(encoded[4], WEBVIEW_FRAME_VERSION);
        assert_eq!(encoded[5], WEBVIEW_KIND_BYTES);
        assert_eq!(u16::from_le_bytes(encoded[6..8].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(encoded[8..16].try_into().unwrap()), 99);
        assert_eq!(u32::from_le_bytes(encoded[16..20].try_into().unwrap()), 4);
        assert_eq!(&encoded[WEBVIEW_FRAME_HEADER_BYTES..], &[0, 1, 2, 255]);
    }

    #[test]
    fn webview_json_frame_keeps_utf8_json_payload() {
        let message = BackendIpcMessage {
            channel: "trigger".to_string(),
            name: "trigger".to_string(),
            stream_id: 3,
            kind: "json".to_string(),
            sequence_number: 10,
            json: Some(serde_json::json!({"type": "command_response", "status": "done"})),
            bytes: None,
        };

        let encoded = encode_webview_message(&message).unwrap();
        let decoded: Value =
            serde_json::from_slice(&encoded[WEBVIEW_FRAME_HEADER_BYTES..]).unwrap();

        assert_eq!(encoded[5], WEBVIEW_KIND_JSON);
        assert_eq!(decoded["type"], "command_response");
        assert_eq!(decoded["status"], "done");
    }

    #[test]
    fn webview_binary_request_preserves_utf8_name_and_raw_payload() {
        let name = "remote-配置";
        let name_bytes = name.as_bytes();
        let mut request = Vec::new();
        request.extend_from_slice(WEBVIEW_REQUEST_MAGIC);
        request.push(WEBVIEW_REQUEST_VERSION);
        request.push(baas_ipc::protocol::CHANNEL_REMOTE as u8);
        request.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        request.extend_from_slice(name_bytes);
        request.extend_from_slice(&[0, 1, 2, 255]);

        let (channel, decoded_name, payload) = decode_webview_binary_request(&request).unwrap();

        assert_eq!(channel, "remote");
        assert_eq!(decoded_name, name);
        assert_eq!(payload, &[0, 1, 2, 255]);
    }

    fn test_header(lifecycle_state: u32) -> baas_ipc::protocol::SharedMemoryHeader {
        baas_ipc::protocol::SharedMemoryHeader {
            magic: baas_ipc::protocol::MAGIC,
            protocol_version: baas_ipc::protocol::PROTOCOL_VERSION,
            abi_version: baas_ipc::protocol::ABI_VERSION,
            header_size: baas_ipc::protocol::SHARED_MEMORY_HEADER_LEN as u32,
            total_size: SHM_REGION_BYTES,
            generation_id_low: 1,
            generation_id_high: 2,
            owner_pid: 3,
            peer_pid: 4,
            lifecycle_state,
            last_error_code: 0,
            owner_heartbeat_ns: 0,
            peer_heartbeat_ns: 0,
            rust_to_python_ring_offset: 128,
            rust_to_python_ring_length: 1024,
            python_to_rust_ring_offset: 1152,
            python_to_rust_ring_length: 1024,
            control_lane_offset: 128,
            control_lane_length: 128,
            message_lane_offset: 256,
            message_lane_length: 896,
            bulk_lane_offset: 1152,
            bulk_lane_length: 512,
            remote_lane_offset: 1664,
            remote_lane_length: 512,
            last_error_offset: 0,
            last_error_length: 0,
        }
    }
}
