# C++ service integration

Desktop persists the selected implementation in
`general.backend_runtime = "python" | "cpp"`. Missing and legacy values default
to Python. Startup reads the runtime and transport from one configuration
snapshot; recovery and settings switches keep using that same runtime instead
of reverting to Python.

The desktop settings page exposes Python and C++ runtime choices. Selecting C++
atomically selects WebSocket because the production C++ process does not own a
Pipe listener yet. Configuration migration, the frontend selection resolver,
and the Rust command all enforce that coupling. An explicit C++ startup failure
is reported to the user and never retries through `backend_transport_start` or
launches Python as a fallback. Selecting Python restores both WebSocket and Pipe
choices. A failed explicit switch stops the rejected child and restores the
previous persisted selection, but does not launch that previous runtime during
the failed operation. Android ignores a persisted C++ value and remains on
Python.

The updater launch stage is disabled when an existing desktop configuration
selects C++; after synchronization the setup page starts the packaged C++
service explicitly. This avoids transiently launching Python during normal C++
startup. `updater_reset_backend_auth_and_restart` also dispatches to the
persisted runtime.

Frontend integrations may call `startCppBackendTransport("websocket")`
directly. Until the C++ process owner enables its production Pipe listener, an
explicit C++ Pipe request fails closed.
The Tauri ACL exposes `backend_cpp_transport_start` only through the desktop
`allow-cpp-transport-command` permission; Android and the broader legacy
command permission do not inherit it.

## Pipe connection ownership

`backend_pipe_open` returns an opaque decimal-string connection token. The
frontend passes that token to every send and close command. Reconfiguring or
closing the Pipe manager advances its generation, so an older asynchronous
open cannot publish itself after the endpoint changed. Reader completion and
stale frontend cleanup remove a connection only when both its channel key and
token still match; they cannot remove a newer connection that reused the same
key. Close, reconfigure, reader termination, and replacement all flip a shared
closing gate before removing the entry. A sender checks that gate again after
acquiring the serialized writer, so no business frame can follow the close
frame and a queued stale send cannot escape after the close boundary.

Every open also carries a client-generated canonical UUID. Closing while the
handshake is pending immediately calls `backend_pipe_cancel_open` with that
UUID. Cancellation covers connection retry, request write, and `open_ok` read,
drops the socket promptly, and is backed by a ten-second total handshake
deadline. A one-entry-per-key cancellation tombstone handles IPC reordering
where cancel arrives before open; a different attempt UUID is never cancelled.

The Tauri connection queues frames that arrive before the open invocation
settles, publishes `onOpen`, and then drains that queue in order. Closing while
the invocation is pending invalidates the frontend attempt; if the invocation
later succeeds, its exact returned token is closed without reviving the client.
The pre-open queue is bounded to 256 frames and 64 MiB plus one frame header;
overflow emits one error and fails closed.

Same-key replacement, reconfiguration, and close-all send exactly one terminal
frame to the retired frontend channel through the shared terminal gate before
aborting its reader. A reader failure racing retirement cannot duplicate the
terminal or remove the replacement token.

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

Before the first `--version` spawn, automatic discovery performs this fixed
sequence: absolute path, exact original basename, `realpath`, regular-file
metadata, exact canonical basename, then canonical owner containment. The
staged destination is unlinked before copy and the complete sequence plus
`--version` identity is repeated on the copied file.

Readiness accepts only HTTP 200, bounded exact-length JSON from the expected
`BAAS Service` API v1 identity and a `/health` projection with
`statuses.runtime.phase == "ready"`. A rejected or timed-out child is stopped
through its managed PID file. The production service returns HTTP 202 from
`POST /shutdown` and exits cleanly.

The PID file is a versioned JSON identity record, not a bare PID. It binds the
canonical backend executable, canonical project root, backend kind, loopback
port, and process creation identity. Windows reads structured CIM fields, Linux reads NUL-delimited
`/proc` argv plus the kernel start tick, and macOS combines `proc_pidpath` with
the process start projection. Cleanup refuses an identity mismatch, preserves
the PID file for diagnosis, and confirms that the recorded process identity has
disappeared after termination. C++ cleanup first sends the exact
`POST /shutdown` request to the recorded port and accepts only the API v1 HTTP
202 response. It waits for the same process identity to disappear, then falls
back to managed force termination if graceful shutdown is rejected or times
out. Older JSON records without a port remain readable but use force
termination; a live legacy numeric PID file is never trusted.

## Development and packaging

Build `BAAS_service`, then either set `BAAS_CPP_SERVICE_PATH` or stage a known
sibling build:

```powershell
$env:BAAS_CPP_SERVICE_PATH = 'D:\path\to\BAAS_service.exe'
$env:BAAS_CPP_SERVICE_REMOTE_JAR = 'D:\path\to\scrcpy-server.jar'
bun run stage:cpp-service
bun run test:cpp-service-package
```

The staging command executes `--version`, requires an exact `BAAS_service`
semantic-version identity, and verifies its application-owned copy again. The
packaging entry also requires an absolute, non-empty `scrcpy-server.jar`, stages
it as a separate application resource, and verifies owner containment and byte
size. Before C++ launch, Tauri materializes that resource at
`<BAAS_ROOT>/service/remote/scrcpy-server.jar`; symlinked destinations fail
closed. Generated service resources are ignored by Git.

Production desktop packaging uses:

```text
bun run tauri:build:cpp-service -- --target <rust-target>
```

This adds the verified service through an explicit, platform-specific Tauri
resource config. Release CI builds the pinned C++ dependencies and the explicit
`Kiramei/baas-cpp-dev` revision
`cd50c8085d943cfdb801417e5c33f5c46f7470fd` before native Windows x64, Linux
x64, and macOS bundles.
Windows x64 portable output is a ZIP containing both executables and the
ws-scrcpy server resource. Targets that
do not yet have a native service build keep the existing Python-only package
and fail closed if the explicit C++ entry is selected.

Both release CI and the Windows x64 code-quality job build that pinned revision
and must pass a real loopback `/version` + ready `/health` + accepted
`POST /shutdown` + exit-zero smoke. The step cannot silently skip when the
binary is missing. Windows portable assembly is target-gated: only x64 accepts
the x64 service, and it revalidates identity and byte equality after staging.

The stricter authenticated WebSocket gate is run separately after a service
build:

```powershell
$env:BAAS_CPP_SERVICE_PATH = 'D:\path\to\BAAS_service.exe'
$env:BAAS_CPP_SERVICE_REMOTE_JAR = 'D:\path\to\scrcpy-server.jar'
bun run e2e:cpp-service
```

This command never skips or falls back when either artifact is absent. It uses
the standard Bun WebSocket client so the gate retains the browser/WebView
`permessage-deflate` offer and detects native upgrade incompatibilities. It
starts the real service with an isolated project root, pins the signing key
published by that exact process, initializes and authenticates `/ws/control`,
and resumes authenticated `provider`, `sync`, and `trigger` channels. The gate
uses a high JSON-safe integer trigger timestamp and requires the callback to
echo it exactly. It then proves the production configuration path end to end:
add, sync list/pull, ZIP export with an adjacent exact-length binary frame,
remove, binary import, sync pull, cleanup, and graceful HTTP shutdown.

## Verification

Rust tests freeze path ownership, wrong-service rejection, bounded HTTP parsing,
runtime readiness, and a real loopback lifecycle smoke whenever
`BAAS_CPP_SERVICE_PATH` is set. Script tests freeze exact filenames, candidate
ordering, and real binary identity. The C++ service data root used by the smoke
test is a temporary directory and is removed after shutdown.
`bun run test:cpp-service-e2e-contract` freezes the fail-closed artifact
requirements without launching a service; `bun run e2e:cpp-service` is the
mandatory real-process WebSocket and trigger correlation gate.
