# BAAS CLI runtime helper

A headless adapter over `baas-updater`'s desktop installation workflow. It installs the same backend repository, Cpp/OCR prebuild, private UV/Python environment and service dependencies. It does not start a daemon or require Tauri, GTK or WebKit.

```sh
cargo build --release -p baas-cli-runtime
cargo test -p baas-cli-runtime
target/release/baas-cli-runtime inspect --root /absolute/private/runtime
target/release/baas-cli-runtime install --root /absolute/private/runtime --channel dev
target/release/baas-cli-runtime launch-spec --root /absolute/private/runtime --pipe /private/tmp/backend.sock
```

The CLI defaults to the `dev` service backend (`Kiramei/baas-dev`) using the desktop updater's source ranking and platform selection. The legacy `stable` GUI repository currently has neither `main.service.py` nor BPIP transport; an explicit `--channel stable` fails before creating a runtime directory or downloading anything. The desktop updater's own stable default is unchanged. Existing compatible CLI-owned installations can still be inspected and launched.

An empty directory or a directory with a valid `.baas-cli-runtime.json` ownership marker is required. Existing desktop installations and arbitrary nonempty directories are never adopted or overwritten. A process-held file lock prevents concurrent installers; failed or cancelled installations stay incomplete and can be retried. SIGINT/SIGTERM cancel active updater tasks. Installation never launches the backend.

Every stdout line is a JSON object:

- Progress: `{ "type": "progress", "stage": "updater-config", "message": "..." }`
- Success: `{ "type": "result", "data": { ... } }`
- Failure: `{ "type": "error", "code": "environment", "message": "..." }` with nonzero exit status (`130` for cancellation).

`inspect` and successful `install` return `installed`, `managed`, `root`, `backendPath`, `pythonPath`, `cppPath`, `channel`, and `missing`. Paths are absolute; `backendPath` points to `main.service.py`, `pythonPath` to the private `.venv` interpreter, and `cppPath` to the OCR binary directory. `managed` indicates CLI ownership. `installed` requires a completed shared installation workflow and the presence of backend, Python, UV, OCR executable, dependency lock and setup configuration. `inspect` performs no writes or network requests.

`launch-spec` requires a complete installation and returns `{ "program": "...", "args": ["..."], "cwd": "...", "env": { "PYTHONUNBUFFERED": "1" } }`. It reuses the shared loopback backend command and adds the exact pipe endpoint. The caller owns process spawning, lifecycle and readiness checks. Unix endpoints must be absolute socket paths; Windows endpoints use `\\.\pipe\...`.

`baas-updater` and `baas-term` retain the default `desktop` feature for existing consumers. The helper selects both with `default-features = false`, retaining core orchestration and excluding Tauri adapters and dashboard rendering.
