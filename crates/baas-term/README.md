# baas-term

`baas-term` is the terminal-session layer used by BAAS to run updater/demo tasks
and stream terminal-style output into the Tauri UI.

The crate provides:

- a shared [`TermManager`](src/lib.rs) for starting and resizing the active
  terminal session;
- PTY-backed process tasks for shell commands and other executables;
- in-process thread tasks with structured terminal output helpers;
- a renderer that turns task events and ANSI-aware buffers into dashboard
  snapshots;
- serializable Tauri event payload types for session, task, and dashboard state.

## Public Surface

The main entry point is `TermManager`:

```rust
use baas_term::TermManager;

let manager = TermManager::default();
```

In the application, `TermManager::start` receives a Tauri `AppHandle`, stops any
existing session, emits a `build:session-started` event, starts the renderer
loop, and launches the demo flow. `TermManager::resize` updates the stored
terminal size, resizes active PTYs, and notifies the renderer.

The crate also exposes lower-level modules:

- `processor`: builds and spawns PTY-backed process tasks.
- `threader`: builds and spawns Rust-thread tasks and provides output helpers
  such as logs, repainting lines, spinners, and progress bars.
- `renderer`: consumes `RendererEvent` values and emits rendered Tauri chunks.
- `types`: shared task specs, renderer events, and serialized payloads.
- `common`: small orchestration helpers for session checks and task completion.
- `constants`: named defaults and limits for terminal dimensions, renderer
  history, running-region clipping, task statuses, Tauri event names, and worker
  timing.

## Task Types

Process tasks use `ScriptCommand` plus `create_process_task`:

```rust
use baas_term::processor::{ScriptCommand, create_process_task};

let task = create_process_task(
    "cargo-test",
    "cargo-test",
    1,
    "Cargo Test",
    ScriptCommand {
        program: "cargo".to_string(),
        args: vec!["test".to_string()],
        display: "cargo test".to_string(),
    },
);
```

Thread tasks use `create_thread_task` and write terminal output through
`ThreadOutput`:

```rust
use baas_term::threader::{ThreadLogStyle, create_thread_task, spawn_thread_task};
use std::sync::{Arc, Mutex, mpsc};
use baas_term::types::{TaskCompletion, TermState};

let state = Arc::new(Mutex::new(TermState {
    current_session_id: Some("session".to_string()),
    ..TermState::default()
}));
let (renderer_tx, _renderer_rx) = mpsc::channel();
let (completion_tx, _completion_rx) = mpsc::channel::<TaskCompletion>();

let task = create_thread_task("scan", "scan", 1, "Scan", "scan assets");

spawn_thread_task(
    &state,
    "session",
    task,
    &renderer_tx,
    &completion_tx,
    (),
    |output, cancelled, ()| {
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }

        output.log().line(ThreadLogStyle::Info, "scan started");
        Ok(())
    },
)?;
# Ok::<(), String>(())
```

## Renderer Events

Workers communicate with the renderer through `RendererEvent`:

- `TaskStarted` registers a task and renders its dashboard region.
- `Output` appends raw task bytes to the region buffer.
- `TaskFinished` finalizes task state and emits a status payload.
- `BufferRegions` and `FlushRegions` support parallel task output grouping.
- `Resize` updates viewport clipping.
- `SessionFinished` emits final session status and a completed snapshot.
- `Shutdown` exits the renderer loop.

Payload structs in `types` serialize with `camelCase` field names for Tauri
event compatibility.

## Testing

Run the crate checks:

```bash
cargo fmt -p baas-term --check
cargo clippy -p baas-term --all-targets --all-features
cargo test -p baas-term --all-features
cargo doc -p baas-term --no-deps
```

The test suite includes unit coverage for session helpers, process spawning,
renderer buffer behavior, thread-output helpers, task lifecycle handling, and
public serialization contracts. Integration tests live in `tests/` and exercise
the public API from outside the crate.

## Notes For Maintainers

- Keep the public API stable unless a Tauri-side integration change requires it.
- Prefer deterministic tests that use in-memory channels and short-lived
  platform-specific shell commands.
- Renderer tests should stay close to `renderer.rs` because most ANSI parsing
  and buffer state is intentionally private.
- Public payload changes should be accompanied by serialization tests so UI
  event contracts remain explicit.
