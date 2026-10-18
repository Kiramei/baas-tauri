# Preview startup repair — 2026-10-16

The executable opened correctly; the failure was entering the Home workspace after backend files were updated. The local `baas-dev` checkout still contained the shared-memory implementation.

## Observed cause

The isolated appearance preview had a mixed backend after its remote updater ran around 09:37 China time:

- `main.service.py` had been replaced by a remote version with `--pipe-name` but no `--shm-name`. Launching the shared-memory command consequently exited in argument parsing.
- `service` was still a junction into an earlier verification directory. That service expected `deploy.installer.const.normalize_update_channel`, while the updated preview `deploy` did not provide it.
- The Python persistent log records `ImportError: cannot import name 'normalize_update_channel'` during FastAPI lifespan startup at 01:37:05 UTC. The following launch exited immediately after initializing logging.
- Before the replacement, the same executable and transport had successfully reported shared-memory READY and frontend data readiness. There was no Windows application crash event for this executable.

This is a backend version mismatch caused by replacing unpublished local code with remote files, not a shared-memory throughput limitation.

## Repair

`scripts/prepare-local-preview.py` copies the current local backend as independent real directories, preserves the preview's configuration and desktop executable, and moves replaced runtime files to a timestamped sibling backup. It only permits destinations under the workspace `.codex_tmp` directory. The source checkout and daily installation are untouched.

The repaired preview uses `transport = "shm"` and `no_update = true`, keeping this unpublished backend snapshot coherent. `backend-snapshot.json` records hashes for 502 runtime files. The old backend remains recoverable in `backend-before-repair-20261016T015958586001Z` beside the preview.

The desktop startup code now checks SHM entry-point support, adapter files and application wiring before launch. If an older backend replaces the matching build, the updater reports a failed launch task with the missing capability and recovery instructions immediately.

## Actual verification

Using the previously delivered release executable and its embedded `http://tauri.localhost/` page:

- Full process restart at 10:01:06: backend context root points to the repaired preview; SHM READY succeeded; runtime initialized in 444.1 ms.
- Full process restart at 10:01:35: SHM READY succeeded; runtime initialized in 478.0 ms.
- Both runs reached Home. Actual DOM shows `服务已连接`, the B server profile, and no running task.
- After the second restart, all 502 runtime hashes remained unchanged, `--shm-name` remained present, and `no_update` remained true.
- Python SHM/native startup tests: 19 passed.
- Rust regression tests for a replaced entry point and a partially overwritten adapter: 2 passed.

No game task was started and no game input was sent during this repair.
