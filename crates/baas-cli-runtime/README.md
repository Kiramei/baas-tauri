# BAAS CLI runtime helper

A headless adapter over `baas-updater`'s desktop installation workflow. It installs the same backend repository, Cpp/OCR prebuild, private UV/Python environment and service dependencies. It does not start a daemon or require Tauri, GTK or WebKit.

```sh
cargo build --release -p baas-cli-runtime
cargo test -p baas-cli-runtime
target/release/baas-cli-runtime inspect --root /absolute/private/runtime
target/release/baas-cli-runtime install --root /absolute/private/runtime --channel dev
target/release/baas-cli-runtime check-update --root /absolute/private/runtime
target/release/baas-cli-runtime update --root /absolute/private/runtime
target/release/baas-cli-runtime launch-spec --root /absolute/private/runtime --pipe /private/tmp/backend.sock
```

The CLI defaults to the `dev` service backend (`Kiramei/baas-dev`) using the desktop updater's source ranking and platform selection. The legacy `stable` GUI repository currently has neither `main.service.py` nor BPIP transport; an explicit `--channel stable` fails before creating a runtime directory or downloading anything. The desktop updater's own stable default is unchanged. Existing compatible CLI-owned installations can still be inspected and launched.

An empty directory or a directory with a valid `.baas-cli-runtime.json` ownership marker is required. Existing desktop installations and arbitrary nonempty directories are never adopted or overwritten. A process-held file lock prevents concurrent installers; failed or cancelled installations stay incomplete and can be retried. SIGINT/SIGTERM cancel active updater tasks. Installation never launches the backend.

Every stdout line is a JSON object:

- Progress: `{ "type": "progress", "stage": "python", "taskId": "uv-python-install", "status": "running", "message": "...", "currentLine": "...", "replace": true }`
- Success: `{ "type": "result", "data": { ... } }`
- Failure: `{ "type": "error", "code": "environment", "message": "..." }` with nonzero exit status (`130` for cancellation).

Progress uses semantic stages and stable workflow task IDs. Optional `percent`, `current`, `total`, `unit` (`bytes`, `objects`, or `items`), `downloadedBytes`, and `totalBytes` describe measured progress when the workflow supplies it. No overall percentage is invented. `replace: true` updates the task's live line; CR and ANSI redraws must not append log history. Normal CRLF lines remain normal log lines. UTF-8 and terminal commands can span output chunks without leaking terminal controls.

`check-update` requires a complete managed dev installation. It reads actual local Git heads (or recorded package versions) and checks the official backend/OCR branch refs through bounded GitHub API requests; it never fetches, resets, writes config, or changes the running backend. It returns `{root, channel, available, repositories:[{name,localVersion,remoteVersion,available}]}`. Unknown local versions are explicitly `"unknown"`, so they cannot be reported as current. Network or malformed upstream responses are errors.

`update` requires that same managed installation and reuses the desktop repository, environment and dependency workflow followed by full installation verification. It never stops running tasks. A live backend holds a shared lease on the install lock; an installer/update needs an exclusive lock and fails while another CLI owns that environment. The internal `lease --root PATH` command emits `{root, leased:true}` and keeps its lock until stdin closes. The caller registers its backend PID as one decimal line on stdin. If the CLI crashes and closes stdin while its detached backend is still alive, the lease remains held until that process exits. Release the caller's own idle backend before updating; active or unknown task status must refuse the operation.

`inspect` and successful `install` return `installed`, `managed`, `root`, `backendPath`, `pythonPath`, `cppPath`, `channel`, and `missing`. Paths are absolute; `backendPath` points to `main.service.py`, `pythonPath` to the private `.venv` interpreter, and `cppPath` to the OCR binary directory. `managed` indicates CLI ownership. `installed` requires a completed shared installation workflow and the presence of backend, Python, UV, OCR executable, dependency lock and setup configuration. `inspect` performs no writes or network requests.

`launch-spec` requires a complete installation and returns `{ "program": "...", "args": ["..."], "cwd": "...", "env": { "PYTHONUNBUFFERED": "1" } }`. It reuses the shared loopback backend command and adds the exact pipe endpoint. The caller owns process spawning, lifecycle and readiness checks. Unix endpoints must be absolute socket paths; Windows endpoints use `\\.\pipe\...`.

`baas-updater` and `baas-term` retain the default `desktop` feature for existing consumers. The helper selects both with `default-features = false`, retaining core orchestration and excluding Tauri adapters and dashboard rendering.
