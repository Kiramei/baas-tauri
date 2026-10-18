#[cfg(any(windows, unix))]
use crate::system_logs::system_log;
use serde_json::Value;
use std::sync::Mutex;
use tauri::{
    ipc::{Channel, InvokeBody, InvokeResponseBody, Request},
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
const READ_BUFFER_BYTES: usize = 64 * 1024;
#[cfg(any(windows, unix))]
const MAX_BATCH_BYTES: usize = 256 * 1024;
#[cfg(any(windows, unix))]
const MAX_BATCH_FRAMES: usize = 128;
#[cfg(any(windows, unix))]
const BINARY_REQUEST_HEADER_BYTES: usize = 8;

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
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, WriteHalf},
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
fn frame_payload_length(header: &[u8]) -> Result<usize, String> {
    if &header[..4] != MAGIC || header[4] != VERSION {
        return Err("invalid pipe frame header".to_string());
    }
    let length = u32::from_le_bytes(header[6..10].try_into().unwrap()) as usize;
    if length > MAX_PAYLOAD_BYTES {
        return Err("pipe payload exceeds the 64 MiB limit".to_string());
    }
    Ok(length)
}

#[cfg(any(windows, unix))]
async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<(u8, Vec<u8>), String> {
    let mut header = [0_u8; HEADER_BYTES];
    reader
        .read_exact(&mut header)
        .await
        .map_err(|error| format!("pipe read failed: {error}"))?;
    let length = frame_payload_length(&header)?;
    // Preserve the wire frame instead of allocating a payload and copying it into
    // a second frame before handing it to the WebView.
    let mut frame = vec![0_u8; HEADER_BYTES + length];
    frame[..HEADER_BYTES].copy_from_slice(&header);
    reader
        .read_exact(&mut frame[HEADER_BYTES..])
        .await
        .map_err(|error| format!("pipe payload read failed: {error}"))?;
    Ok((header[5], frame))
}

#[cfg(any(windows, unix))]
async fn read_batch<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    batch_frames: bool,
) -> Result<(Vec<u8>, usize, bool), String> {
    let (kind, mut batch) = read_frame(reader).await?;
    let mut count = 1;
    let mut terminal = kind == KIND_CLOSE || kind == KIND_ERROR;
    // Only coalesce complete frames already prefetched by this read. Waiting for
    // another frame here would trade latency for throughput on quiet channels.
    while batch_frames && !terminal && count < MAX_BATCH_FRAMES {
        let buffered = reader.buffer();
        if buffered.len() < HEADER_BYTES {
            break;
        }
        let Ok(length) = frame_payload_length(&buffered[..HEADER_BYTES]) else {
            // Deliver earlier valid frames first; the next read reports the error.
            break;
        };
        let frame_bytes = HEADER_BYTES + length;
        if buffered.len() < frame_bytes || batch.len() + frame_bytes > MAX_BATCH_BYTES {
            break;
        }
        terminal = buffered[5] == KIND_CLOSE || buffered[5] == KIND_ERROR;
        batch.extend_from_slice(&buffered[..frame_bytes]);
        reader.consume(frame_bytes);
        count += 1;
    }
    Ok((batch, count, terminal))
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
    batch_frames: Option<bool>,
) -> Result<(), String> {
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, channel, name, on_message, batch_frames);
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
        let (reader, mut writer) = tokio::io::split(client);
        let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, reader);
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
            serde_json::from_slice(&payload[HEADER_BYTES..]).map_err(|error| error.to_string())?;
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
                match read_batch(&mut reader, batch_frames.unwrap_or(false)).await {
                    Ok((frame, count, terminal)) => {
                        received_frames += count as u64;
                        if received_frames <= 3 {
                            system_log(
                                "DEBUG",
                                "pipe_transport",
                                format!(
                                    "Pipe batch received channel={channel} name={name} frames={count} bytes={}",
                                    frame.len()
                                ),
                            );
                        }
                        if on_message.send(InvokeResponseBody::Raw(frame)).is_err() {
                            break;
                        }
                        if terminal {
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
    request: Request<'_>,
) -> Result<(), String> {
    #[cfg(any(windows, unix))]
    {
        match request.body() {
            InvokeBody::Raw(raw) => {
                let (channel, name, payload) = decode_binary_request(raw)?;
                send_frame(&manager, channel, name, KIND_BYTES, payload).await
            }
            InvokeBody::Json(value) => {
                // Keep compatibility with existing callers using JSON number[].
                #[derive(serde::Deserialize)]
                struct LegacyRequest {
                    channel: String,
                    name: String,
                    payload: Vec<u8>,
                }
                let legacy: LegacyRequest =
                    serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
                send_frame(
                    &manager,
                    &legacy.channel,
                    &legacy.name,
                    KIND_BYTES,
                    &legacy.payload,
                )
                .await
            }
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (manager, request);
        Err("Pipe transport is unavailable on this platform".to_string())
    }
}

#[cfg(any(windows, unix))]
pub(crate) fn decode_binary_request(raw: &[u8]) -> Result<(&str, &str, &[u8]), String> {
    if raw.len() < BINARY_REQUEST_HEADER_BYTES || &raw[..4] != b"BPRQ" || raw[4] != VERSION {
        return Err("invalid pipe binary request header".to_string());
    }
    let channel = match raw[5] {
        1 => "provider",
        2 => "sync",
        3 => "trigger",
        4 => "remote",
        _ => return Err("invalid pipe binary request channel".to_string()),
    };
    let name_end = BINARY_REQUEST_HEADER_BYTES + u16::from_le_bytes([raw[6], raw[7]]) as usize;
    if name_end > raw.len() {
        return Err("truncated pipe binary request name".to_string());
    }
    if raw.len() - name_end > MAX_PAYLOAD_BYTES {
        return Err("pipe payload exceeds the 64 MiB limit".to_string());
    }
    let name = std::str::from_utf8(&raw[BINARY_REQUEST_HEADER_BYTES..name_end])
        .map_err(|error| format!("pipe binary request name is not UTF-8: {error}"))?;
    Ok((channel, name, &raw[name_end..]))
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

    #[tokio::test]
    async fn pipe_batch_preserves_burst_order_with_fewer_webview_callbacks() {
        let mut wire = Vec::new();
        for sequence in 0..1000_u32 {
            let mut payload = vec![0_u8; 256];
            payload[..4].copy_from_slice(&sequence.to_le_bytes());
            wire.extend(encode_frame(KIND_BYTES, &payload).unwrap());
        }
        let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, wire.as_slice());
        let mut received = Vec::new();
        let mut frames = 0;
        let mut callbacks = 0;
        while frames < 1000 {
            let (batch, count, terminal) = read_batch(&mut reader, true).await.unwrap();
            assert!(count <= MAX_BATCH_FRAMES);
            assert!(batch.len() <= MAX_BATCH_BYTES);
            assert!(!terminal);
            received.extend(batch);
            frames += count;
            callbacks += 1;
        }
        assert_eq!(received, wire);
        eprintln!(
            "pipe burst fixture: frames={frames} callbacks={callbacks} bytes={}",
            wire.len()
        );
        assert!(
            callbacks < 12,
            "expected coalesced callbacks, got {callbacks}"
        );
    }

    #[tokio::test]
    async fn pipe_batch_never_waits_for_an_incomplete_following_frame() {
        let first = encode_frame(KIND_JSON, b"{}").unwrap();
        let second = encode_frame(KIND_BYTES, &[1, 2, 3]).unwrap();
        let (mut writer, stream) = tokio::io::duplex(1024);
        writer.write_all(&first).await.unwrap();
        writer.write_all(&second[..HEADER_BYTES + 1]).await.unwrap();
        let mut reader = BufReader::new(stream);
        let (batch, count, terminal) =
            tokio::time::timeout(Duration::from_millis(100), read_batch(&mut reader, true))
                .await
                .expect("batch waited for a future frame")
                .unwrap();
        assert_eq!(batch, first);
        assert_eq!(count, 1);
        assert!(!terminal);
        writer.write_all(&second[HEADER_BYTES + 1..]).await.unwrap();
        assert_eq!(read_batch(&mut reader, true).await.unwrap().0, second);
    }

    #[tokio::test]
    async fn pipe_batch_stops_at_close_and_supports_legacy_single_frames() {
        let first = encode_frame(KIND_JSON, b"{}").unwrap();
        let close = encode_frame(KIND_CLOSE, &[]).unwrap();
        let wire = [first.clone(), close.clone(), first.clone()].concat();
        let mut reader = BufReader::new(wire.as_slice());
        let (batch, count, terminal) = read_batch(&mut reader, true).await.unwrap();
        assert_eq!(batch, [first.clone(), close].concat());
        assert_eq!(count, 2);
        assert!(terminal);
        assert_eq!(read_batch(&mut reader, false).await.unwrap().0, first);

        let mut legacy = BufReader::new(wire.as_slice());
        let (batch, count, terminal) = read_batch(&mut legacy, false).await.unwrap();
        assert_eq!(batch, first);
        assert_eq!(count, 1);
        assert!(!terminal);
    }

    #[tokio::test]
    async fn pipe_batch_preserves_valid_frame_before_reporting_corrupt_header() {
        let first = encode_frame(KIND_JSON, b"{}").unwrap();
        let wire = [first.clone(), vec![0; HEADER_BYTES]].concat();
        let mut reader = BufReader::new(wire.as_slice());
        assert_eq!(read_batch(&mut reader, true).await.unwrap().0, first);
        assert!(read_batch(&mut reader, true).await.is_err());
    }

    #[tokio::test]
    async fn pipe_frame_rejects_oversized_payload_before_allocation() {
        let mut header = encode_frame(KIND_BYTES, &[]).unwrap();
        header[6..10].copy_from_slice(&((MAX_PAYLOAD_BYTES + 1) as u32).to_le_bytes());
        assert!(read_frame(&mut header.as_slice()).await.is_err());
    }

    #[test]
    fn pipe_binary_request_preserves_utf8_route_and_borrowed_payload() {
        let name = "remote-配置";
        let mut raw = b"BPRQ\x01\x04".to_vec();
        raw.extend_from_slice(&(name.len() as u16).to_le_bytes());
        raw.extend_from_slice(name.as_bytes());
        raw.extend_from_slice(&[0, 1, 255]);
        let (channel, decoded_name, payload) = decode_binary_request(&raw).unwrap();
        assert_eq!(channel, "remote");
        assert_eq!(decoded_name, name);
        assert_eq!(payload, &[0, 1, 255]);
        assert_eq!(payload.as_ptr(), raw[raw.len() - 3..].as_ptr());
        for end in 0..BINARY_REQUEST_HEADER_BYTES + name.len() {
            assert!(decode_binary_request(&raw[..end]).is_err());
        }
        raw[5] = 255;
        assert!(decode_binary_request(&raw).is_err());
    }

    #[test]
    fn pipe_connect_retries_quickly_then_backs_off() {
        assert_eq!(pipe_connect_retry_delay(0), Duration::from_millis(2));
        assert_eq!(pipe_connect_retry_delay(1), Duration::from_millis(4));
        assert_eq!(pipe_connect_retry_delay(6), Duration::from_millis(100));
        assert_eq!(
            pipe_connect_retry_delay(u32::MAX),
            Duration::from_millis(100)
        );
    }
}
