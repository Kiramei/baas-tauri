#[cfg(any(windows, unix))]
use crate::system_logs::system_log;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State,
};

#[cfg(any(windows, unix))]
const MAGIC: &[u8; 4] = b"BPIP";
#[cfg(any(windows, unix))]
const VERSION: u8 = 1;
#[cfg(any(windows, unix))]
const KIND_JSON: u8 = 1;
#[cfg(any(windows, unix))]
const KIND_BYTES: u8 = 2;
#[cfg(any(windows, unix))]
const KIND_CLOSE: u8 = 3;
#[cfg(any(windows, unix))]
const KIND_ERROR: u8 = 4;
#[cfg(any(windows, unix))]
const HEADER_BYTES: usize = 10;
#[cfg(any(windows, unix))]
const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
#[cfg(any(windows, unix))]
const OPEN_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(any(windows, unix))]
const OPEN_CONNECT_RETRY_DELAY: Duration = Duration::from_millis(100);

#[cfg(any(windows, unix))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(windows, unix))]
use std::{collections::HashMap, future::Future, io, time::Duration};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(any(windows, unix))]
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, WriteHalf},
    sync::{watch, Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard},
    task::JoinHandle,
};

#[cfg(windows)]
type NativePipeStream = NamedPipeClient;
#[cfg(unix)]
type NativePipeStream = UnixStream;

#[cfg(any(windows, unix))]
struct PipeConnection {
    core: Arc<ConnectionCore<WriteHalf<NativePipeStream>>>,
    terminal: Arc<TerminalNotifier>,
    reader: JoinHandle<()>,
}

#[cfg(any(windows, unix))]
impl PipeConnection {
    fn begin_close(&self) {
        self.core.begin_close();
    }

    fn emit_terminal(&self, kind: u8, payload: &[u8]) {
        self.terminal.emit(kind, payload);
    }
}

#[cfg(any(windows, unix))]
struct ConnectionCore<W> {
    closing: AtomicBool,
    writer: AsyncMutex<W>,
}

#[cfg(any(windows, unix))]
impl<W> ConnectionCore<W> {
    fn new(writer: W) -> Self {
        Self {
            closing: AtomicBool::new(false),
            writer: AsyncMutex::new(writer),
        }
    }

    fn begin_close(&self) {
        self.closing.store(true, Ordering::Release);
    }

    async fn lock_for_send(&self) -> Result<AsyncMutexGuard<'_, W>, String> {
        self.lock_for_send_after_initial_check(std::future::ready(()))
            .await
    }

    async fn lock_for_send_after_initial_check<F>(
        &self,
        after_initial_check: F,
    ) -> Result<AsyncMutexGuard<'_, W>, String>
    where
        F: std::future::Future<Output = ()>,
    {
        if self.closing.load(Ordering::Acquire) {
            return Err("pipe channel is closing".to_string());
        }
        after_initial_check.await;
        let writer = self.writer.lock().await;
        if self.closing.load(Ordering::Acquire) {
            return Err("pipe channel is closing".to_string());
        }
        Ok(writer)
    }
}

#[cfg(any(windows, unix))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ConnectionToken(u64);

#[cfg(any(windows, unix))]
impl ConnectionToken {
    fn parse(value: &str) -> Result<Self, String> {
        let token = value
            .parse::<u64>()
            .map_err(|_| "invalid pipe connection token".to_string())?;
        if token == 0 || token.to_string() != value {
            return Err("invalid pipe connection token".to_string());
        }
        Ok(Self(token))
    }

    fn encode(self) -> String {
        self.0.to_string()
    }
}

#[cfg(any(windows, unix))]
struct Tokenized<T> {
    token: ConnectionToken,
    value: T,
}

#[cfg(any(windows, unix))]
#[derive(Clone)]
struct OpenReservation {
    generation: u64,
    token: ConnectionToken,
    client_attempt: uuid::Uuid,
    cancellation: Arc<OpenCancellation>,
}

#[cfg(any(windows, unix))]
struct OpenCancellation {
    cancelled: AtomicBool,
    changed: watch::Sender<bool>,
}

#[cfg(any(windows, unix))]
impl OpenCancellation {
    fn new() -> Self {
        let (changed, _) = watch::channel(false);
        Self {
            cancelled: AtomicBool::new(false),
            changed,
        }
    }

    fn cancel(&self) {
        if !self.cancelled.swap(true, Ordering::AcqRel) {
            self.changed.send_replace(true);
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        let mut changed = self.changed.subscribe();
        if self.is_cancelled() {
            return;
        }
        while changed.changed().await.is_ok() {
            if *changed.borrow_and_update() {
                return;
            }
        }
    }
}

#[cfg(any(windows, unix))]
#[derive(Default)]
struct TerminalGate {
    claimed: AtomicBool,
}

#[cfg(any(windows, unix))]
impl TerminalGate {
    fn claim(&self) -> bool {
        !self.claimed.swap(true, Ordering::AcqRel)
    }
}

#[cfg(any(windows, unix))]
struct TerminalNotifier {
    gate: TerminalGate,
    channel: Channel<InvokeResponseBody>,
}

#[cfg(any(windows, unix))]
impl TerminalNotifier {
    fn new(channel: Channel<InvokeResponseBody>) -> Self {
        Self {
            gate: TerminalGate::default(),
            channel,
        }
    }

    fn emit(&self, kind: u8, payload: &[u8]) -> bool {
        if !self.gate.claim() {
            return false;
        }
        if let Ok(frame) = encode_frame(kind, payload) {
            let _ = self.channel.send(InvokeResponseBody::Raw(frame));
        }
        true
    }
}

#[derive(Default)]
struct PipeState {
    pipe_name: Option<String>,
    #[cfg(any(windows, unix))]
    generation: u64,
    #[cfg(any(windows, unix))]
    next_token: u64,
    #[cfg(any(windows, unix))]
    opening: HashMap<String, OpenReservation>,
    #[cfg(any(windows, unix))]
    cancelled_attempts: HashMap<String, uuid::Uuid>,
    #[cfg(any(windows, unix))]
    connections: HashMap<String, Tokenized<PipeConnection>>,
}

#[derive(Clone, Default)]
pub struct BackendPipeManager {
    inner: Arc<Mutex<PipeState>>,
}

impl BackendPipeManager {
    #[cfg(any(windows, unix))]
    pub fn configure(&self, pipe_name: String) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?;
        advance_generation(&mut state)?;
        cancel_all_opening(&mut state.opening);
        state.opening.clear();
        state.cancelled_attempts.clear();
        let connections = state
            .connections
            .drain()
            .map(|(_, connection)| connection.value)
            .collect::<Vec<_>>();
        for connection in &connections {
            connection.begin_close();
        }
        state.pipe_name = Some(pipe_name);
        drop(state);
        for connection in connections {
            connection.emit_terminal(KIND_CLOSE, &[]);
            connection.reader.abort();
        }
        Ok(())
    }

    pub fn close_all(&self) -> Result<(), String> {
        #[cfg(any(windows, unix))]
        {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "pipe transport state lock poisoned".to_string())?;
            advance_generation(&mut state)?;
            cancel_all_opening(&mut state.opening);
            state.opening.clear();
            state.cancelled_attempts.clear();
            let connections = state
                .connections
                .drain()
                .map(|(_, connection)| connection.value)
                .collect::<Vec<_>>();
            for connection in &connections {
                connection.begin_close();
            }
            state.pipe_name = None;
            drop(state);
            for connection in connections {
                connection.emit_terminal(KIND_CLOSE, &[]);
                connection.reader.abort();
            }
            Ok(())
        }
        #[cfg(not(any(windows, unix)))]
        {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "pipe transport state lock poisoned".to_string())?;
            state.pipe_name = None;
            Ok(())
        }
    }

    #[cfg(any(windows, unix))]
    fn reserve_open(
        &self,
        key: &str,
        client_attempt: uuid::Uuid,
    ) -> Result<(String, OpenReservation), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?;
        let pipe_name = state
            .pipe_name
            .clone()
            .ok_or_else(|| "pipe transport has not been started".to_string())?;
        if let Some(cancelled) = state.cancelled_attempts.remove(key) {
            if cancelled == client_attempt {
                return Err("pipe channel open was cancelled before it started".to_string());
            }
        }
        state.next_token = state
            .next_token
            .checked_add(1)
            .ok_or_else(|| "pipe connection token space exhausted".to_string())?;
        let reservation = OpenReservation {
            generation: state.generation,
            token: ConnectionToken(state.next_token),
            client_attempt,
            cancellation: Arc::new(OpenCancellation::new()),
        };
        if let Some(previous) = state.opening.insert(key.to_string(), reservation.clone()) {
            previous.cancellation.cancel();
        }
        Ok((pipe_name, reservation))
    }

    #[cfg(any(windows, unix))]
    fn cancel_open(&self, key: &str, reservation: &OpenReservation) {
        if let Ok(mut state) = self.inner.lock() {
            cancel_open_if_token(&mut state.opening, key, reservation.token);
        }
    }
}

#[cfg(any(windows, unix))]
fn parse_client_attempt(value: &str) -> Result<uuid::Uuid, String> {
    let attempt = uuid::Uuid::parse_str(value)
        .map_err(|_| "invalid pipe client attempt identifier".to_string())?;
    if attempt.hyphenated().to_string() != value
        || attempt.get_version() != Some(uuid::Version::Random)
        || attempt.get_variant() != uuid::Variant::RFC4122
    {
        return Err("invalid pipe client attempt identifier".to_string());
    }
    Ok(attempt)
}

#[cfg(any(windows, unix))]
fn advance_generation(state: &mut PipeState) -> Result<(), String> {
    state.generation = state
        .generation
        .checked_add(1)
        .ok_or_else(|| "pipe transport generation space exhausted".to_string())?;
    Ok(())
}

#[cfg(any(windows, unix))]
fn cancel_all_opening(opening: &mut HashMap<String, OpenReservation>) {
    for reservation in opening.values() {
        reservation.cancellation.cancel();
    }
}

#[cfg(any(windows, unix))]
fn cancel_open_if_token(
    opening: &mut HashMap<String, OpenReservation>,
    key: &str,
    token: ConnectionToken,
) -> bool {
    if opening.get(key).map(|entry| entry.token) != Some(token) {
        return false;
    }
    if let Some(reservation) = opening.remove(key) {
        reservation.cancellation.cancel();
    }
    true
}

#[cfg(any(windows, unix))]
fn cancel_open_if_attempt(state: &mut PipeState, key: &str, client_attempt: uuid::Uuid) -> bool {
    if state.opening.get(key).map(|entry| entry.client_attempt) == Some(client_attempt) {
        if let Some(reservation) = state.opening.remove(key) {
            reservation.cancellation.cancel();
        }
        return true;
    }
    state
        .cancelled_attempts
        .insert(key.to_string(), client_attempt);
    false
}

#[cfg(any(windows, unix))]
fn consume_open_reservation(
    state: &mut PipeState,
    key: &str,
    reservation: &OpenReservation,
) -> bool {
    if state.generation != reservation.generation
        || state.opening.get(key).map(|entry| entry.token) != Some(reservation.token)
    {
        return false;
    }
    state.opening.remove(key);
    true
}

#[cfg(any(windows, unix))]
fn remove_if_token<T>(
    entries: &mut HashMap<String, Tokenized<T>>,
    key: &str,
    token: ConnectionToken,
) -> Option<T> {
    if entries.get(key).map(|entry| entry.token) != Some(token) {
        return None;
    }
    entries.remove(key).map(|entry| entry.value)
}

#[cfg(any(windows, unix))]
fn connection_key(channel: &str, name: &str) -> String {
    format!("{channel}:{name}")
}

#[cfg(any(windows, unix))]
fn encode_frame(kind: u8, payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err("pipe payload exceeds the 64 MiB limit".to_string());
    }
    let mut frame = Vec::with_capacity(HEADER_BYTES + payload.len());
    frame.extend_from_slice(MAGIC);
    frame.push(VERSION);
    frame.push(kind);
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

#[cfg(any(windows, unix))]
async fn read_frame<R>(reader: &mut R) -> Result<(u8, Vec<u8>), String>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0_u8; HEADER_BYTES];
    reader
        .read_exact(&mut header)
        .await
        .map_err(|error| format!("pipe read failed: {error}"))?;
    if &header[..4] != MAGIC || header[4] != VERSION {
        return Err("invalid pipe frame header".to_string());
    }
    let kind = header[5];
    let length = u32::from_le_bytes(header[6..10].try_into().unwrap()) as usize;
    if length > MAX_PAYLOAD_BYTES {
        return Err("pipe payload exceeds the 64 MiB limit".to_string());
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .await
        .map_err(|error| format!("pipe payload read failed: {error}"))?;
    Ok((kind, payload))
}

#[cfg(any(windows, unix))]
async fn await_open_stage<T, F>(
    cancellation: &OpenCancellation,
    deadline: tokio::time::Instant,
    stage: &str,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = T>,
{
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            Err(format!("pipe channel open cancelled during {stage}"))
        }
        result = tokio::time::timeout_at(deadline, future) => {
            result.map_err(|_| format!("pipe channel open handshake timed out during {stage}"))
        }
    }
}

#[cfg(any(windows, unix))]
async fn connect_with_retry<T, F, Fut>(
    endpoint: &str,
    cancellation: &OpenCancellation,
    deadline: tokio::time::Instant,
    mut attempt: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = io::Result<T>>,
{
    loop {
        match await_open_stage(cancellation, deadline, "connect attempt", attempt()).await? {
            Ok(stream) => return Ok(stream),
            Err(error) if tokio::time::Instant::now() < deadline => {
                let _ = error;
                await_open_stage(
                    cancellation,
                    deadline,
                    "connect retry",
                    tokio::time::sleep(OPEN_CONNECT_RETRY_DELAY),
                )
                .await?;
            }
            Err(error) => {
                return Err(format!("failed to connect pipe {endpoint}: {error}"));
            }
        }
    }
}

#[cfg(any(windows, unix))]
async fn perform_open_exchange<R, W>(
    reader: &mut R,
    writer: &mut W,
    channel: &str,
    name: &str,
    cancellation: &OpenCancellation,
    deadline: tokio::time::Instant,
) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let open = serde_json::to_vec(&serde_json::json!({
        "type": "open",
        "channel": channel,
        "name": name,
    }))
    .map_err(|error| error.to_string())?;
    let frame = encode_frame(KIND_JSON, &open)?;
    await_open_stage(
        cancellation,
        deadline,
        "open request write",
        writer.write_all(&frame),
    )
    .await?
    .map_err(|error| format!("pipe open write failed: {error}"))?;
    let (kind, payload) = await_open_stage(
        cancellation,
        deadline,
        "open response read",
        read_frame(reader),
    )
    .await??;
    if kind != KIND_JSON {
        return Err("pipe server did not return an open response".to_string());
    }
    let response: Value = serde_json::from_slice(&payload).map_err(|error| error.to_string())?;
    if response.get("type").and_then(Value::as_str) != Some("open_ok") {
        return Err(format!("pipe channel open failed: {response}"));
    }
    Ok(())
}

#[cfg(windows)]
async fn connect_pipe(
    pipe_name: &str,
    cancellation: &OpenCancellation,
    deadline: tokio::time::Instant,
) -> Result<NativePipeStream, String> {
    connect_with_retry(pipe_name, cancellation, deadline, || {
        std::future::ready(ClientOptions::new().open(pipe_name))
    })
    .await
}

#[cfg(unix)]
async fn connect_pipe(
    pipe_name: &str,
    cancellation: &OpenCancellation,
    deadline: tokio::time::Instant,
) -> Result<NativePipeStream, String> {
    connect_with_retry(pipe_name, cancellation, deadline, || {
        UnixStream::connect(pipe_name)
    })
    .await
}

#[tauri::command]
pub async fn backend_pipe_open(
    manager: State<'_, BackendPipeManager>,
    channel: String,
    name: String,
    client_attempt: String,
    on_message: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, channel, name, client_attempt, on_message);
        return Err("Pipe transport is unavailable on this platform".to_string());
    }

    #[cfg(any(windows, unix))]
    {
        let key = connection_key(&channel, &name);
        let client_attempt = parse_client_attempt(&client_attempt)?;
        let (pipe_name, reservation) = manager.reserve_open(&key, client_attempt)?;
        system_log(
            "DEBUG",
            "pipe_transport",
            format!("Opening pipe channel channel={channel} name={name} pipe={pipe_name}"),
        );
        let deadline = tokio::time::Instant::now() + OPEN_HANDSHAKE_TIMEOUT;
        let handshake = async {
            let client = connect_pipe(&pipe_name, &reservation.cancellation, deadline).await?;
            let (mut reader, mut writer) = tokio::io::split(client);
            perform_open_exchange(
                &mut reader,
                &mut writer,
                &channel,
                &name,
                &reservation.cancellation,
                deadline,
            )
            .await?;
            Ok::<_, String>((reader, writer))
        }
        .await;
        let (mut reader, writer) = match handshake {
            Ok(stream) => stream,
            Err(error) => {
                manager.cancel_open(&key, &reservation);
                return Err(error);
            }
        };
        let core = Arc::new(ConnectionCore::new(writer));
        let terminal = Arc::new(TerminalNotifier::new(on_message.clone()));
        let reader_state = manager.inner.clone();
        let reader_core = core.clone();
        let reader_terminal = terminal.clone();
        let reader_key = key.clone();
        let reader_channel = channel.clone();
        let reader_name = name.clone();
        let (reader_start, wait_for_insert) = tokio::sync::oneshot::channel::<()>();
        let reader_task = tokio::spawn(async move {
            if wait_for_insert.await.is_err() {
                return;
            }
            let mut received_frames = 0_u64;
            loop {
                match read_frame(&mut reader).await {
                    Ok((kind, payload)) => {
                        received_frames += 1;
                        if received_frames <= 3 {
                            system_log(
                                "DEBUG",
                                "pipe_transport",
                                format!(
                                    "Pipe frame received channel={reader_channel} name={reader_name} kind={kind} bytes={}",
                                    payload.len()
                                ),
                            );
                        }
                        match kind {
                            KIND_JSON | KIND_BYTES => {
                                let frame = match encode_frame(kind, &payload) {
                                    Ok(frame) => frame,
                                    Err(_) => break,
                                };
                                if on_message.send(InvokeResponseBody::Raw(frame)).is_err() {
                                    break;
                                }
                            }
                            KIND_CLOSE | KIND_ERROR => {
                                reader_core.begin_close();
                                reader_terminal.emit(kind, &payload);
                                break;
                            }
                            _ => {
                                reader_core.begin_close();
                                let detail = format!("unsupported pipe frame kind: {kind}");
                                reader_terminal.emit(KIND_ERROR, detail.as_bytes());
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        reader_core.begin_close();
                        system_log(
                            "ERROR",
                            "pipe_transport",
                            format!(
                                "Pipe channel read failed channel={reader_channel} name={reader_name}: {error}"
                            ),
                        );
                        reader_terminal.emit(KIND_ERROR, error.as_bytes());
                        break;
                    }
                }
            }
            reader_core.begin_close();
            reader_terminal.emit(KIND_ERROR, b"pipe channel reader stopped");
            if let Ok(mut state) = reader_state.lock() {
                remove_if_token(&mut state.connections, &reader_key, reservation.token);
            }
        });
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?;
        if !consume_open_reservation(&mut state, &key, &reservation) {
            drop(state);
            reader_task.abort();
            return Err("pipe channel open was superseded or cancelled".to_string());
        }
        let previous = state.connections.insert(
            key,
            Tokenized {
                token: reservation.token,
                value: PipeConnection {
                    core,
                    terminal,
                    reader: reader_task,
                },
            },
        );
        if let Some(previous) = previous.as_ref() {
            previous.value.begin_close();
        }
        drop(state);
        if let Some(previous) = previous {
            previous.value.emit_terminal(KIND_CLOSE, &[]);
            previous.value.reader.abort();
        }
        let _ = reader_start.send(());
        system_log(
            "INFO",
            "pipe_transport",
            format!("Pipe channel opened channel={channel} name={name}"),
        );
        Ok(reservation.token.encode())
    }
}

#[tauri::command]
pub fn backend_pipe_cancel_open(
    manager: State<'_, BackendPipeManager>,
    channel: String,
    name: String,
    client_attempt: String,
) -> Result<(), String> {
    #[cfg(any(windows, unix))]
    {
        let key = connection_key(&channel, &name);
        let client_attempt = parse_client_attempt(&client_attempt)?;
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?;
        cancel_open_if_attempt(&mut state, &key, client_attempt);
        Ok(())
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, channel, name, client_attempt);
        Ok(())
    }
}

#[cfg(any(windows, unix))]
async fn send_frame(
    manager: &BackendPipeManager,
    channel: &str,
    name: &str,
    token: &str,
    kind: u8,
    payload: &[u8],
) -> Result<(), String> {
    let expected = ConnectionToken::parse(token)?;
    let core = manager
        .inner
        .lock()
        .map_err(|_| "pipe transport state lock poisoned".to_string())?
        .connections
        .get(&connection_key(channel, name))
        .filter(|connection| connection.token == expected)
        .map(|connection| connection.value.core.clone())
        .ok_or_else(|| format!("pipe channel is not open: {channel}:{name}"))?;
    let result = core
        .lock_for_send()
        .await?
        .write_all(&encode_frame(kind, payload)?)
        .await
        .map_err(|error| format!("pipe write failed: {error}"));
    result
}

#[tauri::command]
pub async fn backend_pipe_send_json(
    manager: State<'_, BackendPipeManager>,
    channel: String,
    name: String,
    payload: Value,
    token: String,
) -> Result<(), String> {
    #[cfg(any(windows, unix))]
    return send_frame(
        &manager,
        &channel,
        &name,
        &token,
        KIND_JSON,
        &serde_json::to_vec(&payload).map_err(|error| error.to_string())?,
    )
    .await;
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, channel, name, payload, token);
        Err("Pipe transport is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub async fn backend_pipe_send_bytes(
    manager: State<'_, BackendPipeManager>,
    channel: String,
    name: String,
    payload: Vec<u8>,
    token: String,
) -> Result<(), String> {
    #[cfg(any(windows, unix))]
    return send_frame(&manager, &channel, &name, &token, KIND_BYTES, &payload).await;
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, channel, name, payload, token);
        Err("Pipe transport is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub async fn backend_pipe_close(
    manager: State<'_, BackendPipeManager>,
    channel: String,
    name: String,
    token: String,
) -> Result<(), String> {
    #[cfg(any(windows, unix))]
    {
        let key = connection_key(&channel, &name);
        let expected = ConnectionToken::parse(&token)?;
        let connection = {
            let mut state = manager
                .inner
                .lock()
                .map_err(|_| "pipe transport state lock poisoned".to_string())?;
            cancel_open_if_token(&mut state.opening, &key, expected);
            let connection = remove_if_token(&mut state.connections, &key, expected);
            if let Some(connection) = connection.as_ref() {
                connection.begin_close();
            }
            connection
        };
        if let Some(connection) = connection {
            connection.emit_terminal(KIND_CLOSE, &[]);
            let _ = connection
                .core
                .writer
                .lock()
                .await
                .write_all(&encode_frame(KIND_CLOSE, &[])?)
                .await;
            connection.reader.abort();
        }
        Ok(())
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, channel, name, token);
        Ok(())
    }
}

#[tauri::command]
pub fn backend_pipe_close_all(manager: State<'_, BackendPipeManager>) -> Result<(), String> {
    manager.close_all()
}

#[cfg(all(test, any(windows, unix)))]
mod tests {
    use super::*;

    fn client_attempt(value: u128) -> uuid::Uuid {
        uuid::Uuid::from_u128(value)
    }

    #[test]
    fn configure_invalidates_every_pending_open_generation() {
        let manager = BackendPipeManager::default();
        manager.configure("first".to_string()).unwrap();
        let (_, reservation) = manager
            .reserve_open("provider:test", client_attempt(1))
            .unwrap();

        manager.configure("second".to_string()).unwrap();

        let mut state = manager.inner.lock().unwrap();
        assert!(reservation.cancellation.is_cancelled());
        assert_ne!(state.generation, reservation.generation);
        assert!(state.opening.is_empty());
        assert_eq!(state.pipe_name.as_deref(), Some("second"));
        assert!(!consume_open_reservation(
            &mut state,
            "provider:test",
            &reservation
        ));
    }

    #[test]
    fn superseded_open_cannot_cancel_the_new_reservation() {
        let manager = BackendPipeManager::default();
        manager.configure("pipe".to_string()).unwrap();
        let (_, first) = manager
            .reserve_open("sync:same", client_attempt(2))
            .unwrap();
        let (_, second) = manager
            .reserve_open("sync:same", client_attempt(3))
            .unwrap();

        assert!(first.cancellation.is_cancelled());
        manager.cancel_open("sync:same", &first);

        let mut state = manager.inner.lock().unwrap();
        assert_eq!(
            state.opening.get("sync:same").map(|entry| entry.token),
            Some(second.token)
        );
        assert!(!consume_open_reservation(&mut state, "sync:same", &first));
        assert!(consume_open_reservation(&mut state, "sync:same", &second));
    }

    #[test]
    fn close_all_cancels_pending_open_and_removes_endpoint() {
        let manager = BackendPipeManager::default();
        manager.configure("pipe".to_string()).unwrap();
        let (_, reservation) = manager
            .reserve_open("remote:pending", client_attempt(4))
            .unwrap();
        {
            let mut state = manager.inner.lock().unwrap();
            cancel_open_if_attempt(&mut state, "remote:not-arrived", client_attempt(40));
        }

        manager.close_all().unwrap();

        assert!(reservation.cancellation.is_cancelled());
        let state = manager.inner.lock().unwrap();
        assert!(state.opening.is_empty());
        assert!(state.cancelled_attempts.is_empty());
        assert!(state.pipe_name.is_none());
    }

    #[test]
    fn exact_token_close_cancels_only_its_pending_open() {
        let manager = BackendPipeManager::default();
        manager.configure("pipe".to_string()).unwrap();
        let (_, reservation) = manager
            .reserve_open("provider:pending", client_attempt(5))
            .unwrap();

        let mut state = manager.inner.lock().unwrap();
        assert!(!cancel_open_if_token(
            &mut state.opening,
            "provider:pending",
            ConnectionToken(reservation.token.0 + 1)
        ));
        assert!(!reservation.cancellation.is_cancelled());
        assert!(cancel_open_if_token(
            &mut state.opening,
            "provider:pending",
            reservation.token
        ));
        assert!(reservation.cancellation.is_cancelled());
    }

    #[test]
    fn cancel_before_open_arrival_is_consumed_only_by_the_same_attempt() {
        let manager = BackendPipeManager::default();
        manager.configure("pipe".to_string()).unwrap();
        let key = "sync:out-of-order";
        let cancelled = client_attempt(6);
        {
            let mut state = manager.inner.lock().unwrap();
            assert!(!cancel_open_if_attempt(&mut state, key, cancelled));
            assert_eq!(state.cancelled_attempts.get(key), Some(&cancelled));
        }

        let error = match manager.reserve_open(key, cancelled) {
            Ok(_) => panic!("cancelled attempt was admitted"),
            Err(error) => error,
        };
        assert!(error.contains("cancelled before it started"), "{error}");
        {
            let state = manager.inner.lock().unwrap();
            assert!(!state.cancelled_attempts.contains_key(key));
            assert!(!state.opening.contains_key(key));
        }

        let different = client_attempt(7);
        assert!(manager.reserve_open(key, different).is_ok());
    }

    #[test]
    fn token_guard_never_removes_a_replacement_connection() {
        let old = ConnectionToken(7);
        let replacement = ConnectionToken(8);
        let mut entries = HashMap::from([(
            "trigger:same".to_string(),
            Tokenized {
                token: replacement,
                value: "replacement",
            },
        )]);

        assert_eq!(remove_if_token(&mut entries, "trigger:same", old), None);
        assert_eq!(
            remove_if_token(&mut entries, "trigger:same", replacement),
            Some("replacement")
        );
    }

    #[test]
    fn terminal_gate_is_claimed_exactly_once() {
        let gate = TerminalGate::default();
        assert!(gate.claim());
        assert!(!gate.claim());
        assert!(!gate.claim());
    }

    #[test]
    fn opaque_tokens_reject_noncanonical_or_zero_values() {
        assert_eq!(ConnectionToken::parse("42").unwrap(), ConnectionToken(42));
        for invalid in ["", "0", "00", "+1", " 1", "1 ", "-1", "abc"] {
            assert!(
                ConnectionToken::parse(invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn client_attempts_require_canonical_random_uuids() {
        let valid = "123e4567-e89b-42d3-a456-426614174000";
        assert_eq!(parse_client_attempt(valid).unwrap().to_string(), valid);
        for invalid in [
            "123E4567-E89B-42D3-A456-426614174000",
            "00000000-0000-0000-0000-000000000000",
            "123e4567-e89b-12d3-a456-426614174000",
            "not-a-uuid",
        ] {
            assert!(
                parse_client_attempt(invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
    }

    #[tokio::test]
    async fn send_rechecks_the_gate_after_close_wins_the_boundary() {
        let core = Arc::new(ConnectionCore::new(Vec::<u8>::new()));
        let (initial_check_reached, wait_for_initial_check) = tokio::sync::oneshot::channel();
        let (resume_send, wait_for_resume) = tokio::sync::oneshot::channel();
        let sending_core = core.clone();
        let send = tokio::spawn(async move {
            let pause = async move {
                let _ = initial_check_reached.send(());
                let _ = wait_for_resume.await;
            };
            match sending_core.lock_for_send_after_initial_check(pause).await {
                Ok(mut writer) => {
                    writer.extend_from_slice(b"business");
                    true
                }
                Err(_) => false,
            }
        });

        wait_for_initial_check.await.unwrap();
        core.begin_close();
        resume_send.send(()).unwrap();

        assert!(!send.await.unwrap());
        assert!(core.writer.lock().await.is_empty());
    }

    #[tokio::test]
    async fn stalled_connect_retry_returns_promptly_when_reservation_is_cancelled() {
        let cancellation = Arc::new(OpenCancellation::new());
        let (attempt_started, wait_for_attempt) = tokio::sync::oneshot::channel();
        let mut attempt_started = Some(attempt_started);
        let task_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            connect_with_retry(
                "fake-endpoint",
                &task_cancellation,
                tokio::time::Instant::now() + Duration::from_secs(5),
                move || {
                    if let Some(started) = attempt_started.take() {
                        let _ = started.send(());
                    }
                    std::future::pending::<io::Result<()>>()
                },
            )
            .await
        });

        wait_for_attempt.await.unwrap();
        cancellation.cancel();
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(
            error.contains("cancelled during connect attempt"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn frontend_cancel_during_stalled_open_releases_fake_socket_promptly() {
        let manager = BackendPipeManager::default();
        manager.configure("pipe".to_string()).unwrap();
        let key = "provider:stalled-write";
        let client_attempt = client_attempt(8);
        let (_, reservation) = manager.reserve_open(key, client_attempt).unwrap();
        let cancellation = reservation.cancellation.clone();
        let (client, mut stalled_server) = tokio::io::duplex(1);
        let (mut reader, mut writer) = tokio::io::split(client);
        let (server_read, wait_for_server_read) = tokio::sync::oneshot::channel();
        let (inspect_eof, wait_to_inspect_eof) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut byte = [0_u8; 1];
            stalled_server.read_exact(&mut byte).await.unwrap();
            let _ = server_read.send(());
            let _ = wait_to_inspect_eof.await;
            let mut remainder = Vec::new();
            stalled_server.read_to_end(&mut remainder).await.unwrap();
            remainder
        });
        let task_cancellation = cancellation.clone();
        let exchange = tokio::spawn(async move {
            perform_open_exchange(
                &mut reader,
                &mut writer,
                "provider",
                "stalled-write",
                &task_cancellation,
                tokio::time::Instant::now() + Duration::from_secs(5),
            )
            .await
        });

        wait_for_server_read.await.unwrap();
        {
            let mut state = manager.inner.lock().unwrap();
            assert!(cancel_open_if_attempt(&mut state, key, client_attempt));
        }
        let error = tokio::time::timeout(Duration::from_secs(1), exchange)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(
            error.contains("cancelled during open request write"),
            "{error}"
        );
        inspect_eof.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("cancelled handshake retained the fake socket")
            .unwrap();
    }

    #[tokio::test]
    async fn stalled_open_response_obeys_the_total_handshake_deadline() {
        let cancellation = OpenCancellation::new();
        let (client, server) = tokio::io::duplex(1024);
        let (mut reader, mut writer) = tokio::io::split(client);
        let (mut server_reader, _server_writer) = tokio::io::split(server);
        let server = tokio::spawn(async move {
            let _ = read_frame(&mut server_reader).await.unwrap();
            std::future::pending::<()>().await;
        });

        let error = perform_open_exchange(
            &mut reader,
            &mut writer,
            "sync",
            "stalled-response",
            &cancellation,
            tokio::time::Instant::now() + Duration::from_millis(100),
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("timed out during open response read"),
            "{error}"
        );
        server.abort();
    }

    #[test]
    fn reader_and_retirement_race_emits_exactly_one_terminal_frame() {
        let frames = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let channel_frames = frames.clone();
        let terminal = Arc::new(TerminalNotifier::new(Channel::new(move |body| {
            if let InvokeResponseBody::Raw(frame) = body {
                channel_frames.lock().unwrap().push(frame);
            }
            Ok(())
        })));
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let reader_terminal = terminal.clone();
        let reader_barrier = barrier.clone();
        let reader = std::thread::spawn(move || {
            reader_barrier.wait();
            reader_terminal.emit(KIND_ERROR, b"reader failed");
        });
        let retirement_terminal = terminal.clone();
        let retirement_barrier = barrier.clone();
        let retirement = std::thread::spawn(move || {
            retirement_barrier.wait();
            retirement_terminal.emit(KIND_CLOSE, &[]);
        });

        barrier.wait();
        reader.join().unwrap();
        retirement.join().unwrap();

        let frames = frames.lock().unwrap();
        assert_eq!(frames.len(), 1);
        assert!(matches!(frames[0][5], KIND_CLOSE | KIND_ERROR));
    }
}
