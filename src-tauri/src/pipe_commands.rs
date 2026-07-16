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
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(windows, unix))]
use std::{collections::HashMap, time::Duration};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(any(windows, unix))]
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf},
    sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard},
    task::JoinHandle,
};

#[cfg(windows)]
type NativePipeStream = NamedPipeClient;
#[cfg(unix)]
type NativePipeStream = UnixStream;

#[cfg(any(windows, unix))]
struct PipeConnection {
    core: Arc<ConnectionCore<WriteHalf<NativePipeStream>>>,
    reader: JoinHandle<()>,
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
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct OpenReservation {
    generation: u64,
    token: ConnectionToken,
}

#[cfg(any(windows, unix))]
#[derive(Default)]
struct TerminalGate {
    claimed: bool,
}

#[cfg(any(windows, unix))]
impl TerminalGate {
    fn claim(&mut self) -> bool {
        if self.claimed {
            return false;
        }
        self.claimed = true;
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
        state.opening.clear();
        let connections = state
            .connections
            .drain()
            .map(|(_, connection)| connection.value)
            .collect::<Vec<_>>();
        for connection in &connections {
            connection.core.begin_close();
        }
        state.pipe_name = Some(pipe_name);
        drop(state);
        for connection in connections {
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
            state.opening.clear();
            let connections = state
                .connections
                .drain()
                .map(|(_, connection)| connection.value)
                .collect::<Vec<_>>();
            for connection in &connections {
                connection.core.begin_close();
            }
            state.pipe_name = None;
            drop(state);
            for connection in connections {
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
    fn reserve_open(&self, key: &str) -> Result<(String, OpenReservation), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?;
        let pipe_name = state
            .pipe_name
            .clone()
            .ok_or_else(|| "pipe transport has not been started".to_string())?;
        state.next_token = state
            .next_token
            .checked_add(1)
            .ok_or_else(|| "pipe connection token space exhausted".to_string())?;
        let reservation = OpenReservation {
            generation: state.generation,
            token: ConnectionToken(state.next_token),
        };
        state.opening.insert(key.to_string(), reservation);
        Ok((pipe_name, reservation))
    }

    #[cfg(any(windows, unix))]
    fn cancel_open(&self, key: &str, reservation: OpenReservation) {
        if let Ok(mut state) = self.inner.lock() {
            remove_open_if_token(&mut state.opening, key, reservation.token);
        }
    }
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
fn remove_open_if_token(
    opening: &mut HashMap<String, OpenReservation>,
    key: &str,
    token: ConnectionToken,
) -> bool {
    if opening.get(key).map(|entry| entry.token) != Some(token) {
        return false;
    }
    opening.remove(key);
    true
}

#[cfg(any(windows, unix))]
fn consume_open_reservation(
    state: &mut PipeState,
    key: &str,
    reservation: OpenReservation,
) -> bool {
    if state.generation != reservation.generation
        || state.opening.get(key).copied() != Some(reservation)
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
async fn read_frame(reader: &mut ReadHalf<NativePipeStream>) -> Result<(u8, Vec<u8>), String> {
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

#[cfg(windows)]
async fn connect_pipe(pipe_name: &str) -> Result<NativePipeStream, String> {
    let started = tokio::time::Instant::now();
    loop {
        match ClientOptions::new().open(pipe_name) {
            Ok(client) => return Ok(client),
            Err(error) if started.elapsed() < Duration::from_secs(10) => {
                let _ = error;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(error) => return Err(format!("failed to connect named pipe {pipe_name}: {error}")),
        }
    }
}

#[cfg(unix)]
async fn connect_pipe(pipe_name: &str) -> Result<NativePipeStream, String> {
    let started = tokio::time::Instant::now();
    loop {
        match UnixStream::connect(pipe_name).await {
            Ok(client) => return Ok(client),
            Err(error) if started.elapsed() < Duration::from_secs(10) => {
                let _ = error;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(error) => return Err(format!("failed to connect Unix pipe {pipe_name}: {error}")),
        }
    }
}

#[tauri::command]
pub async fn backend_pipe_open(
    manager: State<'_, BackendPipeManager>,
    channel: String,
    name: String,
    on_message: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, channel, name, on_message);
        return Err("Pipe transport is unavailable on this platform".to_string());
    }

    #[cfg(any(windows, unix))]
    {
        let key = connection_key(&channel, &name);
        let (pipe_name, reservation) = manager.reserve_open(&key)?;
        system_log(
            "DEBUG",
            "pipe_transport",
            format!("Opening pipe channel channel={channel} name={name} pipe={pipe_name}"),
        );
        let handshake = async {
            let client = connect_pipe(&pipe_name).await?;
            let (mut reader, mut writer) = tokio::io::split(client);
            let open = serde_json::to_vec(&serde_json::json!({
                "type": "open",
                "channel": channel,
                "name": name,
            }))
            .map_err(|error| error.to_string())?;
            writer
                .write_all(&encode_frame(KIND_JSON, &open)?)
                .await
                .map_err(|error| format!("pipe open write failed: {error}"))?;
            let (kind, payload) = read_frame(&mut reader).await?;
            if kind != KIND_JSON {
                return Err("pipe server did not return an open response".to_string());
            }
            let response: Value =
                serde_json::from_slice(&payload).map_err(|error| error.to_string())?;
            if response.get("type").and_then(Value::as_str) != Some("open_ok") {
                return Err(format!("pipe channel open failed: {response}"));
            }
            Ok::<_, String>((reader, writer))
        }
        .await;
        let (mut reader, writer) = match handshake {
            Ok(stream) => stream,
            Err(error) => {
                manager.cancel_open(&key, reservation);
                return Err(error);
            }
        };
        let core = Arc::new(ConnectionCore::new(writer));
        let reader_state = manager.inner.clone();
        let reader_core = core.clone();
        let reader_key = key.clone();
        let reader_channel = channel.clone();
        let reader_name = name.clone();
        let (reader_start, wait_for_insert) = tokio::sync::oneshot::channel::<()>();
        let reader_task = tokio::spawn(async move {
            if wait_for_insert.await.is_err() {
                return;
            }
            let mut received_frames = 0_u64;
            let mut terminal = TerminalGate::default();
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
                                if terminal.claim() {
                                    if let Ok(frame) = encode_frame(kind, &payload) {
                                        let _ = on_message.send(InvokeResponseBody::Raw(frame));
                                    }
                                }
                                break;
                            }
                            _ => {
                                reader_core.begin_close();
                                if terminal.claim() {
                                    let detail = format!("unsupported pipe frame kind: {kind}");
                                    if let Ok(frame) = encode_frame(KIND_ERROR, detail.as_bytes()) {
                                        let _ = on_message.send(InvokeResponseBody::Raw(frame));
                                    }
                                }
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
                        if terminal.claim() {
                            if let Ok(frame) = encode_frame(KIND_ERROR, error.as_bytes()) {
                                let _ = on_message.send(InvokeResponseBody::Raw(frame));
                            }
                        }
                        break;
                    }
                }
            }
            reader_core.begin_close();
            if let Ok(mut state) = reader_state.lock() {
                remove_if_token(&mut state.connections, &reader_key, reservation.token);
            }
        });
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?;
        if !consume_open_reservation(&mut state, &key, reservation) {
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
                    reader: reader_task,
                },
            },
        );
        if let Some(previous) = previous.as_ref() {
            previous.value.core.begin_close();
        }
        drop(state);
        if let Some(previous) = previous {
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
            remove_open_if_token(&mut state.opening, &key, expected);
            let connection = remove_if_token(&mut state.connections, &key, expected);
            if let Some(connection) = connection.as_ref() {
                connection.core.begin_close();
            }
            connection
        };
        if let Some(connection) = connection {
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

    #[test]
    fn configure_invalidates_every_pending_open_generation() {
        let manager = BackendPipeManager::default();
        manager.configure("first".to_string()).unwrap();
        let (_, reservation) = manager.reserve_open("provider:test").unwrap();

        manager.configure("second".to_string()).unwrap();

        let mut state = manager.inner.lock().unwrap();
        assert_ne!(state.generation, reservation.generation);
        assert!(state.opening.is_empty());
        assert_eq!(state.pipe_name.as_deref(), Some("second"));
        assert!(!consume_open_reservation(
            &mut state,
            "provider:test",
            reservation
        ));
    }

    #[test]
    fn superseded_open_cannot_cancel_the_new_reservation() {
        let manager = BackendPipeManager::default();
        manager.configure("pipe".to_string()).unwrap();
        let (_, first) = manager.reserve_open("sync:same").unwrap();
        let (_, second) = manager.reserve_open("sync:same").unwrap();

        manager.cancel_open("sync:same", first);

        let mut state = manager.inner.lock().unwrap();
        assert_eq!(state.opening.get("sync:same"), Some(&second));
        assert!(!consume_open_reservation(&mut state, "sync:same", first));
        assert!(consume_open_reservation(&mut state, "sync:same", second));
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
        let mut gate = TerminalGate::default();
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
}
