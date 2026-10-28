//! Cross-language native IPC validation; never connects to an emulator.
//! cargo run -p baas-tauri --example shm_native_probe -- <python> <baas-dev>
#![allow(dead_code)]
#[cfg(windows)]
#[path = "../src/shm_native/windows.rs"]
mod shm_native;
#[cfg(target_os = "linux")]
#[path = "../src/shm_native/linux.rs"]
mod shm_native;
#[path = "../src/shm_protocol.rs"]
mod shm_protocol;

#[cfg(any(windows, target_os = "linux"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use shm_native::{NativeSession, PeerProcess};
    use shm_protocol::{Decoder, MAX_PAYLOAD_BYTES};
    use std::{
        collections::VecDeque,
        path::Path,
        process::{Child, Command},
        sync::{mpsc, Arc},
        thread::JoinHandle,
        time::{Duration, Instant},
    };

    struct Reader {
        index: usize,
        decoder: Decoder,
        ready: VecDeque<(u32, Vec<u8>)>,
        peer: Option<PeerProcess>,
    }
    impl Reader {
        fn next(&mut self, session: &NativeSession) -> Result<(u32, Vec<u8>), String> {
            loop {
                if let Some(message) = self.ready.pop_front() {
                    return Ok(message);
                }
                session.read_chunk(&mut self.index, true, self.peer.as_ref(), |chunk| {
                    self.ready.extend(self.decoder.push(chunk)?);
                    Ok(())
                })?;
            }
        }
    }

    // Every early return releases this fixture's process and the watchdog's Arc.
    // It never owns or terminates a normal BAAS/game process.
    struct NativePeer {
        session: Arc<NativeSession>,
        child: Child,
        watchdog_tx: mpsc::Sender<()>,
        watchdog: Option<JoinHandle<()>>,
    }
    impl Drop for NativePeer {
        fn drop(&mut self) {
            self.session.stop();
            let _ = self.watchdog_tx.send(());
            if let Some(watchdog) = self.watchdog.take() {
                let _ = watchdog.join();
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
    fn start_peer(python: &str, backend: &str, base: &str) -> Result<NativePeer, String> {
        let session = Arc::new(NativeSession::create(base)?);
        let mut command = Command::new(python);
        command
            .arg(Path::new(backend).join("tests/service/shm_echo_peer.py"))
            .args(["--shm-name", base])
            .current_dir(backend)
            .env("PYTHONDONTWRITEBYTECODE", "1");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command.spawn().map_err(|e| e.to_string())?;
        let (watchdog_tx, watchdog_rx) = mpsc::channel::<()>();
        let watchdog_session = Arc::clone(&session);
        let watchdog = std::thread::spawn(move || {
            if watchdog_rx.recv_timeout(Duration::from_secs(90)).is_err() {
                watchdog_session.stop();
            }
        });
        Ok(NativePeer {
            session,
            child,
            watchdog_tx,
            watchdog: Some(watchdog),
        })
    }
    fn ready_reader(session: &NativeSession, base: &str) -> Result<Reader, String> {
        let mut reader = Reader {
            index: 0,
            decoder: Decoder::default(),
            ready: VecDeque::new(),
            peer: None,
        };
        let (stream, ready) = reader.next(session)?;
        let ready = json_frame(&ready)?;
        if stream != 0
            || ready["type"] != "ready"
            || ready["transport"] != "shm"
            || ready["version"] != 1
        {
            return Err("Python did not publish the expected READY".into());
        }
        reader.peer = session.peer_process()?;
        if reader.peer.is_none() {
            return Err("native shared-memory peer exit monitoring is unavailable".into());
        }
        // The two peers already hold every resource. POSIX names can be removed
        // now so an abruptly terminated owner cannot leave named IPC objects.
        ensure_resources_removed(base)?;
        Ok(reader)
    }
    fn json_frame(frame: &[u8]) -> Result<serde_json::Value, String> {
        if frame.len() < 10 || &frame[..6] != b"BPIP\x01\x01" {
            return Err("expected a JSON frame".into());
        }
        serde_json::from_slice(&frame[10..]).map_err(|e| e.to_string())
    }
    fn expect_echo(
        reader: &mut Reader,
        session: &NativeSession,
        stream: u32,
        kind: u8,
        payload: &[u8],
    ) -> Result<(), String> {
        let (received_stream, frame) = reader.next(session)?;
        if received_stream != stream
            || frame.len() != 10 + payload.len()
            || frame[5] != kind
            || frame[10..] != *payload
        {
            return Err(format!(
                "stream {stream} echo mismatch: {} bytes",
                payload.len()
            ));
        }
        Ok(())
    }
    fn open_echo(
        reader: &mut Reader,
        session: &NativeSession,
        write_index: &mut usize,
        stream: u32,
    ) -> Result<(), String> {
        session.write_message(
            write_index,
            stream,
            1,
            br#"{"type":"open","channel":"echo","name":"native-probe"}"#,
        )?;
        let (received_stream, opened) = reader.next(session)?;
        if received_stream != stream || json_frame(&opened)?["type"] != "open_ok" {
            return Err("echo channel failed to open".into());
        }
        Ok(())
    }
    fn expect_close(
        reader: &mut Reader,
        session: &NativeSession,
        stream: u32,
    ) -> Result<(), String> {
        let (received_stream, closed) = reader.next(session)?;
        if received_stream != stream || closed.len() != 10 || closed[5] != 3 {
            return Err("echo handler did not close the completed stream".into());
        }
        Ok(())
    }
    fn ensure_resources_removed(base: &str) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        for name in [
            base.to_string(),
            format!("sem.{base}_stop"),
            format!("sem.{base}_r2p_free"),
            format!("sem.{base}_r2p_used"),
            format!("sem.{base}_p2r_free"),
            format!("sem.{base}_p2r_used"),
        ] {
            if Path::new("/dev/shm").join(&name).exists() {
                return Err(format!("native IPC resource leaked: /dev/shm/{name}"));
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = base;
        Ok(())
    }
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("expected Python executable and baas-dev repository path".into());
    }
    let base = format!("baas-shm-probe-{}", uuid::Uuid::new_v4());
    let mut peer = start_peer(&args[0], &args[1], &base)?;
    let session = Arc::clone(&peer.session);
    let result = (|| -> Result<serde_json::Value, String> {
        let mut reader = ready_reader(&session, &base)?;
        let mut write_index = 0;
        open_echo(&mut reader, &session, &mut write_index, 1)?;
        let binary_sizes = [
            0,
            1,
            65_522,
            65_523,
            65_532,
            65_533,
            4_194_427,
            8_388_625,
            MAX_PAYLOAD_BYTES,
        ];
        let mut types = vec!["json"];
        types.extend(std::iter::repeat_n("bytes", binary_sizes.len() + 100 + 20));
        let plan = serde_json::to_vec(&serde_json::json!({"messages": types}))
            .map_err(|e| e.to_string())?;
        session.write_message(&mut write_index, 1, 1, &plan)?;
        let large_json = serde_json::to_vec(&serde_json::json!({"value":"x".repeat(100_000)}))
            .map_err(|e| e.to_string())?;
        session.write_message(&mut write_index, 1, 1, &large_json)?;
        expect_echo(&mut reader, &session, 1, 1, &large_json)?;
        for size in binary_sizes {
            let payload = (0..size)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>();
            session.write_message(&mut write_index, 1, 2, &payload)?;
            expect_echo(&mut reader, &session, 1, 2, &payload)?;
        }
        let mut latency_ms = Vec::new();
        for _ in 0..100 {
            let started = Instant::now();
            session.write_message(&mut write_index, 1, 2, &[0xA5; 1024])?;
            expect_echo(&mut reader, &session, 1, 2, &[0xA5; 1024])?;
            latency_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        let payload = vec![0xA5; 1024 * 1024];
        let started = Instant::now();
        for _ in 0..20 {
            session.write_message(&mut write_index, 1, 2, &payload)?;
            expect_echo(&mut reader, &session, 1, 2, &payload)?;
        }
        let throughput_seconds = started.elapsed().as_secs_f64();
        latency_ms.sort_by(f64::total_cmp);
        expect_close(&mut reader, &session, 1)?;
        // Reopen the same route with a new stream without restarting the peer.
        open_echo(&mut reader, &session, &mut write_index, 2)?;
        session.write_message(&mut write_index, 2, 1, br#"{"messages":["bytes"]}"#)?;
        session.write_message(&mut write_index, 2, 2, b"reopened")?;
        expect_echo(&mut reader, &session, 2, 2, b"reopened")?;
        expect_close(&mut reader, &session, 2)?;
        open_echo(&mut reader, &session, &mut write_index, 3)?;
        let started = Instant::now();
        peer.child.kill().map_err(|e| e.to_string())?;
        peer.child.wait().map_err(|e| e.to_string())?;
        let error = reader
            .next(&session)
            .err()
            .ok_or("reader remained usable after the backend exited")?;
        if !error.contains("process exited") {
            return Err(format!("unexpected backend-exit error: {error}"));
        }
        Ok(serde_json::json!({
            "scope": "Rust/Python cross-process native shared memory; excludes WebView and game",
            "platform": std::env::consts::OS,
            "binarySizesVerified": binary_sizes,
            "jsonBytesVerified": large_json.len(),
            "streamReopenVerified": true,
            "backendExitDetectedMs": started.elapsed().as_secs_f64() * 1000.0,
            "latency1KiB": {"iterations":100,"p50Ms":latency_ms[50],"p95Ms":latency_ms[95],"p99Ms":latency_ms[99]},
            "throughput1MiB": {"iterations":20,"seconds":throughput_seconds,"roundtripMiBs":40.0/throughput_seconds},
        }))
    })();
    drop(peer);
    drop(session);
    ensure_resources_removed(&base)?;
    let mut result = result?;

    // Reusing a retired name must create fresh semaphores, cursors and mappings.
    {
        let peer = start_peer(&args[0], &args[1], &base)?;
        let mut reader = ready_reader(&peer.session, &base)?;
        let mut write_index = 0;
        open_echo(&mut reader, &peer.session, &mut write_index, 1)?;
        peer.session
            .write_message(&mut write_index, 1, 1, br#"{"messages":["bytes"]}"#)?;
        peer.session
            .write_message(&mut write_index, 1, 2, b"fresh-generation")?;
        expect_echo(&mut reader, &peer.session, 1, 2, b"fresh-generation")?;
        expect_close(&mut reader, &peer.session, 1)?;
    }
    ensure_resources_removed(&base)?;

    let stopped = Arc::new(NativeSession::create(&base)?);
    let waiting = Arc::clone(&stopped);
    let (entered, entered_rx) = mpsc::channel();
    let (finished, finished_rx) = mpsc::channel();
    let blocked_reader = std::thread::spawn(move || {
        let _ = entered.send(());
        let result = waiting.read_chunk(&mut 0, true, None, |_| Ok(()));
        let _ = finished.send(result);
    });
    entered_rx.recv_timeout(Duration::from_secs(2))?;
    std::thread::sleep(Duration::from_millis(20));
    let started = Instant::now();
    stopped.stop();
    let stopped_result = finished_rx.recv_timeout(Duration::from_secs(2))?;
    blocked_reader
        .join()
        .map_err(|_| "reader thread panicked")?;
    if !stopped_result.is_err_and(|error| error.contains("stopped")) {
        return Err("stop did not wake the blocked reader".into());
    }
    if stopped.write_message(&mut 0, 1, 2, b"late").is_ok() {
        return Err("stopped session accepted a late write".into());
    }
    result["stopWakeupMs"] = serde_json::json!(started.elapsed().as_secs_f64() * 1000.0);
    drop(stopped);
    ensure_resources_removed(&base)?;
    result["freshGenerationVerified"] = serde_json::json!(true);
    result["resourceCleanupVerified"] = serde_json::json!(true);
    #[cfg(target_os = "linux")]
    {
        result["resourcesUnlinkedAfterReady"] = serde_json::json!(true);
    }
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn main() {
    eprintln!("The native shared-memory probe requires Windows or Linux desktop");
}
