//! Tauri-facing adapter functions.
//!
//! The main application can register these commands when it is ready to switch
//! from the legacy installer module. This module intentionally keeps the core
//! workflow independent from Tauri event emitters.

use crate::{
    WorkflowOptions,
    config::{ConfigManager, UpdaterConfig},
    workflow::{WorkflowFailure, WorkflowReport, run_terminal_workflow_flow, run_workflow},
};
use baas_term::{
    renderer::renderer_loop,
    types::{RendererEvent, SessionMetadata, SessionStartedPayload, TaskHandle, TermState},
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::Ordering, mpsc},
    thread,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

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

/// Terminal-backed updater session manager.
///
/// This manager starts the real updater workflow through `baas-term` renderer,
/// process tasks, and thread tasks. It is separate from the legacy installer so
/// the main application can opt in without replacing existing commands first.
#[derive(Clone, Default)]
pub struct UpdaterTermManager {
    inner: Arc<Mutex<TermState>>,
}

impl UpdaterTermManager {
    /// Starts a terminal-rendered updater workflow.
    pub fn start(
        &self,
        app: AppHandle,
        options: WorkflowOptions,
    ) -> Result<SessionMetadata, String> {
        self.stop_all()?;

        let session_id = Uuid::new_v4().to_string();
        let (renderer_tx, renderer_rx) = mpsc::channel();
        let (initial_rows, initial_cols) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "updater manager lock poisoned")?;
            state.current_session_id = Some(session_id.clone());
            state.renderer_tx = Some(renderer_tx.clone());
            state.tasks.clear();
            if state.rows == 0 {
                state.rows = 32;
            }
            if state.cols == 0 {
                state.cols = 120;
            }
            (state.rows, state.cols)
        };

        app.emit(
            "build:session-started",
            SessionStartedPayload {
                session_id: session_id.clone(),
                status: "running".to_string(),
            },
        )
        .map_err(|error| error.to_string())?;

        let renderer_app = app.clone();
        let renderer_session_id = session_id.clone();
        thread::spawn(move || {
            renderer_loop(
                renderer_app,
                renderer_session_id,
                renderer_rx,
                initial_rows,
                initial_cols,
            )
        });

        let flow_inner = Arc::clone(&self.inner);
        let flow_session_id = session_id.clone();
        thread::spawn(move || {
            run_terminal_workflow_flow(flow_inner, flow_session_id, renderer_tx, options)
        });

        Ok(SessionMetadata {
            session_id,
            status: "running".to_string(),
        })
    }

    /// Resizes active terminal process tasks and renderer state.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let (tasks, tx) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "updater manager lock poisoned")?;
            state.rows = rows;
            state.cols = cols;
            (
                state.tasks.values().cloned().collect::<Vec<_>>(),
                state.renderer_tx.clone(),
            )
        };

        for task in tasks {
            if let TaskHandle::Process { master, .. } = &*task {
                master
                    .lock()
                    .map_err(|_| "updater pty master lock poisoned")?
                    .resize(portable_pty::PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|error| error.to_string())?;
            }
        }
        if let Some(tx) = tx {
            let _ = tx.send(RendererEvent::Resize { rows, cols });
        }
        Ok(())
    }

    fn stop_all(&self) -> Result<(), String> {
        let (tasks, tx) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "updater manager lock poisoned")?;
            let tasks = state.tasks.drain().collect::<Vec<_>>();
            (tasks, state.renderer_tx.clone())
        };

        for (task_id, handle) in tasks {
            match &*handle {
                TaskHandle::Process { child, .. } => {
                    let _ = child
                        .lock()
                        .map_err(|_| "updater child lock poisoned")?
                        .kill();
                }
                TaskHandle::Thread { cancel } => {
                    cancel.store(true, Ordering::Relaxed);
                }
            }
            if let Some(tx) = &tx {
                let _ = tx.send(RendererEvent::TaskFinished {
                    task_id,
                    region_id: String::new(),
                    status: "stopped".to_string(),
                    exit_code: None,
                    error: None,
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_command_returns_schema_one() {
        assert_eq!(updater_default_config().schema_version, 1);
    }
}
