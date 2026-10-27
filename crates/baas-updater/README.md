# baas-updater

`baas-updater` is the BAAS installation and update library. It manages
`setup.toml`, synchronizes the main BAAS repository and Cpp/OCR prebuild
repository, prepares a UV-managed Python 3.9 environment, syncs dependencies,
and exposes a `baas-term` backed Tauri session manager.

The crate is deeply integrated with `baas-term`: Rust-native work runs through
thread tasks, while Git CLI and UV commands run through PTY-backed process
tasks so stdout/stderr is captured by the terminal renderer.

## Configuration

Tauri callers pass the active configuration path explicitly:

1. Portable deployments are detected by an existing executable-adjacent
   `setup.toml`; `.app_storage.json` is kept next to the executable and
   `baas_root_path` is normalized to `"."`.
2. Normal deployments remember the chosen install directory in
   `.app_storage.json`; updates load and save only `<install-dir>/setup.toml`.
3. If the remembered install directory is missing or empty, the frontend shows
   the setup wizard instead of creating app-data `setup.toml`.

Tests and UI callers can pass an explicit path through `ConfigManager::load_from`.

The current schema is version `1`:

```toml
schema_version = 1

[general]
transport = "shm"
transport_version = 1
mirrorc_cdk = ""
channel = "stable"
current_baas_sha = ""
current_baas_cpp_sha = ""
get_remote_sha_method = ""
launch = false
force_launch = false
debug = false
no_update = false
git_backend = "auto"
source_list = ["https://mirrors.aliyun.com/pypi/simple"]

[paths]
baas_root_path = "D:/BAAS"
tmp_path = "tmp"
toolkit_path = "toolkit"

[python]
runtime_path = "default"
python_version = "3.9.0"

[repositories]
main_sources = []
cpp_sources = []
```

Legacy `[General]`, `[URLs]`, and `[Paths]` files are migrated on load. The
old `dev = true` flag becomes `channel = "dev"`; otherwise the channel defaults
to `stable`.

On Windows, the default native transport is `shm`. Existing `pipe` preferences
without `transport_version` migrate once to shared memory. A versioned explicit
`pipe` preference remains available for compatibility and performance comparison;
`websocket` preferences are preserved. macOS also supports `shm` natively on
Apple Silicon and Intel, migrates legacy `pipe` preferences to `shm`, and keeps
explicit `websocket` preferences. Other platforms retain their existing native
pipe transport and map shared-memory preferences to that transport.

## Workflow

`app::UpdaterTermManager::start(app, options)` is the UI-facing entry point.
It starts a `baas-term` renderer session and then runs
`workflow::run_terminal_workflow_flow`, which performs the complete installer
flow:

1. Load and migrate configuration.
2. Synchronize the main repository and Cpp repository in parallel.
3. Move fresh temporary clones into the configured BAAS root.
4. Install/select UV and Python when `python.runtime_path = "default"`.
5. Compile and sync dependencies with `uv pip`.
6. Launch the backend when both workflow options and config allow it.

MirrorC is used when `general.mirrorc_cdk` is non-empty. Otherwise the updater
uses Git. `general.git_backend` selects the Git implementation: `auto` prefers
system `git` and falls back to `git2`, `git_cli` uses only system `git`, and
`git2` uses Rust `git2`/libgit2 only.

When `general.no_update = true`, repository synchronization is skipped and the
workflow keeps using the current main and Cpp/OCR files.

## Repository Sources

Repository, UV, CPython, and PyPI URLs come from `constants.rs` or the migrated
config. Source ranking is persisted as JSON under
`$BAAS_ROOT_PATH/.baas-updater/source-ranking`: `main.json`, `cpp.json`,
`uv.json`, `cpython.json`, and `pypi.json`. If a URL set changes, or every
source is disabled, the updater rebuilds the ranking. Network failures demote
the failing source by setting `order = -1`; if every source fails three
consecutive ranking cycles, the updater reports an error.

All Git clone and update operations are shallow. CLI updates use
`fetch --depth 1` and `reset --hard FETCH_HEAD`. Git's automatic maintenance
decides when object cleanup is necessary; updates no longer force a complete
repack or expire all reflogs before launching the backend.
CLI commands run with interactive credential prompts disabled so the installer
fails or falls back instead of waiting on an external credential window.

## Environment

Managed UV is installed under:

```text
$BAAS_ROOT_PATH/<toolkit_path>/uv
```

UV cache is kept under the BAAS root and retained after dependency sync so
later updates can reuse downloaded and built wheels. Cache cleanup is an
explicit maintenance action (`uv cache prune` for unused entries, or
`uv cache clean` to clear everything); accumulated cache uses additional disk
space. Pass `--cache-dir "$BAAS_ROOT_PATH/<toolkit_path>/uv/cache"` when running
either command manually so it operates on the updater's cache. When
`python.runtime_path` is not `default`, managed UV setup and dependency sync are
skipped, and launch commands use the configured interpreter directly.

## Tauri Adapter

`app.rs` exposes:

- `UpdaterTermManager`

The main app wraps the session manager with its own `#[tauri::command]` layer.
`UpdaterTermManager` owns the renderer session and emits the terminal events
consumed by the frontend.

For shared memory, the desktop host creates a fresh randomly named endpoint
before launching Python and passes it through `WorkflowOptions.shm_name` and
`--shm-name`. The updater does not create a second backend when attaching to the
endpoint allocated for its launch. The legacy `pipe_name` option is retained
for other native platforms and compatibility runs.

On macOS the native session uses POSIX `shm_open`/`mmap`, four named semaphores
for slot ownership, and `kqueue` process-exit notifications. Darwin name limits
are handled with a shared SHA-256 name scheme. Kernel names are unlinked after
both peers attach, while open handles keep the mapping alive. Interrupted
readers/writers notice stop and peer exit without requiring new data.

The desktop preflight installs `runtime/shm_macos.py` into the matching backend
and adds a Darwin-only dispatch to `shm_native.py`. It repairs these files after
backend updates, while retaining the existing Windows implementation and wire
protocol. A backend without the SHM entry point is still rejected with an
actionable error. WebSocket remains available as an explicit alternative.

Native regression commands (using a prepared backend):

```sh
BAAS_SHM_TEST_BACKEND=/path/to/BAAS cargo test -p baas-tauri shm_ --lib
BAAS_SHM_TEST_BACKEND=/path/to/BAAS /path/to/BAAS/.venv/bin/python scripts/tests/test_macos_shm.py
```

## Testing

The unit tests are mock-first. They do not require real Git remotes, MirrorC
CDKs, UV downloads, or network access. External operations are isolated behind
traits:

- `repo::GitExecutor`
- `repo::SourceProbe`
- `mirrorc::MirrorHttp`
- `environ::ProcessRunner`
- `environ::AssetDownloader`
- `workflow::WorkflowServices`

Useful verification commands:

```powershell
cargo test -p baas-updater
cargo check -p baas-tauri
```

The offline performance fixture compares the previous forced Git cleanup and
UV cache clearing behavior with retained caches:

```powershell
python scripts/benchmark-updater.py --uv path/to/uv.exe --output result.json
```

It creates temporary Git repositories and a loopback HTTP wheel server; it does
not modify an installed BAAS or contact public mirrors. The Git fixture is a
12 MiB binary tree with small revision changes. The UV fixture alternates two
8 MiB wheel versions after warming both versions, then measures compile/sync
and the old post-sync cleanup. This models reuse and rollback, rather than
first-time dependency downloads.

On Windows (Git 2.54.0, UV 0.9.11), four local rounds on 2026-10-15 produced:

| Fixture | Previous median | Retained cache median |
| --- | ---: | ---: |
| Shallow Git update | 937 ms | 441 ms |
| Warm wheel version change | 525 ms | 175 ms |

The wheel test transferred 64.2 MiB over loopback in the previous behavior
and zero bytes in the retained-cache runs. These are local fixture results,
not an estimate of overall updater speed or public network throughput.
Raw samples are in `docs/updater-performance-local-2026-10-15.json`.
Git fetch's [automatic maintenance](https://git-scm.com/docs/git-fetch#Documentation/git-fetch.txt---auto-maintenance)
and UV's [cache reuse behavior](https://docs.astral.sh/uv/concepts/cache/)
explain why explicit full cleanup is unnecessary on every update.

## Commit history

`history::get_commit_history` reads backend commit metadata for the selected stable
or development channel. Desktop and Android use the same engine with separate HTTP
adapters. The GitHub list-commits API supplies only the hash, author name and first
message line to the persistent cache; patches, message bodies, author emails and
Git objects are not stored. The native commands put this cache in the application
cache directory, outside the installed repository's `.git`.

The default request returns 100 entries, capped at 500, with a ten-minute cache.
Refreshing never fetches or deepens a Git repository. If the API is unavailable,
the engine can read an existing matching `master` checkout, the scoped
`.baas-commit-history.json` packaged with a Gitless installation, or old cached
metadata. Shallow checkouts and packaged snapshots are reported as partial, and
failures remain visible through the report's issue field. MirrorC credentials and
availability are independent of this read-only operation.
