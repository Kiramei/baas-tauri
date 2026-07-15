# C++ service integration

The desktop C++ backend remains an explicit opt-in entry. The normal frontend
startup and `backend_transport_start` command continue to launch Python. C++
Pipe startup remains unavailable until the production application owns a real
Pipe listener.

## Executable resolution

`backend_cpp_transport_start("websocket")` does not search `PATH` and does not
execute files from the user-selected BAAS project root. It accepts, in order:

1. an absolute `BAAS_CPP_SERVICE_PATH` development/operator override;
2. the exact `BAAS_service.exe` or `BAAS_service` in Tauri's resource directory;
3. the exact service next to the Tauri executable for an unpacked portable
   layout;
4. Debug builds only: the exact service in `src-tauri/resources`.

Every path must be a regular file whose original and canonical basenames are
exactly the platform service name. Application-owned candidates must remain in
their canonical owner directory, so a symlink or Windows reparse point cannot
redirect execution outside the package. Launch failures therefore cannot fall
through to an unrelated same-named program.

Readiness accepts only HTTP 200, bounded exact-length JSON from the expected
`BAAS Service` API v1 identity and a `/health` projection with
`statuses.runtime.phase == "ready"`. A rejected or timed-out child is stopped
through its managed PID file. The production service returns HTTP 202 from
`POST /shutdown` and exits cleanly.

## Development and packaging

Build `BAAS_service`, then either set `BAAS_CPP_SERVICE_PATH` or stage a known
sibling build:

```powershell
$env:BAAS_CPP_SERVICE_PATH = 'D:\path\to\BAAS_service.exe'
bun run stage:cpp-service
bun run test:cpp-service-package
```

The staging command executes `--version`, requires an exact `BAAS_service`
semantic-version identity, copies it to `src-tauri/resources`, and verifies the
copy again. Generated service binaries are ignored by Git.

Production desktop packaging uses:

```text
bun run tauri:build:cpp-service -- --target <rust-target>
```

This adds the verified service through an explicit, platform-specific Tauri
resource config. Release CI builds the pinned C++ dependencies and the explicit
`Kiramei/baas-cpp-dev` revision
`48995d820efbc12b56be32806a7e75dd7f652d29` before native Windows x64, Linux
x64, and macOS bundles.
Windows x64 portable output is a ZIP containing both executables. Targets that
do not yet have a native service build keep the existing Python-only package
and fail closed if the explicit C++ entry is selected.

## Verification

Rust tests freeze path ownership, wrong-service rejection, bounded HTTP parsing,
runtime readiness, and a real loopback lifecycle smoke whenever
`BAAS_CPP_SERVICE_PATH` is set. Script tests freeze exact filenames, candidate
ordering, and real binary identity. The C++ service data root used by the smoke
test is a temporary directory and is removed after shutdown.
