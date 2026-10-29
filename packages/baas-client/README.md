# @baas/client

Headless TypeScript client for the BAAS service. The desktop app and CLI share
this package's authenticated WebSocket implementation. It does not import React,
Zustand or Tauri, start the desktop app, or manage a backend installation.

```ts
import { BaasClient } from "@baas/client";

const client = new BaasClient({
  url: "http://127.0.0.1:8190",
  key: process.env.BAAS_KEY,
  timeoutMs: 15_000,
});
try {
  console.log(await client.profiles());
  console.log(await client.tasks("default_config"));
  console.log(await client.status());
} finally {
  client.close();
}
```

A WebSocket connection verifies the backend's pinned signing key before password
authentication. Set `serverSignPublicKey` explicitly for a backend using its own
signing identity. A supplied login Key initializes an uninitialized backend using
the same protocol as the desktop app. Credentials are not written to disk.

For an existing backend started with `main.service.py --pipe-name PATH`, use
`new BaasClient({ pipe: PATH })`. Local Unix sockets and Windows named pipes use
the existing BPIP protocol, with access controlled by the local backend transport.
`url` and `pipe` are mutually exclusive.

## Service API

- `profiles()` returns profile IDs mapped to display names.
- `config(id)` returns the profile configuration.
- `tasks(id)` returns event descriptors keyed by `func_name`.
- `status()` returns backend runtime status keyed by profile ID.
- `request(command, configId?, payload?)` sends one JSON Trigger command and
  returns its `data`; backend errors throw `BaasCommandError`.
- `patchConfig(id, jsonPointer, value, options?)` fetches the current snapshot,
  submits a patch using that exact backend baseline, awaits acknowledgement, then
  returns the updated configuration. A concurrent update throws
  `BaasConflictError` without retrying the write. Use
  `{ checkExpected: true, expectedValue }` to also protect a field read before a
  user approval dialog; edits made during approval then raise a conflict.
- `logs(limit?, profile?)` reads recent provider history; `onLog(listener)`
  subscribes to future entries and returns an unsubscribe function.
- `onStatus((update, snapshot) => {})` receives normalized provider changes.
  `update` has `{ full, configId, status }`: a full map uses `configId: null`,
  while a delta identifies one profile and carries that profile's status.
  `snapshot` always contains the complete current map. Read `statusSnapshot` for
  a defensive clone without a network request. Each subscriber receives its own
  copies, and older timestamped updates cannot regress a newer cached state.
- `onDisconnect((error) => {})` fires once per lost connection or explicit close.
  All subscription methods return an unsubscribe function. Subscribe before
  `connect()` when the initial snapshot or very fast completion matters.

A successful `start_scheduler` or `solve` response means the request was accepted.
Current backends return `run_id`; match that same ID in terminal status with
`running: false` and `exit_code: 0 | 1` to determine completion. Busy responses use
`status: "already-running"` and return the existing run's ID. A stop timeout can
return `status: "stopping"` while the worker unwinds.

The CLI builds on these subscriptions to wait for one correlated execution and
follow its logs. For example, from the repository root:

```sh
bun run cli --profile default_config --yes --wait --follow run explore_normal_task
bun run cli --profile default_config --wait-timeout 120 wait RUN_ID
bun run cli --profile default_config --follow logs 50
```

Cancellation and wait timeouts stop observation; use an explicit `stop` command to
stop the backend worker. Reconnection reads status and logs without replaying a
mutation. See [the CLI guide](../../cli/README.md) for dry runs, command packs,
private local sessions and BAAS.md domain instructions.

A later read can reconnect and authenticate again. Lost in-flight requests reject;
mutations are never automatically submitted again. Inspect status before deciding
whether to retry a mutation whose acknowledgement was lost. `close()` also aborts
unfinished authentication handshakes. Binary ZIP import/export and streaming
Trigger commands are outside this JSON request API.

Tests use real local sockets and a signed encrypted WebSocket fixture:

```sh
bun test packages/baas-client/tests
```

An opt-in compatibility smoke also runs the bundled Bun CLI against the real
Python service routers, authentication and configuration manager:

```sh
bun run cli:build
python scripts/backend-smoke.py --backend-path ../baas-dev
```

Use a Python environment with the BAAS service dependencies installed. The script
accepts `--cli-path` for another Bun entry or compiled executable. It creates an
isolated temporary service root and skips the game/OCR/ADB startup lifecycle.
The runtime lifecycle checks use a fixture worker while preserving the real
service command dispatch, threading, provider stream and run ID tracking. Existing
backend configurations are never loaded or modified.
