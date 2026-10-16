# Runtime status recovery after a backend restart

Date: 2026-10-16. Times are China Standard Time (UTC+8).

## Observed failure and cause

The Global profile kept showing Stop despite repeated clicks. Client logs show a successful Global start followed by a backend restart at 22:41:12; subsequent stop requests returned `unknown-config`. An independent `/health` read listed only the Bilibili runtime session, with no Global session. RustRover was connected to its debugger and was not suspended at a breakpoint.

The frontend retained stale runtime state. Connection recovery did not clear `statusStore`, and the restarted backend's empty `status: {}` entered the wrapped-status branch, creating an `undefined` key without removing Global's old `running: true`. Stop replies arrived, but the older backend did not additionally publish a stopped status for a missing session. This is not a Global-only pause path, and the incident does not implicate shared memory: this connection used WebSocket.

## Correction

- Clear old runtime state when a connection generation is invalidated or a provider is rebuilt, then restore it from the current backend; preserve saved configuration and received logs.
- Handle empty snapshots correctly, reject invalid wrapped statuses, and retain ordinary per-profile and per-field incremental merges.
- Correct the affected stale state after an `unknown-config` stop reply. Capture its object identity when submitting the request and only clear that unchanged object, so a delayed reply cannot erase a newer run delivered over the provider channel.
- Keep the backend protocol compatible. No Global task logic, game configuration, or user-edited homepage styling was changed.

## Validation and limits

- The real debug client now displays Global, service connected, Start, and no executing task.
- `bun test tests/frontend`: 64 passed, 0 failed, 768 assertions.
- `bunx tsc --noEmit` and `git diff --check` passed.
- The added regression exercises the real store with simulated channels: reconnect/empty snapshots, retired generations, incremental updates, other-profile preservation, delayed stop replies, missing external callbacks, and invalid replies.

No Global gameplay was restarted for this repair. Validation covers the observed state-recovery and reply-handling failure; it does not claim that every Global task or blocking call has been tested for cancellation.
