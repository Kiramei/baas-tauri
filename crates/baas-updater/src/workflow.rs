//! End-to-end updater workflow orchestration.

use crate::{
    NoopOutput, OutputSink, OutputStyle, RepositoryKind, UpdateStatus, UpdaterError, UpdaterResult,
    WorkflowOptions,
    config::{ConfigManager, UpdaterConfig},
    environ::{EnvironmentManager, RealProcessRunner, ReqwestDownloader},
    mirrorc::{MirrorCClient, MirrorUpdateRequest, ReqwestMirrorHttp},
    repo::{GitSourceProbe, RealGitExecutor, RepoManager, RepoSyncOptions},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
};

/// Structured workflow failure payload for Tauri and UI callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFailure {
    /// Stable error code.
    pub code: String,
    /// Human-readable error message.
    pub message: String,
    /// Workflow step that failed.
    pub step: String,
}

impl WorkflowFailure {
    /// Builds a failure payload from an updater error.
    pub fn from_error(step: impl Into<String>, error: UpdaterError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.message(),
            step: step.into(),
        }
    }
}

/// Successful workflow report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowReport {
    /// Path of the setup.toml used by the workflow.
    pub config_path: PathBuf,
    /// Main repository status.
    pub main_status: UpdateStatus,
    /// Cpp repository status.
    pub cpp_status: UpdateStatus,
    /// Whether the backend launch step ran.
    pub launched: bool,
}

/// Workflow service abstraction used by tests.
pub trait WorkflowServices: Send + Sync {
    /// Updates one repository using Git or MirrorC based on configuration.
    fn update_repository(
        &self,
        kind: RepositoryKind,
        config: &UpdaterConfig,
        target_dir: &Path,
        ranking_path: &Path,
        output: &(dyn OutputSink + Send + Sync),
    ) -> UpdaterResult<RepositoryOutcome>;

    /// Prepares UV/Python.
    fn prepare_environment(
        &self,
        config: &UpdaterConfig,
        output: &(dyn OutputSink + Send + Sync),
    ) -> UpdaterResult<()>;

    /// Synchronizes dependencies.
    fn sync_dependencies(
        &self,
        config: &UpdaterConfig,
        output: &(dyn OutputSink + Send + Sync),
    ) -> UpdaterResult<()>;

    /// Launches the backend.
    fn launch_backend(
        &self,
        config: &UpdaterConfig,
        output: &(dyn OutputSink + Send + Sync),
    ) -> UpdaterResult<()>;
}

/// Repository update outcome used by workflow services.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryOutcome {
    /// Repository kind.
    pub kind: RepositoryKind,
    /// Update status.
    pub status: UpdateStatus,
    /// SHA/version after update.
    pub sha: String,
}

/// Real workflow services.
#[derive(Debug, Clone, Copy, Default)]
pub struct RealWorkflowServices;

impl WorkflowServices for RealWorkflowServices {
    fn update_repository(
        &self,
        kind: RepositoryKind,
        config: &UpdaterConfig,
        target_dir: &Path,
        ranking_path: &Path,
        output: &(dyn OutputSink + Send + Sync),
    ) -> UpdaterResult<RepositoryOutcome> {
        if !config.general.mirrorc_cdk.is_empty() {
            let current_version = match kind {
                RepositoryKind::Main => &config.general.current_baas_sha,
                RepositoryKind::Cpp => &config.general.current_baas_cpp_sha,
            };
            let mirror = MirrorCClient::new(ReqwestMirrorHttp);
            let result = mirror.update(
                &MirrorUpdateRequest {
                    kind,
                    channel: config.general.channel,
                    current_version,
                    cdk: &config.general.mirrorc_cdk,
                    target_dir,
                },
                output,
            )?;
            return Ok(RepositoryOutcome {
                kind,
                status: result.status,
                sha: result.version,
            });
        }

        let repo = RepoManager::new(RealGitExecutor);
        let result = repo.sync(
            &RepoSyncOptions {
                kind,
                channel: config.general.channel,
                target_dir: target_dir.to_path_buf(),
                ranking_path: Some(ranking_path.to_path_buf()),
            },
            &GitSourceProbe,
            output,
        )?;
        Ok(RepositoryOutcome {
            kind,
            status: result.status,
            sha: result.sha,
        })
    }

    fn prepare_environment(
        &self,
        config: &UpdaterConfig,
        output: &(dyn OutputSink + Send + Sync),
    ) -> UpdaterResult<()> {
        EnvironmentManager::new(RealProcessRunner, ReqwestDownloader).prepare(config, output)
    }

    fn sync_dependencies(
        &self,
        config: &UpdaterConfig,
        output: &(dyn OutputSink + Send + Sync),
    ) -> UpdaterResult<()> {
        EnvironmentManager::new(RealProcessRunner, ReqwestDownloader)
            .sync_dependencies(config, output)
    }

    fn launch_backend(
        &self,
        config: &UpdaterConfig,
        output: &(dyn OutputSink + Send + Sync),
    ) -> UpdaterResult<()> {
        let port = available_port()?;
        EnvironmentManager::new(RealProcessRunner, ReqwestDownloader)
            .launch_backend(config, port, output)
    }
}

/// Runs the updater workflow with real services and no terminal output.
pub fn run_workflow(options: WorkflowOptions) -> Result<WorkflowReport, WorkflowFailure> {
    run_workflow_with_services(
        options,
        Arc::new(RealWorkflowServices),
        Arc::new(NoopOutput),
    )
}

/// Runs the updater workflow with injected services and output.
pub fn run_workflow_with_services(
    options: WorkflowOptions,
    services: Arc<dyn WorkflowServices>,
    output: Arc<dyn OutputSink + Send + Sync>,
) -> Result<WorkflowReport, WorkflowFailure> {
    let mut manager =
        load_manager(&options).map_err(|error| WorkflowFailure::from_error("config", error))?;
    if let Some(path) = &options.install_path {
        manager.config.paths.baas_root_path = path.to_string_lossy().to_string();
    }
    manager
        .save()
        .map_err(|error| WorkflowFailure::from_error("config", error))?;
    let config = manager.config.clone();
    let root = config.baas_root();
    fs::create_dir_all(&root)
        .map_err(|error| WorkflowFailure::from_error("prepare_paths", error.into()))?;

    output.line(
        OutputStyle::Info,
        "Starting BAAS repository synchronization",
    );
    let main_job = repository_job(&config, RepositoryKind::Main);
    let cpp_job = repository_job(&config, RepositoryKind::Cpp);
    let ranking_dir = config.tmp_dir().join("source-ranking");
    fs::create_dir_all(&ranking_dir)
        .map_err(|error| WorkflowFailure::from_error("prepare_paths", error.into()))?;

    let main_services = Arc::clone(&services);
    let cpp_services = Arc::clone(&services);
    let main_config = config.clone();
    let cpp_config = config.clone();
    let main_output = Arc::clone(&output);
    let cpp_output = Arc::clone(&output);
    let main_ranking = ranking_dir.join("main.json");
    let cpp_ranking = ranking_dir.join("cpp.json");

    let (main_result, cpp_result) = thread::scope(|scope| {
        let main_handle = scope.spawn(|| {
            main_services.update_repository(
                RepositoryKind::Main,
                &main_config,
                &main_job.target_dir,
                &main_ranking,
                &*main_output,
            )
        });
        let cpp_handle = scope.spawn(|| {
            cpp_services.update_repository(
                RepositoryKind::Cpp,
                &cpp_config,
                &cpp_job.target_dir,
                &cpp_ranking,
                &*cpp_output,
            )
        });
        (main_handle.join(), cpp_handle.join())
    });

    let main_outcome = main_result
        .map_err(|_| {
            WorkflowFailure::from_error(
                "main_repo",
                UpdaterError::Workflow("main repository task panicked".to_string()),
            )
        })?
        .map_err(|error| WorkflowFailure::from_error("main_repo", error))?;
    let cpp_outcome = cpp_result
        .map_err(|_| {
            WorkflowFailure::from_error(
                "cpp_repo",
                UpdaterError::Workflow("cpp repository task panicked".to_string()),
            )
        })?
        .map_err(|error| WorkflowFailure::from_error("cpp_repo", error))?;

    finalize_job(&main_job)
        .map_err(|error| WorkflowFailure::from_error("move_main_repo", error))?;
    finalize_job(&cpp_job).map_err(|error| WorkflowFailure::from_error("move_cpp_repo", error))?;

    manager.config.general.current_baas_sha = main_outcome.sha;
    manager.config.general.current_baas_cpp_sha = cpp_outcome.sha;
    manager
        .save()
        .map_err(|error| WorkflowFailure::from_error("config", error))?;

    services
        .prepare_environment(&manager.config, &*output)
        .map_err(|error| WorkflowFailure::from_error("environment", error))?;
    services
        .sync_dependencies(&manager.config, &*output)
        .map_err(|error| WorkflowFailure::from_error("dependencies", error))?;

    let should_launch = options.launch && manager.config.general.launch;
    if should_launch {
        services
            .launch_backend(&manager.config, &*output)
            .map_err(|error| WorkflowFailure::from_error("launch", error))?;
    }

    Ok(WorkflowReport {
        config_path: manager.config_path,
        main_status: main_outcome.status,
        cpp_status: cpp_outcome.status,
        launched: should_launch,
    })
}

#[derive(Debug, Clone)]
struct RepositoryJob {
    target_dir: PathBuf,
    final_dir: PathBuf,
    needs_move: bool,
}

fn load_manager(options: &WorkflowOptions) -> UpdaterResult<ConfigManager> {
    if let Some(path) = &options.config_path {
        ConfigManager::load_from(path)
    } else {
        ConfigManager::load_default_path()
    }
}

fn repository_job(config: &UpdaterConfig, kind: RepositoryKind) -> RepositoryJob {
    let root = config.baas_root();
    let tmp = config.tmp_dir();
    match kind {
        RepositoryKind::Main => {
            let has_repo = root.join(".git").exists();
            if has_repo {
                RepositoryJob {
                    target_dir: root.clone(),
                    final_dir: root,
                    needs_move: false,
                }
            } else {
                RepositoryJob {
                    target_dir: tmp.join("main-repo"),
                    final_dir: root,
                    needs_move: true,
                }
            }
        }
        RepositoryKind::Cpp => {
            let final_dir = root
                .join("core")
                .join("ocr")
                .join("baas_ocr_client")
                .join("bin");
            if cpp_bin_has_content(&final_dir) {
                RepositoryJob {
                    target_dir: final_dir.clone(),
                    final_dir,
                    needs_move: false,
                }
            } else {
                RepositoryJob {
                    target_dir: tmp.join("cpp-repo"),
                    final_dir,
                    needs_move: true,
                }
            }
        }
    }
}

fn cpp_bin_has_content(path: &Path) -> bool {
    path.is_dir()
        && fs::read_dir(path)
            .map(|entries| {
                entries
                    .flatten()
                    .any(|entry| entry.file_name().to_string_lossy() != ".git")
            })
            .unwrap_or(false)
}

fn finalize_job(job: &RepositoryJob) -> UpdaterResult<()> {
    if !job.needs_move {
        return Ok(());
    }
    move_dir_contents(&job.target_dir, &job.final_dir)
}

fn move_dir_contents(source: &Path, target: &Path) -> UpdaterResult<()> {
    fs::create_dir_all(target)?;
    if !source.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if target_path.exists() {
            if target_path.is_dir() {
                fs::remove_dir_all(&target_path)?;
            } else {
                fs::remove_file(&target_path)?;
            }
        }
        fs::rename(&source_path, &target_path).or_else(|_| {
            if source_path.is_dir() {
                copy_dir(&source_path, &target_path)?;
                fs::remove_dir_all(&source_path)?;
            } else {
                fs::copy(&source_path, &target_path)?;
                fs::remove_file(&source_path)?;
            }
            Ok::<(), std::io::Error>(())
        })?;
    }
    Ok(())
}

fn copy_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, target_path)?;
        }
    }
    Ok(())
}

fn available_port() -> UpdaterResult<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| UpdaterError::Workflow(error.to_string()))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| UpdaterError::Workflow(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockServices {
        calls: Mutex<Vec<String>>,
    }

    impl WorkflowServices for MockServices {
        fn update_repository(
            &self,
            kind: RepositoryKind,
            _config: &UpdaterConfig,
            target_dir: &Path,
            _ranking_path: &Path,
            _output: &(dyn OutputSink + Send + Sync),
        ) -> UpdaterResult<RepositoryOutcome> {
            fs::create_dir_all(target_dir).unwrap();
            fs::write(target_dir.join(format!("{}.txt", kind.as_str())), "ok").unwrap();
            self.calls
                .lock()
                .unwrap()
                .push(format!("repo:{}", kind.as_str()));
            Ok(RepositoryOutcome {
                kind,
                status: UpdateStatus::Installed,
                sha: format!("{}-sha", kind.as_str()),
            })
        }

        fn prepare_environment(
            &self,
            _config: &UpdaterConfig,
            _output: &(dyn OutputSink + Send + Sync),
        ) -> UpdaterResult<()> {
            self.calls.lock().unwrap().push("prepare".to_string());
            Ok(())
        }

        fn sync_dependencies(
            &self,
            _config: &UpdaterConfig,
            _output: &(dyn OutputSink + Send + Sync),
        ) -> UpdaterResult<()> {
            self.calls.lock().unwrap().push("sync".to_string());
            Ok(())
        }

        fn launch_backend(
            &self,
            _config: &UpdaterConfig,
            _output: &(dyn OutputSink + Send + Sync),
        ) -> UpdaterResult<()> {
            self.calls.lock().unwrap().push("launch".to_string());
            Ok(())
        }
    }

    #[test]
    fn workflow_runs_repo_steps_then_environment() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("setup.toml");
        let install_path = dir.path().join("BAAS");
        let mut manager = ConfigManager::load_from(&config_path).unwrap();
        manager.config.paths.baas_root_path = install_path.to_string_lossy().to_string();
        manager.config.general.launch = true;
        manager.save().unwrap();

        let services = Arc::new(MockServices::default());
        let output = Arc::new(NoopOutput);
        let report = run_workflow_with_services(
            WorkflowOptions {
                config_path: Some(config_path.clone()),
                install_path: None,
                launch: true,
            },
            services,
            output,
        )
        .unwrap();

        assert_eq!(report.main_status, UpdateStatus::Installed);
        assert!(report.launched);
        assert!(install_path.join("main.txt").exists());
        assert!(
            install_path
                .join("core")
                .join("ocr")
                .join("baas_ocr_client")
                .join("bin")
                .join("cpp.txt")
                .exists()
        );
        let reloaded = ConfigManager::load_from(config_path).unwrap();
        assert_eq!(reloaded.config.general.current_baas_sha, "main-sha");
        assert_eq!(reloaded.config.general.current_baas_cpp_sha, "cpp-sha");
    }

    #[test]
    fn workflow_returns_structured_failure() {
        struct Failing;
        impl WorkflowServices for Failing {
            fn update_repository(
                &self,
                _kind: RepositoryKind,
                _config: &UpdaterConfig,
                _target_dir: &Path,
                _ranking_path: &Path,
                _output: &(dyn OutputSink + Send + Sync),
            ) -> UpdaterResult<RepositoryOutcome> {
                Err(UpdaterError::Git("boom".to_string()))
            }
            fn prepare_environment(
                &self,
                _config: &UpdaterConfig,
                _output: &(dyn OutputSink + Send + Sync),
            ) -> UpdaterResult<()> {
                Ok(())
            }
            fn sync_dependencies(
                &self,
                _config: &UpdaterConfig,
                _output: &(dyn OutputSink + Send + Sync),
            ) -> UpdaterResult<()> {
                Ok(())
            }
            fn launch_backend(
                &self,
                _config: &UpdaterConfig,
                _output: &(dyn OutputSink + Send + Sync),
            ) -> UpdaterResult<()> {
                Ok(())
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let failure = run_workflow_with_services(
            WorkflowOptions {
                config_path: Some(dir.path().join("setup.toml")),
                install_path: Some(dir.path().join("BAAS")),
                launch: false,
            },
            Arc::new(Failing),
            Arc::new(NoopOutput),
        )
        .unwrap_err();

        assert_eq!(failure.code, "git");
        assert!(failure.step == "main_repo" || failure.step == "cpp_repo");
    }
}
