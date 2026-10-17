//! Cross-language native IPC validation; never connects to an emulator.
//! cargo run -p baas-tauri --example shm_native_probe -- <python> <baas-dev>
#![allow(dead_code)]
#[cfg(windows)]
#[path = "../src/shm_native.rs"]
mod shm_native;
#[path = "../src/shm_protocol.rs"]
mod shm_protocol;

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use shm_native::NativeSession;
    use shm_protocol::Decoder;
    use std::{collections::VecDeque, process::Command, sync::Arc, time::Instant};

    struct Reader {
        index: usize,
        decoder: Decoder,
        ready: VecDeque<(u32, Vec<u8>)>,
    }
    impl Reader {
        fn next(&mut self, session: &NativeSession) -> Result<(u32, Vec<u8>), String> {
            loop {
                if let Some(message) = self.ready.pop_front() {
                    return Ok(message);
                }
                session.read_chunk(&mut self.index, true, None, |chunk| {
                    self.ready.extend(self.decoder.push(chunk)?);
                    Ok(())
                })?;
            }
        }
    }
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("expected Python executable and baas-dev repository path".into());
    }
    let base = format!("baas-shm-probe-{}", uuid::Uuid::new_v4());
    let session = Arc::new(NativeSession::create(&base)?);
    let (watchdog_tx, watchdog_rx) = std::sync::mpsc::channel::<()>();
    let watchdog_session = Arc::clone(&session);
    let watchdog = std::thread::spawn(move || {
        if watchdog_rx
            .recv_timeout(std::time::Duration::from_secs(60))
            .is_err()
        {
            watchdog_session.stop();
        }
    });
    let mut command = Command::new(&args[0]);
    command.args([
        format!("{}/tests/service/shm_echo_peer.py", args[1]),
        "--shm-name".into(),
        base,
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let result = (|| -> Result<serde_json::Value, String> {
        let mut reader = Reader {
            index: 0,
            decoder: Decoder::default(),
            ready: VecDeque::new(),
        };
        let (stream, ready) = reader.next(&session)?;
        if stream != 0
            || serde_json::from_slice::<serde_json::Value>(&ready[10..])
                .map_err(|e| e.to_string())?["type"]
                != "ready"
        {
            return Err("Python did not publish READY".into());
        }
        session.peer_process()?;
        let mut write_index = 0;
        session.write_message(
            &mut write_index,
            1,
            1,
            br#"{"type":"open","channel":"echo","name":"native-probe"}"#,
        )?;
        let (_, opened) = reader.next(&session)?;
        if serde_json::from_slice::<serde_json::Value>(&opened[10..]).map_err(|e| e.to_string())?
            ["type"]
            != "open_ok"
        {
            return Err("echo channel failed to open".into());
        }
        let binary_sizes = [0, 1, 65_522, 65_523, 65_532, 65_533, 4_194_427, 8_388_625];
        let mut types = vec!["json"];
        types.extend(std::iter::repeat_n("bytes", binary_sizes.len() + 100 + 20));
        let plan = serde_json::to_vec(&serde_json::json!({"messages": types}))
            .map_err(|e| e.to_string())?;
        session.write_message(&mut write_index, 1, 1, &plan)?;
        let large_json = serde_json::to_vec(&serde_json::json!({"value":"x".repeat(100_000)}))
            .map_err(|e| e.to_string())?;
        session.write_message(&mut write_index, 1, 1, &large_json)?;
        let (_, echoed) = reader.next(&session)?;
        if echoed[5] != 1 || echoed[10..] != large_json {
            return Err("100 KB JSON changed across native IPC".into());
        }
        for size in binary_sizes {
            let payload = (0..size)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>();
            session.write_message(&mut write_index, 1, 2, &payload)?;
            let (stream, echoed) = reader.next(&session)?;
            if stream != 1 || echoed[5] != 2 || echoed[10..] != payload {
                return Err(format!("binary mismatch: {size} bytes"));
            }
        }
        let mut latency_ms = Vec::new();
        for _ in 0..100 {
            let started = Instant::now();
            session.write_message(&mut write_index, 1, 2, &[0xA5; 1024])?;
            reader.next(&session)?;
            latency_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        let payload = vec![0xA5; 1024 * 1024];
        let started = Instant::now();
        for _ in 0..20 {
            session.write_message(&mut write_index, 1, 2, &payload)?;
            let (_, echoed) = reader.next(&session)?;
            if echoed[10..] != payload {
                return Err("throughput payload mismatch".into());
            }
        }
        let throughput_seconds = started.elapsed().as_secs_f64();
        latency_ms.sort_by(f64::total_cmp);
        Ok(serde_json::json!({
            "scope": "Rust/Python cross-process native shared memory; excludes WebView and game",
            "binarySizesVerified": binary_sizes,
            "jsonBytesVerified": large_json.len(),
            "latency1KiB": {"iterations":100,"p50Ms":latency_ms[50],"p95Ms":latency_ms[95],"p99Ms":latency_ms[99]},
            "throughput1MiB": {"iterations":20,"seconds":throughput_seconds,"roundtripMiBs":40.0/throughput_seconds},
        }))
    })();
    session.stop();
    let _ = watchdog_tx.send(());
    let _ = watchdog.join();
    // Only this fixture's child is owned here, never the user's BAAS/game processes.
    let _ = child.kill();
    let _ = child.wait();
    println!("{}", serde_json::to_string_pretty(&result?)?);
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The native shared-memory probe currently requires Windows");
}
