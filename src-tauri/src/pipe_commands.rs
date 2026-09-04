#[cfg(any(windows, unix))]
use crate::system_logs::system_log;
use serde_json::Value;
use std::sync::Mutex;
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
use std::sync::Arc;
#[cfg(any(windows, unix))]
use std::{collections::HashMap, time::Duration};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(any(windows, unix))]
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf},
    sync::Mutex as AsyncMutex,
    task::JoinHandle,
};

#[cfg(windows)]
type NativePipeStream = NamedPipeClient;
#[cfg(unix)]
type NativePipeStream = UnixStream;

#[cfg(any(windows, unix))]
struct PipeConnection {
    writer: Arc<AsyncMutex<WriteHalf<NativePipeStream>>>,
    reader: JoinHandle<()>,
}

#[derive(Default)]
struct PipeState {
    pipe_name: Option<String>,
    #[cfg(any(windows, unix))]
    connections: HashMap<String, PipeConnection>,
}

#[derive(Default)]
pub struct BackendPipeManager {
    inner: Mutex<PipeState>,
}

impl BackendPipeManager {
    #[cfg(any(windows, unix))]
    pub fn configure(&self, pipe_name: String) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?;
        for (_, connection) in state.connections.drain() {
            connection.reader.abort();
        }
        state.pipe_name = Some(pipe_name);
        Ok(())
    }

    pub fn close_all(&self) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?;
        #[cfg(any(windows, unix))]
        for (_, connection) in state.connections.drain() {
            connection.reader.abort();
        }
        state.pipe_name = None;
        Ok(())
    }
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
    let mut attempt = 0;
    loop {
        match ClientOptions::new().open(pipe_name) {
            Ok(client) => return Ok(client),
            Err(error) if started.elapsed() < Duration::from_secs(10) => {
                let _ = error;
                tokio::time::sleep(pipe_connect_retry_delay(attempt)).await;
                attempt += 1;
            }
            Err(error) => return Err(format!("failed to connect named pipe {pipe_name}: {error}")),
        }
    }
}

#[cfg(unix)]
async fn connect_pipe(pipe_name: &str) -> Result<NativePipeStream, String> {
    let started = tokio::time::Instant::now();
    let mut attempt = 0;
    loop {
        match UnixStream::connect(pipe_name).await {
            Ok(client) => return Ok(client),
            Err(error) if started.elapsed() < Duration::from_secs(10) => {
                let _ = error;
                tokio::time::sleep(pipe_connect_retry_delay(attempt)).await;
                attempt += 1;
            }
            Err(error) => return Err(format!("failed to connect Unix pipe {pipe_name}: {error}")),
        }
    }
}

#[cfg(any(windows, unix))]
fn pipe_connect_retry_delay(attempt: u32) -> Duration {
    // Concurrent channels can briefly exhaust the server's pending accept.
    // Retry quickly at startup, but back off if the backend really is absent.
    Duration::from_millis((2_u64 << attempt.min(6)).min(100))
}

#[tauri::command]
pub async fn backend_pipe_open(
    manager: State<'_, BackendPipeManager>,
    channel: String,
    name: String,
    on_message: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, channel, name, on_message);
        return Err("Pipe transport is unavailable on this platform".to_string());
    }

    #[cfg(any(windows, unix))]
    {
        let key = connection_key(&channel, &name);
        let pipe_name = manager
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?
            .pipe_name
            .clone()
            .ok_or_else(|| "pipe transport has not been started".to_string())?;
        system_log(
            "DEBUG",
            "pipe_transport",
            format!("Opening pipe channel channel={channel} name={name} pipe={pipe_name}"),
        );
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
        system_log(
            "INFO",
            "pipe_transport",
            format!("Pipe channel opened channel={channel} name={name}"),
        );

        let writer = Arc::new(AsyncMutex::new(writer));
        let reader_task = tokio::spawn(async move {
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
                                    "Pipe frame received channel={channel} name={name} kind={kind} bytes={}",
                                    payload.len()
                                ),
                            );
                        }
                        let frame = match encode_frame(kind, &payload) {
                            Ok(frame) => frame,
                            Err(_) => break,
                        };
                        if on_message.send(InvokeResponseBody::Raw(frame)).is_err() {
                            break;
                        }
                        if kind == KIND_CLOSE || kind == KIND_ERROR {
                            break;
                        }
                    }
                    Err(error) => {
                        system_log(
                            "ERROR",
                            "pipe_transport",
                            format!(
                                "Pipe channel read failed channel={channel} name={name}: {error}"
                            ),
                        );
                        if let Ok(frame) = encode_frame(KIND_ERROR, error.as_bytes()) {
                            let _ = on_message.send(InvokeResponseBody::Raw(frame));
                        }
                        break;
                    }
                }
            }
        });
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?;
        if let Some(previous) = state.connections.insert(
            key,
            PipeConnection {
                writer,
                reader: reader_task,
            },
        ) {
            previous.reader.abort();
        }
        Ok(())
    }
}

#[cfg(any(windows, unix))]
async fn send_frame(
    manager: &BackendPipeManager,
    channel: &str,
    name: &str,
    kind: u8,
    payload: &[u8],
) -> Result<(), String> {
    let writer = manager
        .inner
        .lock()
        .map_err(|_| "pipe transport state lock poisoned".to_string())?
        .connections
        .get(&connection_key(channel, name))
        .map(|connection| connection.writer.clone())
        .ok_or_else(|| format!("pipe channel is not open: {channel}:{name}"))?;
    let result = writer
        .lock()
        .await
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
) -> Result<(), String> {
    #[cfg(any(windows, unix))]
    return send_frame(
        &manager,
        &channel,
        &name,
        KIND_JSON,
        &serde_json::to_vec(&payload).map_err(|error| error.to_string())?,
    )
    .await;
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, channel, name, payload);
        Err("Pipe transport is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub async fn backend_pipe_send_bytes(
    manager: State<'_, BackendPipeManager>,
    channel: String,
    name: String,
    payload: Vec<u8>,
) -> Result<(), String> {
    #[cfg(any(windows, unix))]
    return send_frame(&manager, &channel, &name, KIND_BYTES, &payload).await;
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, channel, name, payload);
        Err("Pipe transport is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub async fn backend_pipe_close(
    manager: State<'_, BackendPipeManager>,
    channel: String,
    name: String,
) -> Result<(), String> {
    #[cfg(any(windows, unix))]
    {
        let key = connection_key(&channel, &name);
        let connection = manager
            .inner
            .lock()
            .map_err(|_| "pipe transport state lock poisoned".to_string())?
            .connections
            .remove(&key);
        if let Some(connection) = connection {
            let _ = connection
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
        let _ = (manager, channel, name);
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
    fn pipe_connect_retries_quickly_then_backs_off() {
        assert_eq!(pipe_connect_retry_delay(0), Duration::from_millis(2));
        assert_eq!(pipe_connect_retry_delay(1), Duration::from_millis(4));
        assert_eq!(pipe_connect_retry_delay(6), Duration::from_millis(100));
        assert_eq!(pipe_connect_retry_delay(u32::MAX), Duration::from_millis(100));
    }
}
