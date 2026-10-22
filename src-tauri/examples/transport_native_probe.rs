//! Isolated Rust/Python Linux carrier comparison; no WebView or SecureWS.
//! cargo build -p baas-tauri --example transport_native_probe
//! For measurement compile this same source with rustc -O and existing rlibs.
//! Usage: transport_native_probe PYTHON BACKEND FIXTURE [ROUNDS]
#![allow(dead_code)]

#[cfg(target_os = "linux")]
#[path = "../src/shm_native/linux.rs"]
mod shm_native;
#[path = "../src/shm_protocol.rs"]
mod shm_protocol;

#[cfg(target_os = "linux")]
mod probe {
    use super::{
        shm_native::{NativeSession, PeerProcess},
        shm_protocol::Decoder,
    };
    use serde_json::{json, Value};
    use std::{
        collections::VecDeque,
        fs,
        io::{BufRead, BufReader, Read, Write},
        net::TcpStream,
        os::unix::net::UnixStream,
        path::PathBuf,
        process::{Child, Command, Stdio},
        sync::{mpsc, Arc},
        thread,
        time::{Duration, Instant},
    };

    type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
    const TIMEOUT: Duration = Duration::from_secs(30);

    struct Fixture {
        child: Child,
        session: Arc<NativeSession>,
        pipe: PathBuf,
        watchdog: Option<thread::JoinHandle<()>>,
        finished: mpsc::Sender<()>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.session.stop();
            let _ = self.finished.send(());
            if let Some(watchdog) = self.watchdog.take() {
                let _ = watchdog.join();
            }
            // SIGTERM lets only our fixture close its socket and asyncio workers.
            unsafe {
                libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
            }
            for _ in 0..100 {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    let _ = fs::remove_file(&self.pipe);
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = fs::remove_file(&self.pipe);
        }
    }

    #[derive(Default)]
    struct ShmReader {
        index: usize,
        decoder: Decoder,
        ready: VecDeque<(u32, Vec<u8>)>,
        peer: Option<PeerProcess>,
    }

    impl ShmReader {
        fn recv(&mut self, session: &NativeSession) -> Result<(u32, Vec<u8>)> {
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

    struct Message {
        kind: u8,
        bytes: Vec<u8>,
        offset: usize,
    }

    impl Message {
        fn payload(&self) -> &[u8] {
            &self.bytes[self.offset..]
        }
    }

    struct WebSocket {
        stream: TcpStream,
        mask_counter: u32,
    }

    impl WebSocket {
        fn connect(port: u16) -> Result<Self> {
            let mut stream = TcpStream::connect(("127.0.0.1", port))?;
            stream.set_nodelay(true)?;
            stream.set_read_timeout(Some(TIMEOUT))?;
            stream.set_write_timeout(Some(TIMEOUT))?;
            // RFC 6455's published example key and accept pair. This is a local
            // isolated fixture, not a production network/security client.
            write!(stream, "GET /echo HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")?;
            let mut response = Vec::new();
            while !response.ends_with(b"\r\n\r\n") {
                let mut byte = [0_u8];
                stream.read_exact(&mut byte)?;
                response.push(byte[0]);
                if response.len() > 8192 {
                    return Err("WebSocket HTTP header too large".into());
                }
            }
            let response = std::str::from_utf8(&response)?;
            if !response.starts_with("HTTP/1.1 101 ")
                || !response
                    .to_ascii_lowercase()
                    .contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo=")
                || response
                    .to_ascii_lowercase()
                    .contains("sec-websocket-extensions:")
            {
                return Err(format!("Unexpected WebSocket upgrade: {response}").into());
            }
            Ok(Self {
                stream,
                mask_counter: 0x1234_5678,
            })
        }

        fn send_opcode(&mut self, opcode: u8, payload: &[u8]) -> Result<()> {
            self.mask_counter = self
                .mask_counter
                .wrapping_mul(1_664_525)
                .wrapping_add(1_013_904_223);
            let mask = self.mask_counter.to_le_bytes();
            let mut frame = Vec::with_capacity(14 + payload.len());
            frame.push(0x80 | opcode);
            if payload.len() < 126 {
                frame.push(0x80 | payload.len() as u8);
            } else if payload.len() <= u16::MAX as usize {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
            } else {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
            }
            frame.extend_from_slice(&mask);
            frame.extend(
                payload
                    .iter()
                    .enumerate()
                    .map(|(index, byte)| byte ^ mask[index & 3]),
            );
            self.stream.write_all(&frame)?;
            Ok(())
        }

        fn recv(&mut self) -> Result<Vec<u8>> {
            let mut message = Vec::new();
            let mut started = false;
            loop {
                let mut header = [0_u8; 2];
                self.stream.read_exact(&mut header)?;
                let opcode = header[0] & 15;
                if header[0] & 0x70 != 0 || header[1] & 0x80 != 0 {
                    return Err("Unexpected masked or extended WebSocket server frame".into());
                }
                let length = match header[1] & 127 {
                    126 => {
                        let mut value = [0; 2];
                        self.stream.read_exact(&mut value)?;
                        u16::from_be_bytes(value) as usize
                    }
                    127 => {
                        let mut value = [0; 8];
                        self.stream.read_exact(&mut value)?;
                        usize::try_from(u64::from_be_bytes(value))?
                    }
                    value => value as usize,
                };
                if length > 64 * 1024 * 1024 || message.len() + length > 64 * 1024 * 1024 {
                    return Err("Oversized WebSocket frame/message".into());
                }
                let mut payload = vec![0; length];
                self.stream.read_exact(&mut payload)?;
                match opcode {
                    8 => return Err("WebSocket peer closed".into()),
                    9 => {
                        self.send_opcode(10, &payload)?;
                        continue;
                    }
                    10 => continue,
                    2 if !started => started = true,
                    0 if started => {}
                    _ => return Err(format!("Unexpected WebSocket opcode {opcode}").into()),
                }
                if message.is_empty() && header[0] & 0x80 != 0 {
                    return Ok(payload);
                }
                message.extend_from_slice(&payload);
                if header[0] & 0x80 != 0 {
                    return Ok(message);
                }
            }
        }
    }

    enum Connection {
        Shm {
            session: Arc<NativeSession>,
            reader: ShmReader,
            index: usize,
        },
        Pipe(UnixStream),
        WebSocket(WebSocket),
    }

    impl Connection {
        fn send(&mut self, kind: u8, payload: &[u8]) -> Result<()> {
            match self {
                Self::Shm { session, index, .. } => {
                    session.write_message(index, 1, kind, payload)?
                }
                Self::Pipe(stream) => {
                    let mut frame = Vec::with_capacity(10 + payload.len());
                    frame.extend_from_slice(b"BPIP\x01");
                    frame.push(kind);
                    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
                    frame.extend_from_slice(payload);
                    stream.write_all(&frame)?;
                }
                Self::WebSocket(socket) => socket.send_opcode(2, payload)?,
            }
            Ok(())
        }

        fn recv(&mut self, kind: u8) -> Result<Message> {
            match self {
                Self::Shm {
                    session, reader, ..
                } => {
                    let (stream, frame) = reader.recv(session)?;
                    if stream != 1 {
                        return Err(format!("Unexpected stream {stream}").into());
                    }
                    Ok(Message {
                        kind: frame[5],
                        bytes: frame,
                        offset: 10,
                    })
                }
                Self::Pipe(stream) => {
                    let mut header = [0; 10];
                    stream.read_exact(&mut header)?;
                    if &header[..5] != b"BPIP\x01" {
                        return Err("Bad Pipe header".into());
                    }
                    let length = u32::from_le_bytes(header[6..].try_into()?) as usize;
                    if length > 64 * 1024 * 1024 {
                        return Err("Oversized Pipe message".into());
                    }
                    let mut frame = vec![0; 10 + length];
                    frame[..10].copy_from_slice(&header);
                    stream.read_exact(&mut frame[10..])?;
                    Ok(Message {
                        kind: header[5],
                        bytes: frame,
                        offset: 10,
                    })
                }
                Self::WebSocket(socket) => Ok(Message {
                    kind,
                    bytes: socket.recv()?,
                    offset: 0,
                }),
            }
        }

        fn open(&mut self) -> Result<()> {
            self.send(
                1,
                br#"{"type":"open","channel":"echo","name":"native-transport-benchmark"}"#,
            )?;
            let response = self.recv(1)?;
            let value: Value = serde_json::from_slice(response.payload())?;
            if value["type"] != "open_ok" {
                return Err("Echo channel did not open".into());
            }
            Ok(())
        }
    }

    struct Workload {
        name: &'static str,
        kind: u8,
        payload: Vec<u8>,
        iterations: usize,
        warmup: usize,
    }

    fn percentile(values: &[f64], quantile: f64) -> f64 {
        let mut values = values.to_vec();
        values.sort_by(f64::total_cmp);
        values[((values.len() as f64 * quantile).ceil() as usize).saturating_sub(1)]
    }

    fn measure(
        connection: &mut Connection,
        workload: &Workload,
        round: usize,
        mode: &str,
    ) -> Result<Value> {
        let plan = serde_json::to_vec(
            &json!({"kind": if workload.kind == 1 { "json" } else { "bytes" },
                                            "count": workload.warmup + workload.iterations}),
        )?;
        connection.send(1, &plan)?;
        let mut samples_ms = Vec::with_capacity(workload.iterations);
        let mut validation_seconds = 0.0;
        let block_started = Instant::now();
        for iteration in 0..workload.warmup + workload.iterations {
            let started = Instant::now();
            connection.send(workload.kind, &workload.payload)?;
            let received = connection.recv(workload.kind)?;
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            let validate = Instant::now();
            if received.kind != workload.kind || received.payload() != workload.payload {
                return Err(format!("{mode} {} echo mismatch", workload.name).into());
            }
            validation_seconds += validate.elapsed().as_secs_f64();
            if iteration >= workload.warmup {
                samples_ms.push(elapsed);
            }
        }
        let seconds = samples_ms.iter().sum::<f64>() / 1000.0;
        Ok(
            json!({"round": round, "mode": mode, "workload": workload.name,
            "payloadBytes": workload.payload.len(), "warmup": workload.warmup, "iterations": workload.iterations,
            "p50Ms": percentile(&samples_ms, 0.5), "p95Ms": percentile(&samples_ms, 0.95),
            "p99Ms": percentile(&samples_ms, 0.99), "meanMs": seconds * 1000.0 / workload.iterations as f64,
            "roundtripMiBs": 2.0 * workload.payload.len() as f64 * workload.iterations as f64 / 1_048_576.0 / seconds,
            "timedSeconds": seconds, "validationSecondsOutsideTiming": validation_seconds,
            "blockWallSecondsIncludingWarmupAndValidation": block_started.elapsed().as_secs_f64(),
            "rawRttMs": samples_ms }),
        )
    }

    pub fn run() -> Result<()> {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        if !(3..=4).contains(&args.len()) {
            return Err("Expected PYTHON BACKEND FIXTURE [ROUNDS]".into());
        }
        let rounds = args
            .get(3)
            .map(|value| value.parse::<usize>())
            .transpose()?
            .unwrap_or(5);
        if rounds == 0 {
            return Err("ROUNDS must be positive".into());
        }
        let base = format!("baas-transport-bench-{}", uuid::Uuid::new_v4());
        let pipe = std::env::temp_dir().join(format!("{base}.sock"));
        let session = Arc::new(NativeSession::create(&base)?);
        let mut child = Command::new(&args[0])
            .arg(&args[2])
            .args([
                "--backend",
                &args[1],
                "--shm-name",
                &base,
                "--pipe-name",
                pipe.to_str().ok_or("Invalid socket path")?,
            ])
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdout = child.stdout.take().ok_or("Missing Python stdout")?;
        let (finished, finished_rx) = mpsc::channel();
        let watched = Arc::clone(&session);
        let watchdog = thread::spawn(move || {
            if finished_rx.recv_timeout(Duration::from_secs(180)).is_err() {
                watched.stop();
            }
        });
        let fixture = Fixture {
            child,
            session: Arc::clone(&session),
            pipe: pipe.clone(),
            watchdog: Some(watchdog),
            finished,
        };
        let (ready_tx, ready_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = ready_tx.send(result);
        });
        let line = ready_rx.recv_timeout(Duration::from_secs(45))??;
        let peer: Value = serde_json::from_str(&line)?;
        if peer["ready"] != true {
            return Err("Python fixture did not become ready".into());
        }
        let mut reader = ShmReader::default();
        let (stream, ready) = reader.recv(&session)?;
        if stream != 0 || serde_json::from_slice::<Value>(&ready[10..])?["type"] != "ready" {
            return Err("SHM READY was not received".into());
        }
        reader.peer = session.peer_process()?;
        let socket = UnixStream::connect(&pipe)?;
        socket.set_read_timeout(Some(TIMEOUT))?;
        socket.set_write_timeout(Some(TIMEOUT))?;
        let mut connections = [
            (
                "shm",
                Connection::Shm {
                    session: Arc::clone(&session),
                    reader,
                    index: 0,
                },
            ),
            ("pipe", Connection::Pipe(socket)),
            (
                "websocketPlain",
                Connection::WebSocket(WebSocket::connect(
                    peer["wsPort"].as_u64().ok_or("No WS port")? as u16,
                )?),
            ),
        ];
        for (_, connection) in &mut connections {
            connection.open()?;
        }
        // Compact canonical JSON is exactly 1 KiB, the same bytes in all modes.
        let json_payload = serde_json::to_vec(&json!({"value": "x".repeat(1012)}))?;
        assert_eq!(json_payload.len(), 1024);
        let binary = |size| (0..size).map(|index| (index % 251) as u8).collect();
        let workloads = [
            Workload {
                name: "json1KiB",
                kind: 1,
                payload: json_payload,
                iterations: 300,
                warmup: 50,
            },
            Workload {
                name: "binary1KiB",
                kind: 2,
                payload: binary(1024),
                iterations: 300,
                warmup: 50,
            },
            Workload {
                name: "binary1MiB",
                kind: 2,
                payload: binary(1024 * 1024),
                iterations: 40,
                warmup: 5,
            },
            Workload {
                name: "binary8MiB",
                kind: 2,
                payload: binary(8 * 1024 * 1024),
                iterations: 10,
                warmup: 3,
            },
        ];
        let environment_before = environment();
        let started = Instant::now();
        let mut observations = Vec::new();
        let mut execution_order = Vec::new();
        // Rotate and reverse: no mode always enjoys the first/last position.
        let orders = [
            [0, 1, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
            [1, 0, 2],
            [0, 2, 1],
        ];
        for round in 0..rounds {
            for (workload_index, workload) in workloads.iter().enumerate() {
                let order = orders[(round + workload_index) % orders.len()];
                for index in order {
                    let (mode, connection) = &mut connections[index];
                    execution_order
                        .push(json!({"round": round, "workload": workload.name, "mode": mode}));
                    observations.push(measure(connection, workload, round, mode)?);
                }
            }
            eprintln!(
                "Native transport benchmark round {}/{} complete",
                round + 1,
                rounds
            );
        }
        let environment_after = environment();
        let mut summaries = Vec::new();
        for workload in &workloads {
            for (mode, _) in &connections {
                let selected = observations
                    .iter()
                    .filter(|item| item["mode"] == *mode && item["workload"] == workload.name)
                    .collect::<Vec<_>>();
                let samples = selected
                    .iter()
                    .flat_map(|item| {
                        item["rawRttMs"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|sample| sample.as_f64().unwrap())
                    })
                    .collect::<Vec<_>>();
                let seconds = samples.iter().sum::<f64>() / 1000.0;
                summaries.push(json!({"mode": mode, "workload": workload.name,
                    "samples": samples.len(), "payloadBytes": workload.payload.len(),
                    "p50Ms": percentile(&samples, 0.5), "p95Ms": percentile(&samples, 0.95), "p99Ms": percentile(&samples, 0.99),
                    "meanMs": seconds * 1000.0 / samples.len() as f64,
                    "roundtripMiBs": 2.0 * workload.payload.len() as f64 * samples.len() as f64 / 1_048_576.0 / seconds,
                    "perRoundP50Ms": selected.iter().map(|item| &item["p50Ms"]).collect::<Vec<_>>(),
                    "perRoundRoundtripMiBs": selected.iter().map(|item| &item["roundtripMiBs"]).collect::<Vec<_>>() }));
            }
        }
        for (_, connection) in &mut connections {
            connection.send(1, br#"{"operation":"close"}"#)?;
        }
        drop(connections);
        let pid = fixture.child.id();
        let duration = started.elapsed().as_secs_f64();
        // Drop fixture before reporting so a successful result also proves cleanup.
        fixture.session.stop();
        drop(fixture);
        drop(session);
        let names = [
            base.clone(),
            format!("sem.{base}_stop"),
            format!("sem.{base}_r2p_free"),
            format!("sem.{base}_r2p_used"),
            format!("sem.{base}_p2r_free"),
            format!("sem.{base}_p2r_used"),
        ];
        let cleaned = !pipe.exists()
            && names
                .iter()
                .all(|name| !PathBuf::from("/dev/shm").join(name).exists());
        if !cleaned {
            return Err("Fixture left native IPC resources".into());
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "scope": "Linux Rust/Python carrier-only round-trip benchmark; excludes WebView, game and product SecureWS encryption",
                "method": "One Python process and identical EchoHandler. Sequential request/echo (one outstanding), identical payloads and warmup/count. RTT includes sender framing, mask/copy, peer JSON parse/dump and complete reply receive. Exact payload validation outside each RTT timer. Throughput counts both payload directions (2 * payloadBytes), computed from sum of RTT samples; excludes warmup and validation.",
                "build": {"debugAssertions": cfg!(debug_assertions), "nativeProbeOptimized": !cfg!(debug_assertions),
                    "note": "Measurement binary compiled with rustc -O from this source and existing debug dependency rlibs; all three modes in the same binary. Production SHM source included unchanged; Rust Pipe/WS are minimal blocking clients, not product managers."},
                "pythonPeer": peer, "backendPath": fs::canonicalize(&args[1])?.to_string_lossy(),
                "backendRevision": Command::new("git").args(["-C", &args[1], "rev-parse", "HEAD"]).output().ok().map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string()),
                "rounds": rounds, "durationSeconds": duration, "executionOrder": execution_order,
                "environmentBefore": environment_before, "environmentAfter": environment_after,
                "summary": summaries, "observations": observations,
                "exactPayloadValidation": true, "fixturePid": pid, "fixtureAndResourcesCleaned": cleaned,
            }))?
        );
        Ok(())
    }

    fn environment() -> Value {
        json!({"loadavg": fs::read_to_string("/proc/loadavg").unwrap_or_default().trim(),
            "kernel": fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default().trim(),
            "cpu": fs::read_to_string("/proc/cpuinfo").unwrap_or_default().lines().find(|line| line.starts_with("model name")).unwrap_or("").trim(),
            "logicalCpus": thread::available_parallelism().map(|value| value.get()).unwrap_or(0),
            "uptime": fs::read_to_string("/proc/uptime").unwrap_or_default().trim(),
            "rustc": Command::new("rustc").arg("--version").output().ok().map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string()),
            "dateUtc": Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output().ok().map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())})
    }
}

#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    probe::run()
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("This comparison probe requires Linux");
}
