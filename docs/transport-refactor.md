# Backend Transport Refactor

## Current Data Flow

```text
WebUI build:
Browser -> Secure WebSocket/HTTP -> FastAPI routes -> channel handlers -> ServiceContext

Tauri build, Shared Memory selected:
React/WebView -> raw Tauri Channel/commands -> Rust BackendIpcManager
    -> named shared memory + directional OS events -> Python shm entrypoint

Tauri build, WebSocket selected:
React/WebView -> secure WebSocket/HTTP -> managed Python FastAPI backend
```

Desktop Tauri exposes an explicit persisted transport selector in Settings. Shared Memory is the
default; selecting it creates native IPC resources and launches Python with `--transport shm`.
Selecting WebSocket launches the managed secure WebUI backend. A Shared Memory failure is surfaced
as an error and never triggers an automatic WebSocket fallback.

## Platform Support

- Windows desktop: implemented and covered by native named shared-memory/event tests plus real
  `main.service.py --transport shm` subprocess tests.
- Linux/macOS desktop: POSIX shared-memory and named-semaphore adapters are implemented in both
  Rust and Python, with Rust unit coverage built into `crates/baas-ipc` and Python integration tests
  using platform-aware POSIX resource names. Transport validation workflows now run these checks on
  GitHub-hosted Linux and macOS, but those workflow results must be inspected before treating the
  hosts as release-validated.
- Other non-Windows desktop targets: unsupported-platform errors remain explicit instead of falling
  back to WebSocket.
- Android/mobile: not implemented. The mobile runtime command returns `UnsupportedTransport`, and
  Android release builds are blocked by the guarded package build scripts until an Android
  shared-memory/notification adapter, lifecycle handling, and device tests exist. Debug builds
  remain available for Android development work, but must not be treated as release-ready
  shared-memory client builds.

## Coupling Points Found

- `src/store/WebsocketStore.ts` previously constructed `SecureWebSocket` directly and owned auth,
  channel callbacks, binary queues, and stream callbacks in one store.
- `src/shared/SecureWebSocket.ts` owns WebUI authentication, remember-cookie persistence,
  server identity verification, and SecretStream encryption.
- `src-tauri/src/commands.rs` and `crates/baas-updater/src/workflow.rs` still retain legacy
  localhost `/auth/remember` readiness helpers for Android/WebSocket-era updater flows, but the
  desktop Tauri setup page no longer consumes that path.
- `service/api/ws_sync.py`, `ws_provider.py`, `ws_trigger.py`, and `ws_remote.py` previously mixed
  FastAPI WebSocket transport with business message handling.
- `service/remote/scrcpy.py` previously proxied only a Starlette/FastAPI WebSocket object.

## ABI Seed

The shared ABI seed is implemented in `crates/baas-ipc` and mirrored in
`service/transport/protocol.py`.

- Byte order: little-endian.
- Shared memory header size: 124 bytes.
- Frame header size: 40 bytes.
- Max frame length: 8 MiB.
- Max message length: 64 MiB.
- Header fields include magic, protocol/ABI versions, generation ID, owner/peer PID,
  lifecycle/error fields, heartbeat timestamps, ring descriptors, lane descriptors, and
  last-error offset/length.
- Lifecycle states are stable ABI values: `1` starting, `2` ready, `3` stopped, and `4` failed.
  Python shm mode writes `ready` after validating the Tauri-owned region and writes `stopped` when
  its parent-watch loop exits, then wakes Rust through the Python-to-Rust notification event.
- Frame fields include frame version, logical channel ID, stream ID, message kind, flags,
  sequence number, correlation ID, payload length, fragment index, and fragment count.
- Stable logical channel IDs are now defined for control/provider/sync/trigger/remote.
- Stable message-kind IDs are now defined for channel open, channel close, JSON payload, raw bytes,
  and transport error frames.
- `FrameHeader.stream_id` is now used for per-connection multiplexing. Singleton channels such as
  sync/provider/trigger use stream `0`; dynamic channel instances such as `remote-*` get unique
  stream IDs assigned by Rust during `backend_ipc_open_channel`.
- Each shared ring region starts with a 64-byte `RingControlBlock`:
  - magic `BAASRNG\0`, ABI version, header size, flags, data capacity, read/write cursors,
    generation ID, sequence number, dropped-frame counter, and reserved tail.
  - The ring payload area follows the control block. One byte is reserved to distinguish full from
    empty.
  - Packets inside the ring use `u32 little-endian payload_length` followed by either an encoded
    frame (`FrameHeader + raw payload`) or future control payloads.
- Oversized frame lengths and invalid fragment bounds are rejected during encode/decode.
- Fragmentation/reassembly is implemented in both Rust and Python:
  - Empty messages produce one empty frame.
  - Oversized logical messages are rejected.
  - Missing fragments, out-of-order fragment indexes, payload-length mismatch, and metadata
    mismatch are rejected.
- Rust and Python tests share fixed golden vectors for the shared-memory header, frame header, and
  ring control block, plus fragmented binary payload headers.

## Queue Core

`crates/baas-ipc::SpscRingBuffer` and `service.transport.ring_buffer.SpscRingBuffer` now model the
bounded byte queue semantics for the future shared-memory data plane:

- Empty payloads are valid.
- Wrap-around at the capacity boundary is covered.
- Queue-full writes fail without mutating unread data.
- Reads past available bytes fail explicitly.

`crates/baas-ipc::SharedRingBuffer` and `service.transport.ring_buffer.SharedRingBuffer` now model
the byte layout that lives inside the shared-memory region:

- Ring control block encode/decode is ABI-tested in both languages.
- Packets carry an explicit little-endian length prefix.
- Encoded frames round-trip as `FrameHeader + raw payload`.
- Packet wrap-around, queue-full, and invalid packet length behavior are covered.

## Lane Policy

The low-level IPC policy now names four lanes:

- Control: reliable, returns an error on queue pressure; critical control frames are not dropped.
- Message: reliable, waits/backpressures instead of dropping sync/provider/trigger messages.
- Bulk: reliable, waits/backpressures and is intended for chunked binary payloads.
- Remote media: not reliable, may drop oldest queued frames to avoid unbounded latency.

## Status

- WebUI secure WebSocket behavior remains available and builds.
- Python sync/provider/trigger/remote business handlers are transport-neutral.
- WebSocket routes are now thin auth/encryption adapters.
- Desktop Tauri builds emit both transport adapters so Settings can switch explicitly at runtime.
  Shared Memory bypasses control authentication; WebSocket retains server verification, password,
  remembered-session, and SecretStream behavior. Web builds emit only the WebSocket transport.
- Desktop Tauri setup now runs the updater workflow with `launch: false`; after sync/install
  success it initializes the selected transport through `BackendStore.startAuthFlow()`. Shared
  Memory startup does not listen for `updater://backend-ready`, store localhost backend host/port
  values, generate an automatic WebUI password, or call the backend-auth reset command.
- An already-installed backend now takes a direct startup path instead of rerunning the complete
  updater workflow on every launch. A failed direct start returns to the installer for recovery.
  Persisted WebSocket mode hands `waiting_password` off to the normal authentication UI.
- `crates/baas-ipc` has Windows named shared-memory/named-event wrappers and POSIX desktop
  shared-memory/named-semaphore wrappers with tests. Remaining unsupported targets expose the same
  API surface and return `UnsupportedPlatform`, so builds fail through an explicit transport gate
  rather than compiling against platform-only methods.
- Python `service.transport.native_ipc` has Windows named shared-memory/named-event and POSIX
  desktop shared-memory/named-semaphore open/create wrappers plus explicit unsupported-platform
  errors. Production shm mode opens Tauri-owned resources; tests use the create wrappers to own real
  named resources without starting Tauri.
- `BackendIpcManager` creates a unique unpredictable IPC instance, initializes the ABI header,
  initializes both shared-ring control blocks, creates separate Rust-to-Python and Python-to-Rust
  named notification events, launches Python with `--transport shm`, waits on the Python-to-Rust
  event for readiness, decodes the updated header, captures early backend errors, and never
  allocates or probes a localhost port.
- Tauri `backend_ipc_open_channel`, `backend_ipc_send_json`, `backend_ipc_send_bytes`, and
  `backend_ipc_close_channel` now encode channel frames into the Rust-to-Python shared ring and wake
  Python through the Rust-to-Python event. Frames carry both logical channel ID and stream ID, so
  multiple dynamic connections on the same logical channel do not collide.
- Tauri `backend_ipc_subscribe` registers a long-lived Tauri `Channel` for each frontend connection.
  A Rust reader thread waits on the Python-to-Rust event, drains shared-memory frames, decodes JSON
  and binary payloads, and routes inbound frames back to the original frontend connection name using
  the stream ID assigned at open time. `backend_ipc_recv` remains as a debug/test drain command, but
  the frontend transport no longer uses fixed-interval polling.
- Rust-to-WebView delivery uses one ordered raw `ArrayBuffer` channel with a 20-byte binary envelope.
  It no longer serializes `Vec<u8>` as JSON `number[]`; JSON remains UTF-8 and media remains raw
  bytes. Remote pending delivery is bounded to 256 messages/8 MiB and drops stale media before
  reliable control messages.
- WebView-to-Rust binary sends use a raw Tauri invoke body with an 8-byte routing envelope, removing
  the former `Array.from(Uint8Array)` conversion while preserving UTF-8 dynamic channel names.
- The Rust reader now interprets the shared-memory lifecycle header after draining inbound frames.
  `stopped` is surfaced as `BackendExited`, `failed` as `BackendInitializationFailed`, and unknown
  lifecycle values as `SharedMemoryCorrupted`. Active Tauri channel subscribers receive a synthetic
  transport error before the Rust manager clears the run and moves status to `failed`.
- Tauri also exposes `backend_ipc_benchmark_webview_copy` plus
  `benchmarkTauriWebviewCopy()` for measuring Rust-to-WebView `Channel` binary delivery cost using
  the same raw response-body path as `TauriSharedMemoryTransport`. `bun run
  benchmark:webview-copy` starts a Tauri-mode Vite server, launches the desktop app with
  `BAAS_WEBVIEW_COPY_BENCHMARK_*` environment variables, writes a JSON report, and exits the app.
- `TauriSharedMemoryTransport` receives pushed `Channel` messages and delivers JSON objects or
  `ArrayBuffer` payloads through the existing store `onMessage` callback shape.
- The frontend store rejects and clears pending command, stream, and binary callbacks when a primary
  `sync` or `trigger` transport closes, errors, or is manually disconnected. Control-channel
  revocation/close also clears pending transport callbacks so operations cannot hang indefinitely
  after backend restart or transport loss.
- Runtime status comes from the provider push channel; the duplicate one-second trigger polling loop
  was removed, eliminating timestamp collisions and repeated `CallBack Not Found` warnings.
- `src/store/BackendStore.ts` is the neutral frontend store import surface. Existing
  `WebsocketStore.ts` remains as the implementation and compatibility export, but app code now uses
  `useBackendStore` from `BackendStore` so business components no longer import a WebSocket-named
  store directly.
- Frontend store and transport types now expose backend-neutral `BackendState`, `BackendChannelKey`,
  `BackendMessageItem`, `BackendCallbackDict`, `BackendAuthPhase`,
  `BackendControlSessionBundle`, and `BackendControlConnection` names. The old `WebSocketState`,
  `WsName`, `WsMessageItem`, and `WsCallBackDict` names remain as compatibility aliases, but the
  store implementation depends on the neutral names and no longer imports WebUI auth types into
  shared app state.
- Python `--transport shm` opens the Tauri-owned region, validates the ABI header, writes `peer_pid`
  and ready lifecycle state, validates the shared-ring control blocks, and signals the
  Python-to-Rust event. It then waits on the Rust-to-Python event and demultiplexes inbound
  Rust-to-Python frames into shared-memory channel endpoints while the parent process remains alive.
- Python shm mode constructs `ServiceContext` with WebUI authentication disabled. This avoids
  loading password/session/SecretStream dependencies on the client readiness path. Package-level
  service injections, updater checks, `watchfiles`, `pygit2`, `tomli_w`, and pydantic now either load
  lazily or have narrow fallbacks so the shm process can reach native IPC readiness without starting
  WebUI-only or update-only subsystems.
- The `main.service.py --transport shm` launch path is covered against accidental network startup:
  even when `--host` and `--port` are supplied, it builds only `SharedMemoryLaunchOptions`, does not
  import Uvicorn, and does not expose host/port on the shm launch options.
- `service.runtime` keeps lazy update-check imports for shm startup while exposing patchable
  module-level proxy functions for SHA checks and update execution, preserving existing tests and
  call surfaces.
- Python now has a shared-memory `ChannelEndpoint` and mux. Open/json/bytes/close frames are routed
  to per-channel and per-stream endpoints, and endpoint `send_json`/`send_bytes` writes frames into
  the Python-to-Rust ring with the same stream ID before waking Rust through the Python-to-Rust event.
- Python outbound shared-memory writes now apply the same lane policy used by Rust. Reliable
  control/message/bulk frames keep queue-full behavior, while remote media byte frames may drop the
  oldest queued remote media frame when the ring is full. The drop path peeks the oldest frame first
  so it does not discard reliable traffic from the shared ring.
- Python and Rust shared-ring cursor updates no longer rewrite the whole control block during normal
  reads and writes. Python's native adapter also writes back only changed ring ranges, publishing
  packet data before cursor/control changes, so a peer cannot lose frames through stale whole-ring
  snapshot writeback.
- The shm server now uses the same sync/provider/trigger/remote channel handlers as WebSocket mode
  through a handler factory. Real subprocess coverage exists for readiness plus sync/provider
  message dispatch over named shared memory, including sync `config_list`, `snapshot`, and
  `patch_ack` responses. Trigger command dispatch and binary request/response frame ordering are
  also covered through a real `main.service.py --transport shm` subprocess, along with trigger
  stream chunk, done, and error-done semantics. Remote subprocess coverage uses a synthetic remote
  source to verify dynamic stream IDs, inbound control bytes, outbound raw media bytes, and close
  frames. Mobile shared-memory adapters, POSIX host validation, and real-device high-load remote
  media validation remain to be implemented or executed.
- Sync, provider, trigger, and remote channel handlers are covered over an in-memory non-WebSocket endpoint,
  which verifies that their business logic does not require FastAPI or Starlette WebSocket objects.
- `service.channels` uses lazy exports so importing one channel does not load optional remote
  dependencies such as `websockets`.

## Validation Snapshot

- `cargo test -p baas-ipc` passes with 25 tests and covers Rust ABI encode/decode,
  protocol/ABI version mismatch rejection, oversized frame/message rejection, fragmentation/reassembly,
  ring-buffer behavior, lane policies, Windows named shared-memory/event primitives, POSIX desktop
  shared-memory/semaphore primitives when run on Linux/macOS, and explicit unsupported-platform
  stubs on targets without a native adapter.
- `cargo test -p baas-tauri --lib` passes with 10 tests, including backend IPC lifecycle
  interpretation for ready, stopped, failed, and unknown lifecycle states.
- `cargo clippy --workspace --all-targets -- -D warnings` passes locally after the updater terminal
  workflow helpers were refactored to share a small orchestration context instead of passing the
  same long argument list through each stage helper.
- `cargo test --workspace` passes locally across the Tauri app crate and supporting workspace crates
  (`baas-ipc`, `baas-updater`, `baas-term`, `baas-shortcut`, `baas-notifier`, and `baas-i18n`).
- `python -m unittest tests.service.test_transport_protocol_unittest tests.service.test_transport_ring_buffer_unittest tests.service.test_transport_lanes_unittest`
  covers Python ABI golden vectors, fragmentation/reassembly, ring-buffer behavior including partial
  cursor updates, protocol/ABI version mismatch rejection, oversized message rejection, and lane
  policies, including remote-media lane classification.
- `python -m pytest tests/service` passes with 125 tests, covering WebUI security contracts,
  HTTP/auth contracts, runtime update logic, transport handlers, shared-memory transport tests, and
  existing service regressions.
- `python -m unittest tests.service.test_channel_handlers_unittest` covers sync/provider/trigger
  handlers, trigger stream done/error semantics, and the remote binary endpoint path over
  non-WebSocket endpoints.
- `python -m unittest tests.service.test_transport_launch_unittest` covers that `--transport shm`
  does not require FastAPI, Uvicorn, or rich, and verifies the Python shm entrypoint updates the ABI
  header and signals readiness over the Python-to-Rust notification event when given a native
  region. It also verifies native IPC unsupported-platform errors, that inbound frames are drained
  through the shared-memory loop, that the loop publishes the stopped lifecycle state on exit, and
  that shm launch ignores host/port without importing Uvicorn or creating application network
  sockets.
- `python -m unittest tests.service.test_shared_memory_endpoint_unittest` covers shared-memory
  channel open/json/bytes/close demux, outbound handler responses written to the Python-to-Rust
  ring, and synthetic high-load remote-media byte bursts that drop old remote frames without
  dropping reliable bulk frames.
- `python -m pytest tests/service/test_security_contract.py` covers WebUI Origin policy,
  encrypted binary JSON stream helpers, the encrypted `WebSocketChannelEndpoint`, control-channel
  initialization envelopes, business-channel resume rejection cases, and the successful
  business-channel resume path including `resume_ok` and client SecretStream header handoff.
- `python -m unittest tests.service.test_shared_memory_server_native_unittest` covers real Windows
  named shared memory and directional named events. It covers both the in-process shm server loop
  and a real `main.service.py --transport shm` subprocess that updates the shared-memory header and
  signals readiness without constructing WebUI auth. The subprocess test also opens real sync and
  provider channels through the Rust-to-Python ring and verifies responses on the Python-to-Rust
  ring, including sync `config_list`, `snapshot`, `patch_ack`, and provider stream-ID preservation.
  It also opens a trigger channel and verifies command JSON dispatch, inbound binary payload
  delivery, outbound binary metadata, and the following outbound bytes frame on the same stream.
  Trigger stream coverage verifies multiple chunk responses, final `{done: true}`, and error
  responses that also release stream callbacks through `{done: true}`. Remote subprocess coverage
  verifies a dynamic remote stream with inbound control bytes, multiple outbound media byte frames,
  and an outbound close frame. In-process native coverage also verifies the stopped lifecycle state
  is written after the parent-watch loop exits.
- `python scripts/benchmark_transport.py --latency-iterations 300 --binary-iterations 60 --large-binary-iterations 10 --startup-iterations 3 --idle-seconds 2 --secure-websocket`
  runs a repeatable microbenchmark in `baas-dev` comparing the shared-memory ring data plane with a
  minimal persistent localhost WebSocket echo implemented with stdlib sockets. It also measures real
  `main.service.py --transport shm` subprocess readiness and idle child CPU on Windows. With WebUI
  crypto dependencies installed, `--secure-websocket` measures persistent WebSocket frames encrypted
  with the same backend `SecretStreamBox` primitive. The script now also measures a high-frequency
  `status`/`log` JSON burst through both transports, and supports an explicit `--remote-stress-frames`
  mode that drives a synthetic remote media stream through a real shm subprocess. This is still not
  a full browser auth-flow benchmark.
- `bun run benchmark:webview-copy -- --out benchmarks/webview-copy-windows.json --sizes 1024,65536,1048576 --iterations 60 --timeout-ms 180000`
  runs the Rust-to-WebView binary copy benchmark inside the desktop Tauri WebView and writes the
  measured JSON report. This also proved the Tauri command permission allow-list includes the
  backend IPC benchmark commands.
- `bun run build:tauri && bun run test:tauri-transport` proves the Tauri build output does not
  contain WebSocket/auth/password-modal/reconnect-overlay/SecretStream bundle chunks or legacy
  backend host/port and auth endpoint strings, verifies the desktop setup page stays on the
  non-launching shared-memory startup path, and verifies the Tauri permission manifest allows every
  backend IPC command required by the shared-memory transport and WebView benchmark.
- `bun run build:webui && bun run test:webui-transport` proves the WebUI build output does not
  contain Tauri shared-memory transport chunks, Tauri API imports, or backend IPC command strings.
- `bun run test:transport-cleanup` behavior-checks the shared cleanup helper by rejecting pending
  command and stream callbacks with an error payload, clearing binary callbacks and queued binary
  IDs, and verifying the store still wires that helper into control close, `sync`/`trigger` close,
  transport error, and manual disconnect paths.
- `bun run test:backend-store` verifies app code imports the neutral `BackendStore` facade and does
  not reintroduce direct `WebsocketStore` imports or the legacy `useWebSocketStore` hook name outside
  the compatibility implementation. It also verifies the compatibility implementation does not
  depend on the legacy WebSocket-named store type aliases.
- `bun run test:android-shm-guard` proves Android release builds fail early with an explicit
  unsupported shared-memory adapter error instead of producing a release artifact that would rely on
  WebSocket fallback or an unimplemented mobile IPC path. It also verifies the GitHub release
  workflow still calls the guarded Android release script instead of invoking raw Tauri Android
  release builds.
- `bun run lint` passes after excluding generated temporary work files from ESLint traversal.
- `.github/workflows/transport.yml` in both repos adds transport-focused CI coverage. In
  `baas-dev`, the workflow runs Python compileall, ABI/ring/lane/shared-memory endpoint tests, real
  native shared-memory subprocess tests, and a benchmark smoke on Windows, Linux, and macOS covering
  latency, binary throughput, status/log burst throughput, startup/idle, and remote media stress. In
  `baas-tauri`, the workflow runs `baas-ipc` fmt/clippy/tests on Windows, Linux, and macOS, plus
  frontend Tauri/WebUI transport bundle guards on Linux. Local Windows validation of these commands
  passed where the host can execute them; Linux/macOS workflow results are still external evidence to
  collect.

## Benchmark Snapshot

Command run on Windows/Python 3.11.9:

```bash
python scripts/benchmark_transport.py --latency-iterations 300 --binary-iterations 40 --large-binary-iterations 6 --message-burst-count 1000 --remote-stress-frames 120 --remote-stress-frame-size 65536 --startup-iterations 3 --idle-seconds 2 --secure-websocket
```

Small JSON persistent echo latency:

| Transport | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: |
| shared-memory ring | 0.0350 | 0.0635 | 0.0900 |
| localhost WebSocket | 0.0765 | 0.1306 | 0.1638 |

Binary persistent echo throughput, counting echoed bytes in both directions:

| Transport | Payload | Iterations | MiB/s | Wall ms |
| --- | ---: | ---: | ---: | ---: |
| shared-memory ring | 1 KiB | 40 | 33.97 | 2.300 |
| shared-memory ring | 64 KiB | 40 | 1835.54 | 2.724 |
| shared-memory ring | 1 MiB | 6 | 365.28 | 32.852 |
| localhost WebSocket | 1 KiB | 40 | 9.09 | 8.597 |
| localhost WebSocket | 64 KiB | 40 | 19.84 | 252.037 |
| localhost WebSocket | 1 MiB | 6 | 20.82 | 576.478 |

Status/log burst throughput, using alternating `status` and `log` JSON payloads:

```bash
python scripts/benchmark_transport.py --latency-iterations 50 --binary-iterations 10 --large-binary-iterations 3 --message-burst-count 1000 --message-burst-payload-size 256 --json
```

| Transport | Messages | Payload bytes | Messages/s | MiB/s | Wall ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| shared-memory ring | 1,000 | 256 | 63,691.83 | 15.55 | 15.701 |
| localhost WebSocket | 1,000 | 256 | 17,448.23 | 4.26 | 57.312 |

Shared-memory subprocess startup and idle CPU:

| Transport | Startup p50 ms | Startup p95 ms | Idle seconds | Idle CPU seconds avg | Idle CPU % avg |
| --- | ---: | ---: | ---: | ---: | ---: |
| `main.service.py --transport shm` | 239.475 | 371.842 | 2.0 | 0.0 | 0.0 |

WebUI SecretStream overhead:

With `cryptography` and `PyNaCl` installed, the benchmark measured persistent WebSocket frames
encrypted with the backend `SecretStreamBox` primitive:

| Metric | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: |
| encrypted websocket latency | 0.0657 | 0.1308 | 0.1586 |

| Payload | Iterations | MiB/s | Wall ms |
| ---: | ---: | ---: | ---: |
| 1 KiB | 60 | 9.99 | 11.731 |
| 64 KiB | 60 | 20.01 | 374.88 |
| 1 MiB | 10 | 19.76 | 1011.914 |

Transport-level synthetic remote media stress through `main.service.py --transport shm`:

```bash
python scripts/benchmark_transport.py --latency-iterations 50 --binary-iterations 10 --large-binary-iterations 3 --remote-stress-frames 120 --remote-stress-frame-size 65536 --json
```

| Frames requested | Frame bytes | Frames received | Bytes received | Wall ms | MiB/s | Dropped frames | Close received |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 120 | 65,536 | 120 | 7,864,320 | 205.602 | 36.48 | 0 | true |

Tauri WebView Rust-to-frontend `Channel` binary copy benchmark:

```bash
bun run benchmark:webview-copy -- --out benchmarks/webview-copy-windows.json --sizes 1024,65536,1048576 --iterations 60 --timeout-ms 180000
```

| Payload | Iterations | Rust emit ms | WebView wall ms | WebView MiB/s |
| ---: | ---: | ---: | ---: | ---: |
| 1 KiB | 60 | 0.743 | 27.900 | 2.10 |
| 64 KiB | 60 | 2.445 | 41.700 | 89.93 |
| 1 MiB | 60 | 10.734 | 298.100 | 201.27 |

The benchmark drove three implementation fixes: Python writes directly to the mapped ring instead
of copying/diffing the whole 16 MiB region; Rust and Python ring operations use contiguous/wrap
slice copies instead of byte loops; and Rust-to-WebView media uses Tauri raw response bodies instead
of JSON byte arrays. `cargo run -p baas-ipc --example ring_benchmark --release` measures the Rust
ring implementation independently. Full acceptance still needs remote-display measurements against
an attached device or emulator; current remote coverage is synthetic backpressure and subprocess
byte-stream stress validation.
