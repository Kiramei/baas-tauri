# baas-updater

`baas-updater` is the BAAS installation and update library. It manages
`setup.toml`, synchronizes the main BAAS repository and Cpp/OCR prebuild
repository, prepares a UV-managed Python 3.9 environment, syncs dependencies,
and exposes a `baas-term` backed Tauri session manager.

The crate is deeply integrated with `baas-term`: Rust-native work runs through
thread tasks, while Git CLI and UV commands run through PTY-backed process
tasks so stdout/stderr is captured by the terminal renderer.

## Configuration

By default, Tauri callers resolve configuration in this order:

1. Existing `setup.toml` next to the executable for portable/debug deployments.
2. Existing `$BAAS_ROOT_PATH/setup.toml` when the app-data config points to it.
3. `setup.toml` in the writable Tauri app data directory, next to
   `.app_storage.json`.

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
uses Git. Git operations prefer system `git` through `baas-term` process tasks;
when Git CLI is unavailable or planning fails, Rust `git2` work runs through
`baas-term` thread tasks.

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

- `updater_default_config`
- `updater_load_config`
- `updater_update_config`
- `updater_run_workflow`
- `UpdaterTermManager`

The command-style functions use serializable request/response types and can be
wrapped with `#[tauri::command]` in the main app crate. `UpdaterTermManager` is
the preferred runtime integration because it emits the same terminal events as
`baas-term::TermManager`.

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
