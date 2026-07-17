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
`fetch --depth 1`, `reset --hard FETCH_HEAD`, and a best-effort history prune.
CLI commands run with interactive credential prompts disabled so the installer
fails or falls back instead of waiting on an external credential window.

## Runtime Resource and Script Repositories

`runtime_repository_store` and `runtime_repository_git2` provide a separate,
fail-closed path for runtime resources and scripts. These repositories are
external data: their files are not embedded, linked, or compiled into the
Tauri/Rust executable. This path is also deliberately independent of the
legacy main and Cpp/OCR repository synchronization described above.

The git2 provider accepts only HTTPS URLs without credentials, query strings,
or fragments; disables redirects, proxy discovery, and credential callbacks;
and performs a shallow fetch of one validated advertised reference. The caller
must also supply the exact 40-hex SHA-1 commit. Materialization proceeds only
when the fetched reference peels to that commit, and only regular files named
by a strict tree manifest are published.

Before any upload-pack response is replayed into libgit2, the provider spools
the bounded response, extracts either a raw PACK stream or side-band-64k channel
1, and preflights the pack. The preflight enforces implementation ceilings and
request budgets for transport bytes, object counts, base-object types, delta
instruction streams, delta result sizes, and aggregate object bytes. It also
requires valid pack headers, delta base headers and varints, complete zlib
streams, and an exact trailer. Malformed packets, side-band fatal responses,
oversized delta results, and incomplete streams therefore fail before libgit2
can expand them.

Cancellation is cooperative and checked throughout transport, pack preflight,
ODB validation, and materialization. Connect and per-read stall timeouts are
bounded by the absolute fetch deadline; because the deadline is observed
between blocking operations, return may lag it by at most one configured
connect/read timeout. Pack preflight and post-fetch ODB validation also have
separate deadlines and distinct failure reporting.

`RuntimeRepositoryStore` validates downloaded candidates again, moves the
resources/scripts pair into immutable commit-addressed objects, writes one
immutable generation snapshot, and atomically replaces `current.json` as the
publication point. Compare-and-swap publication, `previous.json` rollback, a
recovery journal, and strict generation revalidation prevent readers from
observing a mixed or partially published pair.

When C++ standalone/WebUI owner recovery claims a store, it creates the
`.trusted-plan-owner` marker before recovering the updater. That explicit
handoff is irreversible: Rust-side publish and rollback operations then fail
closed so the two publishers cannot interleave pointer transactions;
exact-generation reads remain available. This ownership handoff does not
change the desktop application's existing Python-default launch path.

The desktop app may read the validated current generation and bind a C++
service start to that exact 64-hex generation. Production update IPC is not
exposed yet: transport validation does not establish which commit BAAS has
authorized, and there is not yet an authenticated catalog for the independent
resource and script repositories. Until such a catalog exists, URL, reference,
commit, manifest, staging, and raw publish inputs remain internal to the
Tauri-owned publisher core. No HTTP or WebSocket update route is provided.

## Environment

Managed UV is installed under:

```text
$BAAS_ROOT_PATH/<toolkit_path>/uv
```

UV cache is kept under the BAAS root and cleaned after dependency sync. When
`python.runtime_path` is not `default`, managed UV setup and dependency sync are
skipped, and launch commands use the configured interpreter directly.

## Tauri Adapter

`app.rs` exposes:

- `UpdaterTermManager`

The main app wraps the session manager with its own `#[tauri::command]` layer.
`UpdaterTermManager` owns the renderer session and emits the terminal events
consumed by the frontend.

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
- `runtime_repository_store::RuntimeRepositoryDownloader`

Runtime-repository tests cover manifest and filesystem validation, publication
and rollback fault boundaries, cancellation, deadlines, resource ceilings,
raw and side-band pack framing, spool cleanup/replay, and delta preflight. The
delta regression uses a checksum-valid pack with a real base plus executable
copy/insert instructions and asks local libgit2 to index and resolve it. Tests
use local files and loopback HTTP fixtures; they do not contact a production
HTTPS Git service or exercise an external certificate chain.

Useful verification commands:

```powershell
cargo test -p baas-updater
cargo check -p baas-tauri
```
