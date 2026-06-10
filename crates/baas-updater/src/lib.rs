//! BAAS updater library.
//!
//! This crate owns configuration migration, repository synchronization,
//! MirrorC package updates, UV/Python environment preparation, workflow
//! orchestration, and Tauri-facing adapter payloads. Core modules are written
//! so tests can inject mocked process, Git, HTTP, and output implementations.

use std::{fmt, path::PathBuf};

pub mod app;
pub mod config;
pub mod constants;
pub mod environ;
pub mod mirrorc;
pub mod repo;
pub mod workflow;

/// Result alias used by all updater modules.
pub type UpdaterResult<T> = Result<T, UpdaterError>;

/// Error type used by the updater.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdaterError {
    /// Configuration could not be parsed, validated, or saved.
    Config(String),
    /// File system operation failed.
    Io(String),
    /// Network request or response processing failed.
    Network(String),
    /// Git CLI or git2 operation failed.
    Git(String),
    /// MirrorC API or package application failed.
    MirrorC(String),
    /// UV, Python, or launched process failed.
    Environment(String),
    /// Workflow orchestration failed.
    Workflow(String),
    /// The caller cancelled the operation.
    Cancelled,
}

impl UpdaterError {
    /// Returns a stable machine-readable category for this error.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Config(_) => "config",
            Self::Io(_) => "io",
            Self::Network(_) => "network",
            Self::Git(_) => "git",
            Self::MirrorC(_) => "mirrorc",
            Self::Environment(_) => "environment",
            Self::Workflow(_) => "workflow",
            Self::Cancelled => "cancelled",
        }
    }

    /// Returns the human-readable error message.
    pub fn message(&self) -> String {
        match self {
            Self::Config(message)
            | Self::Io(message)
            | Self::Network(message)
            | Self::Git(message)
            | Self::MirrorC(message)
            | Self::Environment(message)
            | Self::Workflow(message) => message.clone(),
            Self::Cancelled => "operation cancelled".to_string(),
        }
    }
}

impl fmt::Display for UpdaterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for UpdaterError {}

impl From<std::io::Error> for UpdaterError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

impl From<git2::Error> for UpdaterError {
    fn from(error: git2::Error) -> Self {
        Self::Git(error.to_string())
    }
}

impl From<toml::de::Error> for UpdaterError {
    fn from(error: toml::de::Error) -> Self {
        Self::Config(error.to_string())
    }
}

impl From<toml::ser::Error> for UpdaterError {
    fn from(error: toml::ser::Error) -> Self {
        Self::Config(error.to_string())
    }
}

impl From<zip::result::ZipError> for UpdaterError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::Io(error.to_string())
    }
}

/// Update channel used to select repository source sets.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default, Hash,
)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    /// Stable BAAS repository channel.
    #[default]
    Stable,
    /// Development BAAS repository channel.
    Dev,
}

impl UpdateChannel {
    /// Parses a user-provided channel name.
    pub fn parse(value: &str) -> UpdaterResult<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "stable" => Ok(Self::Stable),
            "dev" => Ok(Self::Dev),
            other => Err(UpdaterError::Config(format!(
                "unsupported update channel: {other}"
            ))),
        }
    }

    /// Returns the channel as the string expected by MirrorC.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Dev => "dev",
        }
    }
}

/// Repository managed by the updater.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryKind {
    /// Main BAAS Python repository.
    Main,
    /// Cpp/OCR prebuild repository.
    Cpp,
}

impl RepositoryKind {
    /// Returns a stable identifier used for files, task ids, and logs.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Cpp => "cpp",
        }
    }
}

/// Outcome of a repository, MirrorC, or environment step.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStatus {
    /// Step completed by creating missing state.
    Installed,
    /// Step updated existing state.
    Updated,
    /// Step detected the current state is already up to date.
    Skipped,
}

/// Workflow options supplied by UI or CLI callers.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowOptions {
    /// Optional explicit setup.toml path. Defaults to setup.toml next to the
    /// running executable.
    pub config_path: Option<PathBuf>,
    /// Optional override for the BAAS installation directory.
    pub install_path: Option<PathBuf>,
    /// Whether the workflow should launch the backend after syncing.
    pub launch: bool,
}

impl Default for WorkflowOptions {
    fn default() -> Self {
        Self {
            config_path: None,
            install_path: None,
            launch: true,
        }
    }
}

/// Log style understood by [`OutputSink`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStyle {
    /// Informational progress.
    Info,
    /// Successful operation.
    Success,
    /// Warning that does not stop the workflow.
    Warning,
    /// Error or failed operation.
    Error,
    /// Less prominent diagnostic text.
    Muted,
}

/// Minimal output abstraction for updater internals.
pub trait OutputSink: Send + Sync {
    /// Emits one log line with a style.
    fn line(&self, style: OutputStyle, message: &str);
}

/// Output sink that drops all messages.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopOutput;

impl OutputSink for NoopOutput {
    fn line(&self, _style: OutputStyle, _message: &str) {}
}

#[cfg(feature = "term-output")]
impl OutputSink for baas_term::threader::ThreadOutput {
    fn line(&self, style: OutputStyle, message: &str) {
        let mapped = match style {
            OutputStyle::Info => baas_term::threader::ThreadLogStyle::Info,
            OutputStyle::Success => baas_term::threader::ThreadLogStyle::Success,
            OutputStyle::Warning => baas_term::threader::ThreadLogStyle::Warning,
            OutputStyle::Error => baas_term::threader::ThreadLogStyle::Error,
            OutputStyle::Muted => baas_term::threader::ThreadLogStyle::Muted,
        };
        self.log().line(mapped, message);
    }
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) mod test_support {
    use super::{OutputSink, OutputStyle};
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    pub struct CollectOutput {
        pub lines: Arc<Mutex<Vec<(OutputStyle, String)>>>,
    }

    impl OutputSink for CollectOutput {
        fn line(&self, style: OutputStyle, message: &str) {
            self.lines
                .lock()
                .unwrap()
                .push((style, message.to_string()));
        }
    }
}
