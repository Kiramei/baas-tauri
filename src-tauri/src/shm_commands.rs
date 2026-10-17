use serde_json::Value;
#[cfg(windows)]
use std::sync::Mutex;
#[cfg(not(mobile))]
use std::time::Duration;
#[cfg(windows)]
use tauri::ipc::InvokeBody;
use tauri::{
    ipc::{Channel, InvokeResponseBody, Request},
    State,
};

#[derive(Default)]
pub struct BackendShmManager {
    #[cfg(windows)]
    inner: Mutex<Option<std::sync::Arc<windows_impl::Session>>>,
}

impl BackendShmManager {
    #[cfg(not(mobile))]
    pub fn configure(&self, name: String) -> Result<(), String> {
        self.close_all()?;
        #[cfg(windows)]
        {
            let session = windows_impl::Session::create(&name)?;
            *self
                .inner
                .lock()
                .map_err(|_| "shared-memory manager lock poisoned")? = Some(session);
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = name;
            Err("Shared-memory transport currently requires Windows desktop".into())
        }
    }
    pub fn close_all(&self) -> Result<(), String> {
        #[cfg(windows)]
        if let Some(session) = self
            .inner
            .lock()
            .map_err(|_| "shared-memory manager lock poisoned")?
            .take()
        {
            session.fail("shared-memory session closed".into());
        }
        Ok(())
    }
    #[cfg(not(mobile))]
    pub fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.session()?.wait_ready(timeout)
        }
        #[cfg(not(windows))]
        {
            let _ = timeout;
            Err("Shared-memory transport currently requires Windows desktop".into())
        }
    }
    #[cfg(windows)]
    fn session(&self) -> Result<std::sync::Arc<windows_impl::Session>, String> {
        self.inner
            .lock()
            .map_err(|_| "shared-memory manager lock poisoned")?
            .clone()
            .ok_or_else(|| "shared-memory transport has not been started".into())
    }
}

impl Drop for BackendShmManager {
    fn drop(&mut self) {
        let _ = self.close_all();
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use crate::{
        shm_native::NativeSession,
        shm_protocol::{Decoder, MAX_PAYLOAD_BYTES},
        system_logs::system_log,
    };
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, AtomicU32, Ordering},
            Arc, Condvar,
        },
    };
    use tokio::sync::{mpsc, oneshot};

    struct Entry {
        key: String,
        on_message: Channel<InvokeResponseBody>,
        open_ack: Option<oneshot::Sender<Result<(), String>>>,
    }
    #[derive(Default)]
    struct Registry {
        routes: HashMap<String, u32>,
        streams: HashMap<u32, Entry>,
    }
    struct Outbound {
        stream: u32,
        kind: u8,
        payload: Vec<u8>,
        done: oneshot::Sender<Result<(), String>>,
        route: Option<String>,
    }

    pub struct Session {
        generation: String,
        native: NativeSession,
        registry: Mutex<Registry>,
        next_stream: AtomicU32,
        writer: Mutex<Option<mpsc::Sender<Outbound>>>,
        ready: Mutex<Option<Result<(), String>>>,
        ready_changed: Condvar,
        stopped: AtomicBool,
    }
    impl Session {
        pub fn create(name: &str) -> Result<Arc<Self>, String> {
            let (writer, mut receiver) = mpsc::channel::<Outbound>(32);
            let session = Arc::new(Self {
                generation: name.to_string(),
                native: NativeSession::create(name)?,
                registry: Mutex::new(Registry::default()),
                next_stream: AtomicU32::new(1),
                writer: Mutex::new(Some(writer)),
                ready: Mutex::new(None),
                ready_changed: Condvar::new(),
                stopped: AtomicBool::new(false),
            });
            let sending = session.clone();
            std::thread::Builder::new()
                .name("baas-shm-writer".into())
                .spawn(move || {
                    let mut index = 0;
                    while let Some(message) = receiver.blocking_recv() {
                        if let Some(key) = message.route.as_deref() {
                            let current = sending
                                .registry
                                .lock()
                                .ok()
                                .and_then(|registry| registry.routes.get(key).copied());
                            if current != Some(message.stream) {
                                let _ = message
                                    .done
                                    .send(Err("stale shared-memory connection identity".into()));
                                continue;
                            }
                        }
                        let result = sending.native.write_message(
                            &mut index,
                            message.stream,
                            message.kind,
                            &message.payload,
                        );
                        let failure = result.as_ref().err().cloned();
                        let _ = message.done.send(result);
                        if let Some(error) = failure {
                            sending.fail(error);
                            break;
                        }
                    }
                })
                .map_err(|e| e.to_string())?;
            let reading = session.clone();
            if let Err(error) = std::thread::Builder::new()
                .name("baas-shm-reader".into())
                .spawn(move || {
                    if let Err(error) = reading.read_loop() {
                        reading.fail(error);
                    }
                })
            {
                session.fail(error.to_string());
                return Err(error.to_string());
            }
            system_log(
                "INFO",
                "shm_transport",
                format!("Shared-memory session created name={name}"),
            );
            Ok(session)
        }

        pub fn fail(&self, error: String) {
            if self.stopped.swap(true, Ordering::AcqRel) {
                return;
            }
            self.native.stop();
            if let Ok(mut writer) = self.writer.lock() {
                writer.take();
            }
            if let Ok(mut ready) = self.ready.lock() {
                *ready = Some(Err(error.clone()));
                self.ready_changed.notify_all();
            }
            if let Ok(mut registry) = self.registry.lock() {
                registry.routes.clear();
                for (_, mut entry) in registry.streams.drain() {
                    if let Some(ack) = entry.open_ack.take() {
                        let _ = ack.send(Err(error.clone()));
                    }
                    let mut frame = b"BPIP\x01\x04".to_vec();
                    frame.extend_from_slice(&(error.len() as u32).to_le_bytes());
                    frame.extend_from_slice(error.as_bytes());
                    let _ = entry.on_message.send(InvokeResponseBody::Raw(frame));
                }
            }
            system_log("INFO", "shm_transport", error);
        }

        pub fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
            let ready = self
                .ready
                .lock()
                .map_err(|_| "shared-memory ready lock poisoned")?;
            let (ready, outcome) = self
                .ready_changed
                .wait_timeout_while(ready, timeout, |state| state.is_none())
                .map_err(|_| "shared-memory ready lock poisoned")?;
            if outcome.timed_out() && ready.is_none() {
                drop(ready);
                self.fail("shared-memory backend READY timed out".into());
                return Err("shared-memory backend READY timed out".into());
            }
            ready
                .as_ref()
                .cloned()
                .unwrap_or_else(|| Err("shared-memory backend READY missing".into()))
        }

        pub async fn send(&self, stream: u32, kind: u8, payload: Vec<u8>) -> Result<(), String> {
            self.enqueue(stream, kind, payload, None).await
        }
        pub async fn send_routed(
            &self,
            channel: &str,
            name: &str,
            connection_id: &str,
            kind: u8,
            payload: Vec<u8>,
        ) -> Result<(), String> {
            let stream = self.route_checked(channel, name, connection_id)?;
            self.enqueue(stream, kind, payload, Some(format!("{channel}:{name}")))
                .await
        }
        async fn enqueue(
            &self,
            stream: u32,
            kind: u8,
            payload: Vec<u8>,
            route: Option<String>,
        ) -> Result<(), String> {
            if stream == 0 || payload.len() > MAX_PAYLOAD_BYTES || !(1..=4).contains(&kind) {
                return Err("invalid shared-memory outbound message".into());
            }
            let writer = self
                .writer
                .lock()
                .map_err(|_| "shared-memory writer lock poisoned")?
                .clone()
                .ok_or("shared-memory session stopped")?;
            let (done, result) = oneshot::channel();
            writer
                .send(Outbound {
                    stream,
                    kind,
                    payload,
                    done,
                    route,
                })
                .await
                .map_err(|_| "shared-memory writer stopped")?;
            result
                .await
                .map_err(|_| "shared-memory writer stopped".to_string())?
        }

        fn read_loop(&self) -> Result<(), String> {
            let mut index = 0;
            let mut decoder = Decoder::default();
            let mut peer = None;
            loop {
                let mut pending: HashMap<u32, Vec<u8>> = HashMap::new();
                let mut count = 0;
                // A blocking first read then only already-available slots: no
                // batching delay is introduced on quiet control channels.
                loop {
                    let received =
                        self.native
                            .read_chunk(&mut index, count == 0, peer.as_ref(), |chunk| {
                                decoder.push(chunk)
                            })?;
                    let Some(messages) = received else {
                        break;
                    };
                    count += 1;
                    for (stream, frame) in messages {
                        let kind = frame[5];
                        if stream == 0 {
                            if kind != 1 {
                                return Err("invalid shared-memory control kind".into());
                            }
                            let ready: Value = serde_json::from_slice(&frame[10..])
                                .map_err(|e| format!("invalid shared-memory READY: {e}"))?;
                            if ready.get("type").and_then(Value::as_str) != Some("ready")
                                || ready.get("transport").and_then(Value::as_str) != Some("shm")
                                || ready.get("version").and_then(Value::as_u64) != Some(1)
                            {
                                return Err("invalid shared-memory READY handshake".into());
                            }
                            peer = self.native.peer_process()?;
                            *self
                                .ready
                                .lock()
                                .map_err(|_| "shared-memory ready lock poisoned")? = Some(Ok(()));
                            self.ready_changed.notify_all();
                            continue;
                        }
                        let mut registry = self
                            .registry
                            .lock()
                            .map_err(|_| "shared-memory registry lock poisoned")?;
                        let Some(entry) = registry.streams.get_mut(&stream) else {
                            continue;
                        };
                        if let Some(ack) = entry.open_ack.take() {
                            let response: Result<Value, _> = serde_json::from_slice(&frame[10..]);
                            if kind == 1
                                && response
                                    .as_ref()
                                    .ok()
                                    .and_then(|v| v.get("type"))
                                    .and_then(Value::as_str)
                                    == Some("open_ok")
                            {
                                let _ = ack.send(Ok(()));
                                continue;
                            }
                            let error = format!(
                                "shared-memory stream open failed: {}",
                                String::from_utf8_lossy(&frame[10..])
                            );
                            let _ = ack.send(Err(error));
                        }
                        drop(registry);
                        let batch = pending.entry(stream).or_default();
                        if batch.len() + frame.len() > 256 * 1024 && !batch.is_empty() {
                            self.deliver(stream, std::mem::take(batch));
                        }
                        if batch.is_empty() {
                            *batch = frame;
                        } else {
                            batch.extend(frame);
                        }
                        if kind == 3 || kind == 4 {
                            if let Some(batch) = pending.remove(&stream) {
                                self.deliver(stream, batch);
                            }
                            self.remove_stream(stream);
                        }
                    }
                    if count >= SLOT_COUNT_BATCH {
                        break;
                    }
                }
                for (stream, frame) in pending {
                    self.deliver(stream, frame);
                }
            }
        }
        fn deliver(&self, stream: u32, frame: Vec<u8>) {
            if let Ok(registry) = self.registry.lock() {
                if let Some(entry) = registry.streams.get(&stream) {
                    let _ = entry.on_message.send(InvokeResponseBody::Raw(frame));
                }
            }
        }
        pub async fn open(
            &self,
            channel: String,
            name: String,
            on_message: Channel<InvokeResponseBody>,
        ) -> Result<String, String> {
            if !matches!(channel.as_str(), "provider" | "sync" | "trigger" | "remote") {
                return Err("invalid shared-memory channel".into());
            }
            let stream = self.next_stream.fetch_add(1, Ordering::Relaxed);
            if stream == 0 {
                return Err("shared-memory stream identifiers exhausted".into());
            }
            let key = format!("{channel}:{name}");
            let (ack, opened) = oneshot::channel();
            let previous = {
                let mut registry = self
                    .registry
                    .lock()
                    .map_err(|_| "shared-memory registry lock poisoned")?;
                registry.streams.insert(
                    stream,
                    Entry {
                        key: key.clone(),
                        on_message,
                        open_ack: Some(ack),
                    },
                );
                let previous = registry.routes.insert(key.clone(), stream);
                if let Some(previous) = previous {
                    registry.streams.remove(&previous);
                }
                previous
            };
            if let Some(previous) = previous {
                let _ = self.send(previous, 3, Vec::new()).await;
            }
            let payload = serde_json::to_vec(
                &serde_json::json!({"type":"open", "channel":channel,"name":name}),
            )
            .map_err(|e| e.to_string())?;
            let result = async {
                self.send(stream, 1, payload).await?;
                tokio::time::timeout(Duration::from_secs(15), opened)
                    .await
                    .map_err(|_| "shared-memory stream open timed out".to_string())?
                    .map_err(|_| "shared-memory stream open cancelled".to_string())?
            }
            .await;
            if result.is_err() {
                // A replacement open can own the same route by the time an old
                // acknowledgement is cancelled. Only remove this stream.
                self.remove_stream(stream);
            }
            result.map(|()| self.connection_id(stream))
        }
        fn connection_id(&self, stream: u32) -> String {
            format!("{}:{stream}", self.generation)
        }
        pub fn route_checked(
            &self,
            channel: &str,
            name: &str,
            connection_id: &str,
        ) -> Result<u32, String> {
            let stream = self.route(channel, name)?;
            if self.connection_id(stream) != connection_id {
                return Err("stale shared-memory connection identity".into());
            }
            Ok(stream)
        }
        pub fn route(&self, channel: &str, name: &str) -> Result<u32, String> {
            self.registry
                .lock()
                .map_err(|_| "shared-memory registry lock poisoned")?
                .routes
                .get(&format!("{channel}:{name}"))
                .copied()
                .ok_or_else(|| format!("shared-memory channel is not open: {channel}:{name}"))
        }
        pub fn remove_checked(&self, key: &str, connection_id: &str) -> Option<u32> {
            let mut registry = self.registry.lock().ok()?;
            let stream = *registry.routes.get(key)?;
            if self.connection_id(stream) != connection_id {
                return None;
            }
            registry.routes.remove(key);
            registry.streams.remove(&stream);
            Some(stream)
        }
        fn remove_stream(&self, stream: u32) {
            if let Ok(mut registry) = self.registry.lock() {
                if let Some(entry) = registry.streams.remove(&stream) {
                    if registry.routes.get(&entry.key) == Some(&stream) {
                        registry.routes.remove(&entry.key);
                    }
                }
            }
        }
    }
    const SLOT_COUNT_BATCH: usize = 64;

    #[cfg(test)]
    mod tests {
        use super::*;

        fn session() -> Arc<Session> {
            Session::create(&format!("baas-shm-test-{}", uuid::Uuid::new_v4())).unwrap()
        }
        fn channel() -> (
            Channel<InvokeResponseBody>,
            std::sync::mpsc::Receiver<Vec<u8>>,
        ) {
            let (sender, receiver) = std::sync::mpsc::channel();
            (
                Channel::new(move |body| {
                    if let InvokeResponseBody::Raw(bytes) = body {
                        let _ = sender.send(bytes);
                    }
                    Ok(())
                }),
                receiver,
            )
        }
        async fn wait_route(session: &Session, key: &str, previous: Option<u32>) -> u32 {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Some(stream) = session.registry.lock().unwrap().routes.get(key).copied()
                    {
                        if Some(stream) != previous {
                            return stream;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap()
        }
        #[tokio::test]
        async fn cancelled_old_open_cannot_remove_the_new_stream_for_the_same_route() {
            let session = session();
            let old = session.clone();
            let (old_channel, _) = channel();
            let old_open = tokio::spawn(async move {
                old.open("provider".into(), "same".into(), old_channel)
                    .await
            });
            let old_stream = wait_route(&session, "provider:same", None).await;
            let new = session.clone();
            let (new_channel, _) = channel();
            let new_open = tokio::spawn(async move {
                new.open("provider".into(), "same".into(), new_channel)
                    .await
            });
            let new_stream = wait_route(&session, "provider:same", Some(old_stream)).await;
            assert!(tokio::time::timeout(Duration::from_secs(2), old_open)
                .await
                .unwrap()
                .unwrap()
                .is_err());
            assert_eq!(session.route("provider", "same").unwrap(), new_stream);
            let ack = session
                .registry
                .lock()
                .unwrap()
                .streams
                .get_mut(&new_stream)
                .unwrap()
                .open_ack
                .take()
                .unwrap();
            ack.send(Ok(())).unwrap();
            assert!(new_open.await.unwrap().is_ok());
            assert_eq!(session.route("provider", "same").unwrap(), new_stream);
            let old_id = session.connection_id(old_stream);
            assert!(session
                .send_routed("provider", "same", &old_id, 1, b"{}".to_vec())
                .await
                .is_err());
            assert!(session.remove_checked("provider:same", &old_id).is_none());
            assert_eq!(session.route("provider", "same").unwrap(), new_stream);
            // Even a send validated before replacement is checked again by the
            // writer before it can become a late packet for a retired stream.
            assert!(session
                .enqueue(old_stream, 1, b"{}".to_vec(), Some("provider:same".into()))
                .await
                .is_err());
            assert!(!session.stopped.load(Ordering::Acquire));
            session.fail("test complete".into());
        }
        #[test]
        fn session_generation_protects_reused_stream_numbers() {
            let old = session();
            let new = session();
            let key = "provider:same";
            for session in [&old, &new] {
                let (on_message, _) = channel();
                let mut registry = session.registry.lock().unwrap();
                registry.routes.insert(key.into(), 1);
                registry.streams.insert(
                    1,
                    Entry {
                        key: key.into(),
                        on_message,
                        open_ack: None,
                    },
                );
            }
            let old_id = old.connection_id(1);
            assert_ne!(old_id, new.connection_id(1));
            assert!(new.route_checked("provider", "same", &old_id).is_err());
            assert!(new.remove_checked(key, &old_id).is_none());
            assert_eq!(new.route("provider", "same").unwrap(), 1);
            old.fail("test complete".into());
            new.fail("test complete".into());
        }
        #[test]
        fn ready_timeout_and_reconfigure_stop_the_old_generation() {
            let manager = BackendShmManager::default();
            manager
                .configure(format!("baas-shm-test-{}", uuid::Uuid::new_v4()))
                .unwrap();
            let old = manager.session().unwrap();
            manager
                .configure(format!("baas-shm-test-{}", uuid::Uuid::new_v4()))
                .unwrap();
            assert!(old.stopped.load(Ordering::Acquire));
            let current = manager.session().unwrap();
            assert!(manager
                .wait_ready(Duration::from_millis(1))
                .unwrap_err()
                .contains("timed out"));
            assert!(current.stopped.load(Ordering::Acquire));
            manager.close_all().unwrap();
            assert!(manager.session().is_err());
        }
        #[tokio::test]
        async fn real_python_terminal_reopen_and_process_exit_release_streams() {
            let backend = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("baas-dev");
            let python = std::env::var_os("BAAS_SHM_TEST_PYTHON")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| backend.join(".venv/Scripts/python.exe"));
            let fixture = backend.join("tests/service/shm_echo_peer.py");
            if !python.is_file() || !fixture.is_file() {
                eprintln!("shared-memory cross-repository fixture unavailable; native lifecycle unit tests still run");
                return;
            }
            struct Child(std::process::Child);
            impl Drop for Child {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let base = format!("baas-shm-test-{}", uuid::Uuid::new_v4());
            let session = Session::create(&base).unwrap();
            let mut child = Child(
                std::process::Command::new(python)
                    .arg(fixture)
                    .args(["--shm-name", &base])
                    .current_dir(&backend)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::inherit())
                    .spawn()
                    .unwrap(),
            );
            session.wait_ready(Duration::from_secs(10)).unwrap();
            let (first, first_messages) = channel();
            session
                .open("provider".into(), "same".into(), first)
                .await
                .unwrap();
            let stream = session.route("provider", "same").unwrap();
            session
                .send(stream, 1, br#"{"messages":["json"]}"#.to_vec())
                .await
                .unwrap();
            let payload =
                serde_json::to_vec(&serde_json::json!({"data":"x".repeat(100_000)})).unwrap();
            session.send(stream, 1, payload.clone()).await.unwrap();
            let mut saw_json = false;
            let mut saw_close = false;
            while !saw_close {
                let frames = first_messages.recv_timeout(Duration::from_secs(5)).unwrap();
                let mut offset = 0;
                while offset < frames.len() {
                    let length =
                        u32::from_le_bytes(frames[offset + 6..offset + 10].try_into().unwrap())
                            as usize;
                    if frames[offset + 5] == 1 {
                        assert_eq!(
                            &frames[offset + 10..offset + 10 + length],
                            payload.as_slice()
                        );
                        saw_json = true;
                    }
                    if frames[offset + 5] == 3 {
                        saw_close = true;
                    }
                    offset += 10 + length;
                }
            }
            assert!(saw_json);
            // Terminal delivery and removal happen on the reader thread.
            for _ in 0..100 {
                if session.route("provider", "same").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(session.route("provider", "same").is_err());
            let (second, second_messages) = channel();
            session
                .open("provider".into(), "same".into(), second)
                .await
                .unwrap();
            assert!(session.route("provider", "same").unwrap() > stream);
            child.0.kill().unwrap();
            child.0.wait().unwrap();
            let error = second_messages
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            assert_eq!(error[5], 4);
            assert!(String::from_utf8_lossy(&error[10..]).contains("process exited"));
            assert!(session.route("provider", "same").is_err());
            assert!(session.wait_ready(Duration::from_millis(1)).is_err());
            session.fail("test complete".into());
        }
    }
}

#[tauri::command]
pub async fn backend_shm_open(
    manager: State<'_, BackendShmManager>,
    channel: String,
    name: String,
    on_message: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        let session = manager.session()?;
        let waiting = session.clone();
        tokio::task::spawn_blocking(move || waiting.wait_ready(Duration::from_secs(15)))
            .await
            .map_err(|error| error.to_string())??;
        session.open(channel, name, on_message).await
    }
    #[cfg(not(windows))]
    {
        let _ = (manager, channel, name, on_message);
        Err("Shared-memory transport currently requires Windows desktop".into())
    }
}
#[tauri::command]
pub async fn backend_shm_send_json(
    manager: State<'_, BackendShmManager>,
    channel: String,
    name: String,
    payload: Value,
    connection_id: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let session = manager.session()?;
        session
            .send_routed(
                &channel,
                &name,
                &connection_id,
                1,
                serde_json::to_vec(&payload).map_err(|e| e.to_string())?,
            )
            .await
    }
    #[cfg(not(windows))]
    {
        let _ = (manager, channel, name, payload, connection_id);
        Err("Shared-memory transport currently requires Windows desktop".into())
    }
}
#[tauri::command]
pub async fn backend_shm_send_bytes(
    manager: State<'_, BackendShmManager>,
    request: Request<'_>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let session = manager.session()?;
        let raw = match request.body() {
            InvokeBody::Raw(raw) => raw,
            _ => return Err("shared-memory binary request requires a raw body".into()),
        };
        let (channel, name, payload) = crate::pipe_commands::decode_binary_request(raw)?;
        let connection_id = request
            .headers()
            .get("x-baas-connection-id")
            .ok_or("shared-memory binary request omitted connection identity")?
            .to_str()
            .map_err(|_| "invalid shared-memory connection identity")?;
        session
            .send_routed(channel, name, connection_id, 2, payload.to_vec())
            .await
    }
    #[cfg(not(windows))]
    {
        let _ = (manager, request);
        Err("Shared-memory transport currently requires Windows desktop".into())
    }
}
#[tauri::command]
pub async fn backend_shm_close(
    manager: State<'_, BackendShmManager>,
    channel: String,
    name: String,
    connection_id: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let session = manager.session()?;
        if let Some(stream) = session.remove_checked(&format!("{channel}:{name}"), &connection_id) {
            session.send(stream, 3, Vec::new()).await?;
        }
    }
    #[cfg(not(windows))]
    let _ = (manager, channel, name, connection_id);
    Ok(())
}
#[tauri::command]
pub fn backend_shm_close_all(manager: State<'_, BackendShmManager>) -> Result<(), String> {
    manager.close_all()
}
