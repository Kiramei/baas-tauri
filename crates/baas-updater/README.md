# baas-updater

`baas-updater` is the BAAS installation and update library. It manages
`setup.toml`, synchronizes the main BAAS repository and Cpp/OCR prebuild
repository, prepares a UV-managed Python 3.9 environment, syncs dependencies,
and exposes Tauri-friendly adapter functions.

The crate keeps core logic independent from Tauri. The functions in `app.rs`
are plain Rust functions with serializable payloads, so the main application can
wrap or register them as Tauri commands when it is ready to replace the legacy
installer module.

## Configuration

By default, the library reads `setup.toml` next to the running executable.
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

`workflow::run_workflow` performs the complete installer flow:

1. Load and migrate configuration.
2. Synchronize the main repository and Cpp repository in parallel.
3. Move fresh temporary clones into the configured BAAS root.
4. Install/select UV and Python when `python.runtime_path = "default"`.
5. Compile and sync dependencies with `uv pip`.
6. Launch the backend when both workflow options and config allow it.

MirrorC is used when `general.mirrorc_cdk` is non-empty. Otherwise the updater
uses Git. Git operations prefer system `git` and fall back to `git2`.

## Repository Sources

Repository URLs come from `constants.rs`. Source ranking is persisted as JSON
under the BAAS temporary directory. If the URL set changes, or every source is
disabled, the updater rebuilds the ranking. Network failures demote the failing
source by setting `order = -1`.

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

These functions use serializable request/response types and can be wrapped with
`#[tauri::command]` in the main app crate. Keeping Tauri out of this library's
default dependency graph keeps unit tests lightweight and avoids Windows test
binary manifest issues.

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
