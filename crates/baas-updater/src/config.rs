//! Configuration loading, migration, and persistence.
//!
//! Tauri callers should pass an explicit `setup.toml` path. Normal installs
//! use the target installation directory, while portable installs use an
//! executable-adjacent `setup.toml`.

use crate::{
    GitBackend, RepositoryKind, UpdateChannel, UpdaterError, UpdaterResult,
    constants::PYPI_SOURCE_LIST,
    repo::{RankedSource, SourceRanking},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Current configuration schema version.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Frontend/backend data transport used by desktop clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum BackendTransport {
    /// Encrypted loopback WebSocket transport.
    #[default]
    Websocket,
    /// Windows named-pipe transport owned by the Tauri process.
    Pipe,
}

/// Default Python package indexes used by UV.
pub fn default_pypi_sources() -> Vec<String> {
    PYPI_SOURCE_LIST
        .iter()
        .map(|source| source.to_string())
        .collect()
}

/// Complete persisted updater configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdaterConfig {
    /// Schema version used for future migrations.
    #[serde(rename = "schema_version", alias = "schemaVersion")]
    pub schema_version: u32,
    /// General updater behavior and user preferences.
    pub general: GeneralConfig,
    /// Installation and cache paths.
    pub paths: PathConfig,
    /// Repository source ranking state.
    pub repositories: RepositoryConfig,
    /// Python and UV environment settings.
    pub python: PythonConfig,
}

impl Default for UpdaterConfig {
    /// Handles the default workflow.
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            general: GeneralConfig::default(),
            paths: PathConfig::default(),
            repositories: RepositoryConfig::default(),
            python: PythonConfig::default(),
        }
    }
}

impl UpdaterConfig {
    /// Returns the BAAS installation root as a path.
    pub fn baas_root(&self) -> PathBuf {
        PathBuf::from(&self.paths.baas_root_path)
    }

    /// Returns the resolved temporary directory.
    pub fn tmp_dir(&self) -> PathBuf {
        self.baas_root().join(&self.paths.tmp_path)
    }

    /// Returns the resolved toolkit directory.
    pub fn toolkit_dir(&self) -> PathBuf {
        self.baas_root().join(&self.paths.toolkit_path)
    }

    /// Returns the persistent source ranking directory.
    pub fn source_ranking_dir(&self) -> PathBuf {
        self.baas_root()
            .join(".baas-updater")
            .join("source-ranking")
    }

    /// Validates user-controlled fields.
    pub fn validate(&self) -> UpdaterResult<()> {
        if self.schema_version == 0 {
            return Err(UpdaterError::Config(
                "schema_version must be greater than zero".to_string(),
            ));
        }
        Ok(())
    }
}

/// General updater behavior and version state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GeneralConfig {
    /// Frontend/backend data transport. Android always uses WebSocket.
    pub transport: BackendTransport,
    /// MirrorC CDK. Empty means Git update mode.
    #[serde(alias = "mirrorc_cdk")]
    pub mirrorc_cdk: String,
    /// Update channel used to select repository and MirrorC sources.
    pub channel: UpdateChannel,
    /// Current main repository SHA recorded after Git or MirrorC updates.
    #[serde(alias = "current_baas_sha")]
    pub current_baas_sha: String,
    /// Current Cpp repository SHA recorded after Git or MirrorC updates.
    #[serde(alias = "current_baas_cpp_sha")]
    pub current_baas_cpp_sha: String,
    /// Preferred remote SHA method learned from previous runs.
    #[serde(alias = "get_remote_sha_method")]
    pub get_remote_sha_method: String,
    /// Whether to launch after synchronization.
    pub launch: bool,
    /// Whether an existing process may be force-launched/replaced.
    #[serde(alias = "force_launch")]
    pub force_launch: bool,
    /// Whether debug logging is enabled.
    pub debug: bool,
    /// Whether repository and client update checks should be skipped.
    pub no_update: bool,
    /// Git implementation used when MirrorC is disabled.
    #[serde(alias = "gitBackend")]
    pub git_backend: GitBackend,
    /// Python package indexes used by UV.
    #[serde(alias = "source_list")]
    pub source_list: Vec<String>,
}

impl Default for GeneralConfig {
    /// Handles the default workflow.
    fn default() -> Self {
        Self {
            transport: BackendTransport::Websocket,
            mirrorc_cdk: String::new(),
            channel: UpdateChannel::Stable,
            current_baas_sha: String::new(),
            current_baas_cpp_sha: String::new(),
            get_remote_sha_method: String::new(),
            launch: false,
            force_launch: false,
            debug: false,
            no_update: false,
            git_backend: GitBackend::Auto,
            source_list: default_pypi_sources(),
        }
    }
}

/// Path settings persisted in setup.toml.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PathConfig {
    /// BAAS installation root directory.
    #[serde(alias = "baas_root_path")]
    pub baas_root_path: String,
    /// Cache directory relative to `baas_root_path` unless absolute.
    #[serde(alias = "tmp_path")]
    pub tmp_path: String,
    /// Toolkit directory relative to `baas_root_path` unless absolute.
    #[serde(alias = "toolkit_path")]
    pub toolkit_path: String,
}

impl Default for PathConfig {
    /// Handles the default workflow.
    fn default() -> Self {
        Self {
            baas_root_path: String::new(),
            tmp_path: "tmp".to_string(),
            toolkit_path: "toolkit".to_string(),
        }
    }
}

/// Repository source ranking state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RepositoryConfig {
    /// Ranked sources for the main repository.
    #[serde(alias = "main_sources")]
    pub main_sources: Vec<RankedSource>,
    /// Ranked sources for the Cpp repository.
    #[serde(alias = "cpp_sources")]
    pub cpp_sources: Vec<RankedSource>,
}

impl RepositoryConfig {
    /// Returns the ranking list for a repository kind.
    pub fn ranking(&self, kind: RepositoryKind) -> &[RankedSource] {
        match kind {
            RepositoryKind::Main => &self.main_sources,
            RepositoryKind::Cpp => &self.cpp_sources,
        }
    }

    /// Replaces the ranking list for a repository kind.
    pub fn set_ranking(&mut self, kind: RepositoryKind, ranking: SourceRanking) {
        match kind {
            RepositoryKind::Main => self.main_sources = ranking.sources,
            RepositoryKind::Cpp => self.cpp_sources = ranking.sources,
        }
    }
}

/// Python runtime and UV environment settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PythonConfig {
    /// `"default"` uses the updater-managed UV environment; otherwise this is
    /// a Python interpreter path.
    #[serde(alias = "runtime_path")]
    pub runtime_path: String,
    /// Python version installed by UV.
    #[serde(alias = "python_version")]
    pub python_version: String,
}

impl Default for PythonConfig {
    /// Handles the default workflow.
    fn default() -> Self {
        Self {
            runtime_path: "default".to_string(),
            python_version: "3.9.0".to_string(),
        }
    }
}

/// Configuration manager bound to one setup.toml path.
#[derive(Debug, Clone)]
pub struct ConfigManager {
    /// Path to the managed setup.toml file.
    pub config_path: PathBuf,
    /// In-memory configuration.
    pub config: UpdaterConfig,
}

impl ConfigManager {
    /// Loads setup.toml from the default library path, creating defaults when
    /// the file does not exist.
    pub fn load_default_path() -> UpdaterResult<Self> {
        Self::load_from(default_config_path()?)
    }

    /// Loads setup.toml from the executable-adjacent default path.
    pub fn load_default_path_in_app_data(_app_data_dir: impl AsRef<Path>) -> UpdaterResult<Self> {
        Self::load_default_path()
    }

    /// Loads a configuration from an explicit setup.toml path.
    pub fn load_from(path: impl Into<PathBuf>) -> UpdaterResult<Self> {
        let config_path = path.into();
        if !config_path.exists() {
            return Ok(Self {
                config_path,
                config: UpdaterConfig::default(),
            });
        }

        let content = fs::read_to_string(&config_path)?;
        let config = migrate_toml(&content)?;
        config.validate()?;
        Ok(Self {
            config_path,
            config,
        })
    }

    /// Saves the current configuration to disk.
    pub fn save(&self) -> UpdaterResult<()> {
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(&self.config)?;
        fs::write(&self.config_path, content)?;
        Ok(())
    }

    /// Updates the in-memory configuration and saves it atomically from the
    /// caller's perspective.
    pub fn update(&mut self, update: impl FnOnce(&mut UpdaterConfig)) -> UpdaterResult<()> {
        update(&mut self.config);
        self.config.validate()?;
        self.save()
    }

    /// Sets the BAAS installation root path.
    pub fn set_baas_root_path(&mut self, path: impl AsRef<Path>) -> UpdaterResult<()> {
        let value = path.as_ref().to_string_lossy().to_string();
        self.update(|config| config.paths.baas_root_path = value)
    }

    /// Sets the MirrorC CDK. Empty values disable MirrorC mode.
    pub fn set_mirrorc_cdk(&mut self, cdk: impl Into<String>) -> UpdaterResult<()> {
        let cdk = cdk.into();
        self.update(|config| config.general.mirrorc_cdk = cdk)
    }

    /// Sets the update channel.
    pub fn set_channel(&mut self, channel: UpdateChannel) -> UpdaterResult<()> {
        self.update(|config| config.general.channel = channel)
    }

    /// Sets the Python runtime path.
    pub fn set_runtime_path(&mut self, runtime_path: impl Into<String>) -> UpdaterResult<()> {
        let runtime_path = runtime_path.into();
        self.update(|config| config.python.runtime_path = runtime_path)
    }
}

/// Returns the default setup.toml path next to the executable.
pub fn default_config_path() -> UpdaterResult<PathBuf> {
    exe_adjacent_config_path()
}

/// Returns the executable-adjacent default setup.toml path.
pub fn default_config_path_in_app_data(_app_data_dir: impl AsRef<Path>) -> UpdaterResult<PathBuf> {
    default_config_path()
}

/// Returns the executable-adjacent setup.toml path.
pub fn exe_adjacent_config_path() -> UpdaterResult<PathBuf> {
    let exe = std::env::current_exe()?;
    Ok(exe
        .parent()
        .map(|parent| parent.join("setup.toml"))
        .unwrap_or_else(|| PathBuf::from("setup.toml")))
}

/// Parses current or legacy setup.toml into the current schema.
pub fn migrate_toml(content: &str) -> UpdaterResult<UpdaterConfig> {
    let value: toml::Value = toml::from_str(content)?;
    if value.get("schema_version").is_some()
        || value.get("schemaVersion").is_some()
        || value.get("general").is_some()
        || value.get("paths").is_some()
        || value.get("python").is_some()
        || value.get("repositories").is_some()
    {
        let mut config: UpdaterConfig = value.clone().try_into()?;
        if config.general.git_backend == GitBackend::Auto
            && let Some(general) = value.get("General").and_then(toml::Value::as_table)
        {
            let git_backend = first_string_value(general, &["git_backend", "gitBackend"]);
            if !git_backend.is_empty() {
                config.general.git_backend = GitBackend::parse(&git_backend)?;
            }
        }
        return Ok(config);
    }

    let mut config = UpdaterConfig::default();
    if let Some(general) = value.get("General").and_then(toml::Value::as_table) {
        config.general.mirrorc_cdk = string_value(general, "mirrorc_cdk");
        config.general.current_baas_sha =
            first_string_value(general, &["current_baas_version", "current_BAAS_version"]);
        config.general.current_baas_cpp_sha = first_string_value(
            general,
            &["current_baas_cpp_version", "current_BAAS_Cpp_version"],
        );
        config.general.get_remote_sha_method = string_value(general, "get_remote_sha_method");
        config.general.launch = bool_value(general, "launch", false);
        config.general.force_launch = bool_value(general, "force_launch", false);
        config.general.debug = bool_value(general, "debug", false);
        config.general.no_update = bool_value(general, "no_update", false);
        let git_backend = first_string_value(general, &["git_backend", "gitBackend"]);
        if !git_backend.is_empty() {
            config.general.git_backend = GitBackend::parse(&git_backend)?;
        }
        let channel = string_value(general, "channel");
        if !channel.is_empty() {
            config.general.channel = UpdateChannel::parse(&channel)?;
        } else if bool_value(general, "dev", false) {
            config.general.channel = UpdateChannel::Dev;
        }
        if let Some(sources) = general.get("source_list").and_then(toml::Value::as_array) {
            let parsed = sources
                .iter()
                .filter_map(toml::Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            if !parsed.is_empty() {
                config.general.source_list = parsed;
            }
        }
        let runtime = string_value(general, "runtime_path");
        if !runtime.is_empty() {
            config.python.runtime_path = runtime;
        }
    }

    if let Some(paths) = value.get("Paths").and_then(toml::Value::as_table) {
        config.paths.baas_root_path = string_value(paths, "BAAS_ROOT_PATH");
        let tmp = string_value(paths, "TMP_PATH");
        if !tmp.is_empty() {
            config.paths.tmp_path = tmp;
        }
        let toolkit = string_value(paths, "TOOL_KIT_PATH");
        if !toolkit.is_empty() {
            config.paths.toolkit_path = toolkit;
        }
    }

    Ok(config)
}

/// Handles the string value workflow.
fn string_value(table: &toml::map::Map<String, toml::Value>, key: &str) -> String {
    table
        .get(key)
        .and_then(toml::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Handles the first string value workflow.
fn first_string_value(table: &toml::map::Map<String, toml::Value>, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| string_value(table, key))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

/// Handles the bool value workflow.
fn bool_value(table: &toml::map::Map<String, toml::Value>, key: &str, default: bool) -> bool {
    table
        .get(key)
        .and_then(toml::Value::as_bool)
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Handles the default config uses stable channel and default runtime workflow.
    #[test]
    fn default_config_uses_stable_channel_and_default_runtime() {
        let config = UpdaterConfig::default();

        assert_eq!(config.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(config.general.channel, UpdateChannel::Stable);
        assert_eq!(config.general.git_backend, GitBackend::Auto);
        assert_eq!(config.python.runtime_path, "default");
        assert!(!config.general.source_list.is_empty());
    }

    /// Handles the migrates legacy setup toml workflow.
    #[test]
    fn migrates_legacy_setup_toml() {
        let config = migrate_toml(
            r#"
[General]
mirrorc_cdk = "abc"
current_baas_version = "main-sha"
current_baas_cpp_version = "cpp-sha"
get_remote_sha_method = "github"
dev = true
launch = true
force_launch = true
debug = true
no_update = true
git_backend = "git2"
source_list = ["https://example.invalid/simple"]
runtime_path = "C:/Python/python.exe"

[Paths]
BAAS_ROOT_PATH = "D:/BAAS"
TMP_PATH = "cache"
TOOL_KIT_PATH = "tools"
"#,
        )
        .unwrap();

        assert_eq!(config.general.mirrorc_cdk, "abc");
        assert_eq!(config.general.channel, UpdateChannel::Dev);
        assert_eq!(config.general.current_baas_sha, "main-sha");
        assert_eq!(config.general.current_baas_cpp_sha, "cpp-sha");
        assert!(config.general.no_update);
        assert_eq!(config.general.git_backend, GitBackend::Git2);
        assert_eq!(
            config.general.source_list,
            ["https://example.invalid/simple"]
        );
        assert_eq!(config.python.runtime_path, "C:/Python/python.exe");
        assert_eq!(config.paths.baas_root_path, "D:/BAAS");
        assert_eq!(config.paths.tmp_path, "cache");
        assert_eq!(config.paths.toolkit_path, "tools");
    }

    /// Returns the reads current snake case setup toml result.
    #[test]
    fn reads_current_snake_case_setup_toml() {
        let config = migrate_toml(
            r#"
schema_version = 1

[general]
mirrorc_cdk = "abc"
channel = "dev"
current_baas_sha = "main-sha"
current_baas_cpp_sha = "cpp-sha"
get_remote_sha_method = "github"
force_launch = true
no_update = true
git_backend = "git_cli"
source_list = ["https://example.invalid/simple"]

[paths]
baas_root_path = "D:/BAAS"
tmp_path = "cache"
toolkit_path = "tools"

[python]
runtime_path = "C:/Python/python.exe"
python_version = "3.11.0"

[repositories]
main_sources = []
cpp_sources = []
"#,
        )
        .unwrap();

        assert_eq!(config.general.mirrorc_cdk, "abc");
        assert_eq!(config.general.channel, UpdateChannel::Dev);
        assert_eq!(config.general.current_baas_sha, "main-sha");
        assert_eq!(config.general.current_baas_cpp_sha, "cpp-sha");
        assert_eq!(config.general.get_remote_sha_method, "github");
        assert!(config.general.force_launch);
        assert!(config.general.no_update);
        assert_eq!(config.general.git_backend, GitBackend::GitCli);
        assert_eq!(config.paths.baas_root_path, "D:/BAAS");
        assert_eq!(config.paths.tmp_path, "cache");
        assert_eq!(config.paths.toolkit_path, "tools");
        assert_eq!(config.python.runtime_path, "C:/Python/python.exe");
        assert_eq!(config.python.python_version, "3.11.0");
    }

    /// Handles the current schema preserves legacy git backend override workflow.
    #[test]
    fn current_schema_preserves_legacy_git_backend_override() {
        let config = migrate_toml(
            r#"
schema_version = 1

[general]
git_backend = "auto"

[General]
git_backend = "git2"
"#,
        )
        .unwrap();

        assert_eq!(config.general.git_backend, GitBackend::Git2);
    }

    /// Handles the legacy setup toml reads camel case git backend workflow.
    #[test]
    fn legacy_setup_toml_reads_camel_case_git_backend() {
        let config = migrate_toml(
            r#"
[General]
gitBackend = "git_cli"
"#,
        )
        .unwrap();

        assert_eq!(config.general.git_backend, GitBackend::GitCli);
    }

    /// Returns the load save round trip and setters work result.
    #[test]
    fn load_save_round_trip_and_setters_work() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("setup.toml");
        let mut manager = ConfigManager::load_from(&path).unwrap();

        manager.set_baas_root_path(dir.path()).unwrap();
        manager.set_channel(UpdateChannel::Dev).unwrap();
        manager.set_mirrorc_cdk("cdk").unwrap();
        manager.set_runtime_path("python").unwrap();

        let loaded = ConfigManager::load_from(&path).unwrap();
        assert_eq!(loaded.config.general.channel, UpdateChannel::Dev);
        assert_eq!(loaded.config.general.mirrorc_cdk, "cdk");
        assert_eq!(loaded.config.python.runtime_path, "python");
        assert_eq!(
            loaded.config.paths.baas_root_path,
            dir.path().to_string_lossy()
        );

        let saved = fs::read_to_string(&path).unwrap();
        assert!(saved.contains("baas_root_path"));
        assert!(saved.contains("mirrorc_cdk"));
        assert!(saved.contains("runtime_path"));
        assert!(!saved.contains("baasRootPath"));
        assert!(!saved.contains("mirrorcCdk"));
        assert!(!saved.contains("runtimePath"));
    }

    /// Handles the app data compat default path uses exe adjacent path workflow.
    #[test]
    fn app_data_compat_default_path_uses_exe_adjacent_path() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app-data");

        assert_eq!(
            default_config_path_in_app_data(&app_data).unwrap(),
            exe_adjacent_config_path().unwrap()
        );
    }

    /// Handles the rejects unknown channel text workflow.
    #[test]
    fn rejects_unknown_channel_text() {
        assert!(UpdateChannel::parse("nightly").is_err());
        assert_eq!(UpdateChannel::parse("dev").unwrap(), UpdateChannel::Dev);
    }
}
