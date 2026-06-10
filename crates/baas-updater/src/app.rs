//! Tauri-facing adapter functions.
//!
//! The main application can register these commands when it is ready to switch
//! from the legacy installer module. This module intentionally keeps the core
//! workflow independent from Tauri event emitters.

use crate::{
    WorkflowOptions,
    config::{ConfigManager, UpdaterConfig},
    workflow::{WorkflowFailure, WorkflowReport, run_workflow},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Request payload for updating one setup.toml field from Tauri.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigUpdateRequest {
    /// Optional explicit setup.toml path.
    pub config_path: Option<PathBuf>,
    /// Optional BAAS installation root.
    pub baas_root_path: Option<PathBuf>,
    /// Optional MirrorC CDK.
    pub mirrorc_cdk: Option<String>,
    /// Optional runtime path.
    pub runtime_path: Option<String>,
}

/// Returns the default updater configuration.
pub fn updater_default_config() -> UpdaterConfig {
    UpdaterConfig::default()
}

/// Loads and migrates setup.toml from the default or explicit path.
pub fn updater_load_config(config_path: Option<PathBuf>) -> Result<UpdaterConfig, String> {
    let manager = if let Some(path) = config_path {
        ConfigManager::load_from(path)
    } else {
        ConfigManager::load_default_path()
    };
    manager
        .map(|manager| manager.config)
        .map_err(|error| error.message())
}

/// Updates selected setup.toml fields and saves the file.
pub fn updater_update_config(request: ConfigUpdateRequest) -> Result<UpdaterConfig, String> {
    let mut manager = if let Some(path) = request.config_path {
        ConfigManager::load_from(path)
    } else {
        ConfigManager::load_default_path()
    }
    .map_err(|error| error.message())?;

    manager
        .update(|config| {
            if let Some(path) = request.baas_root_path {
                config.paths.baas_root_path = path.to_string_lossy().to_string();
            }
            if let Some(cdk) = request.mirrorc_cdk {
                config.general.mirrorc_cdk = cdk;
            }
            if let Some(runtime) = request.runtime_path {
                config.python.runtime_path = runtime;
            }
        })
        .map_err(|error| error.message())?;
    Ok(manager.config)
}

/// Runs the updater workflow.
pub fn updater_run_workflow(options: WorkflowOptions) -> Result<WorkflowReport, WorkflowFailure> {
    run_workflow(options)
}

/// Command names exported by this adapter.
pub const COMMAND_NAMES: &[&str] = &[
    "updater_default_config",
    "updater_load_config",
    "updater_update_config",
    "updater_run_workflow",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_command_returns_schema_one() {
        assert_eq!(updater_default_config().schema_version, 1);
    }
}
