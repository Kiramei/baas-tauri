//! End-to-end updater workflow orchestration.

use crate::{
    NoopOutput, OutputSink, OutputStyle, RepositoryKind, UpdateStatus, UpdaterError, UpdaterResult,
    WorkflowOptions,
    config::{ConfigManager, UpdaterConfig},
    environ::{
        CommandSpec, EnvironmentManager, EnvironmentSourceKind, HttpSourceProbe, RealProcessRunner,
        ReqwestDownloader, ensure_uv_installed_from, launch_backend_command,
        managed_python_configured, ranked_environment_source_with_output,
        requirements_compile_cached, requirements_path, save_requirements_cache,
        uses_managed_runtime, uv_cache_clean_command, uv_compile_command_with_index, uv_executable,
        uv_python_install_command_with_mirror, uv_sync_command_with_index, uv_venv_command,
    },
    mirrorc::{MirrorCClient, MirrorUpdateRequest, ReqwestMirrorHttp},
    repo::{
        GitExecutor, GitSourceProbe, RealGitExecutor, RepoManager, RepoSyncOptions,
        load_or_benchmark_ranking, repository_branch, repository_urls, save_ranking,
    },
};
use baas_term::{
    common::{session_is_current, wait_for_completions},
    processor::{ScriptCommand, run_process_and_wait, spawn_process_task},
    threader::{ThreadOutput, spawn_thread_task},
    types::{RendererEvent, TaskCompletion, TaskSpec, TermState, WorkflowPlan},
    workflow::{WorkflowBuilder, WorkflowTask},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
        mpsc::Sender,
    },
    thread,
    time::Duration,
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

/// Shared cleanup registry for one updater workflow run.
///
/// The workflow registers only transient paths it creates itself. Cleanup is
/// intentionally limited to staging and ranking directories so aborting an
/// update never removes an existing installation.
#[derive(Debug, Default)]
pub struct WorkflowCleanupState {
    transient_paths: BTreeSet<PathBuf>,
}

impl WorkflowCleanupState {
    /// Registers a transient path for later cleanup.
    pub fn register_path(&mut self, path: impl Into<PathBuf>) {
        self.transient_paths.insert(path.into());
    }

    /// Removes registered transient paths that still exist.
    pub fn cleanup(&self) -> UpdaterResult<Vec<PathBuf>> {
        let mut removed = Vec::new();
        for path in self.transient_paths.iter().rev() {
            if !path.exists() {
                continue;
            }
            if path.is_dir() {
                fs::remove_dir_all(path)?;
            } else {
                fs::remove_file(path)?;
            }
            removed.push(path.clone());
        }
        Ok(removed)
    }
}

/// Creates an empty workflow cleanup registry.
pub fn new_workflow_cleanup_state() -> Arc<Mutex<WorkflowCleanupState>> {
    Arc::new(Mutex::new(WorkflowCleanupState::default()))
}

/// Runs cleanup for a shared workflow cleanup registry.
pub fn cleanup_workflow_state(
    cleanup_state: &Arc<Mutex<WorkflowCleanupState>>,
) -> UpdaterResult<Vec<PathBuf>> {
    cleanup_state
        .lock()
        .map_err(|_| UpdaterError::Workflow("workflow cleanup lock poisoned".to_string()))?
        .cleanup()
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
            remove_git_metadata_if_present(target_dir, output)?;
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
        let ranking_dir = environment_ranking_dir(config);
        EnvironmentManager::new(RealProcessRunner, ReqwestDownloader).prepare_with_ranking(
            config,
            Some(&ranking_dir),
            output,
        )
    }

    fn sync_dependencies(
        &self,
        config: &UpdaterConfig,
        output: &(dyn OutputSink + Send + Sync),
    ) -> UpdaterResult<()> {
        let ranking_dir = environment_ranking_dir(config);
        EnvironmentManager::new(RealProcessRunner, ReqwestDownloader)
            .sync_dependencies_with_ranking(config, Some(&ranking_dir), output)
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
    let cleanup_state = new_workflow_cleanup_state();
    let result = run_workflow_with_services_inner(
        options,
        services,
        Arc::clone(&output),
        Arc::clone(&cleanup_state),
    );
    if result.is_err() {
        let _ = cleanup_workflow_state(&cleanup_state);
    }
    result
}

fn run_workflow_with_services_inner(
    options: WorkflowOptions,
    services: Arc<dyn WorkflowServices>,
    output: Arc<dyn OutputSink + Send + Sync>,
    cleanup_state: Arc<Mutex<WorkflowCleanupState>>,
) -> Result<WorkflowReport, WorkflowFailure> {
    let mut manager =
        load_manager(&options).map_err(|error| WorkflowFailure::from_error("config", error))?;
    if let Some(path) = &options.install_path {
        manager.config.paths.baas_root_path = path.to_string_lossy().to_string();
    }
    validate_mirrorc_cdk_before_workflow(&manager.config)
        .map_err(|error| WorkflowFailure::from_error("mirrorc_cdk", error))?;
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
    let ranking_dir = environment_ranking_dir(&config);
    fs::create_dir_all(&ranking_dir)
        .map_err(|error| WorkflowFailure::from_error("prepare_paths", error.into()))?;
    register_cleanup_paths(&cleanup_state, &main_job, &cpp_job)
        .map_err(|error| WorkflowFailure::from_error("cleanup", error))?;

    let main_services = Arc::clone(&services);
    let cpp_services = Arc::clone(&services);
    let main_config = config.clone();
    let cpp_config = config.clone();
    let main_output = Arc::clone(&output);
    let cpp_output = Arc::clone(&output);
    let main_ranking = ranking_dir.join("main.json");
    let cpp_ranking = ranking_dir.join("cpp.json");
    let prepare_services = Arc::clone(&services);
    let prepare_config = config.clone();
    let prepare_output = Arc::clone(&output);

    let (main_result, cpp_result, prepare_result) = thread::scope(|scope| {
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
        let prepare_handle =
            scope.spawn(|| prepare_services.prepare_environment(&prepare_config, &*prepare_output));
        (main_handle.join(), cpp_handle.join(), prepare_handle.join())
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
    prepare_result
        .map_err(|_| {
            WorkflowFailure::from_error(
                "environment",
                UpdaterError::Workflow("environment prepare task panicked".to_string()),
            )
        })?
        .map_err(|error| WorkflowFailure::from_error("environment", error))?;

    finalize_job(&main_job)
        .map_err(|error| WorkflowFailure::from_error("move_main_repo", error))?;
    finalize_job(&cpp_job).map_err(|error| WorkflowFailure::from_error("move_cpp_repo", error))?;

    manager.config.general.current_baas_sha = main_outcome.sha;
    manager.config.general.current_baas_cpp_sha = cpp_outcome.sha;
    manager
        .save()
        .map_err(|error| WorkflowFailure::from_error("config", error))?;
    copy_setup_to_install_root(&manager)
        .map_err(|error| WorkflowFailure::from_error("config", error))?;

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
    let using_mirrorc = !config.general.mirrorc_cdk.trim().is_empty();
    match kind {
        RepositoryKind::Main => {
            if using_mirrorc {
                return RepositoryJob {
                    target_dir: root.clone(),
                    final_dir: root,
                    needs_move: false,
                };
            }
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
            if using_mirrorc || final_dir.join(".git").exists() {
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

fn register_cleanup_paths(
    cleanup_state: &Arc<Mutex<WorkflowCleanupState>>,
    main_job: &RepositoryJob,
    cpp_job: &RepositoryJob,
) -> UpdaterResult<()> {
    let mut cleanup = cleanup_state
        .lock()
        .map_err(|_| UpdaterError::Workflow("workflow cleanup lock poisoned".to_string()))?;
    if main_job.needs_move {
        cleanup.register_path(main_job.target_dir.clone());
    }
    if cpp_job.needs_move {
        cleanup.register_path(cpp_job.target_dir.clone());
    }
    Ok(())
}

fn finalize_job(job: &RepositoryJob) -> UpdaterResult<()> {
    if !job.needs_move {
        return Ok(());
    }
    move_dir_contents(&job.target_dir, &job.final_dir)
}

fn validate_mirrorc_cdk_before_workflow(config: &UpdaterConfig) -> UpdaterResult<()> {
    let cdk = config.general.mirrorc_cdk.trim();
    if cdk.is_empty() {
        return Ok(());
    }
    let latest = MirrorCClient::new(ReqwestMirrorHttp).latest(
        RepositoryKind::Main,
        config.general.channel,
        "",
        cdk,
    )?;
    if latest.is_success() {
        return Ok(());
    }
    let message = if latest.message.trim().is_empty() {
        latest
            .cdk_state()
            .map(|state| format!("MirrorC CDK validation failed: {state:?}"))
            .unwrap_or_else(|| format!("MirrorC CDK validation failed with code {}", latest.code))
    } else {
        latest.message
    };
    Err(UpdaterError::MirrorC(message))
}

fn remove_git_metadata_if_present(
    target_dir: &Path,
    output: &(dyn OutputSink + Send + Sync),
) -> UpdaterResult<()> {
    let git_path = target_dir.join(".git");
    if !git_path.exists() {
        return Ok(());
    }
    output.line(
        OutputStyle::Info,
        &format!(
            "Removing Git metadata from MirrorC-managed directory: {}",
            git_path.display()
        ),
    );
    if git_path.is_dir() {
        fs::remove_dir_all(git_path)?;
    } else {
        fs::remove_file(git_path)?;
    }
    Ok(())
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

fn environment_ranking_dir(config: &UpdaterConfig) -> PathBuf {
    config.source_ranking_dir()
}

#[derive(Default)]
struct TerminalWorkflowState {
    manager: Option<ConfigManager>,
    main_job: Option<RepositoryJob>,
    cpp_job: Option<RepositoryJob>,
    ranking_dir: Option<PathBuf>,
    main_outcome: Option<RepositoryOutcome>,
    cpp_outcome: Option<RepositoryOutcome>,
    cpython_mirror: Option<String>,
    pypi_index: Option<String>,
}

/// Runs the BAAS updater workflow as a `baas-term` task graph.
///
/// This is the integration entry point intended for the Tauri app. It mirrors
/// the orchestration style in `crates/baas-term/src/demo.rs`: configuration and
/// Rust-native work run as thread tasks, while Git CLI and UV commands run as
/// PTY-backed process tasks so their output is captured by the terminal UI.
pub fn run_terminal_workflow_flow(
    inner: Arc<Mutex<TermState>>,
    session_id: String,
    renderer_tx: Sender<RendererEvent>,
    options: WorkflowOptions,
    cleanup_state: Arc<Mutex<WorkflowCleanupState>>,
) {
    let (completion_tx, completion_rx) = mpsc::channel::<TaskCompletion>();
    let state = Arc::new(Mutex::new(TerminalWorkflowState::default()));
    let workflow_plan = terminal_workflow_plan();
    let _ = renderer_tx.send(RendererEvent::WorkflowPlanned(workflow_plan.clone()));

    let config_spec = planned_thread_task(&workflow_plan, "updater-config");
    if spawn_thread_task(
        &inner,
        &session_id,
        config_spec,
        &renderer_tx,
        &completion_tx,
        TerminalConfigArgs {
            options: options.clone(),
            state: Arc::clone(&state),
            cleanup_state: Arc::clone(&cleanup_state),
        },
        terminal_config_task,
    )
    .is_err()
        || !wait_for_task(&completion_rx, "updater-config")
    {
        fail_terminal_session(&inner, &session_id, &renderer_tx, &cleanup_state);
        return;
    }

    if !run_terminal_update_and_prepare_stage(
        &inner,
        &session_id,
        &renderer_tx,
        &workflow_plan,
        Arc::clone(&state),
    ) {
        fail_terminal_session(&inner, &session_id, &renderer_tx, &cleanup_state);
        return;
    }

    let finalize_spec = planned_thread_task(&workflow_plan, "updater-finalize-repos");
    if spawn_thread_task(
        &inner,
        &session_id,
        finalize_spec,
        &renderer_tx,
        &completion_tx,
        Arc::clone(&state),
        terminal_finalize_repos_task,
    )
    .is_err()
        || !wait_for_task(&completion_rx, "updater-finalize-repos")
    {
        fail_terminal_session(&inner, &session_id, &renderer_tx, &cleanup_state);
        return;
    }

    if !run_terminal_dependency_stage(
        &inner,
        &session_id,
        &renderer_tx,
        &completion_tx,
        &completion_rx,
        &workflow_plan,
        Arc::clone(&state),
        options.launch,
    ) {
        fail_terminal_session(&inner, &session_id, &renderer_tx, &cleanup_state);
        return;
    }

    finish_terminal_session(&inner, &session_id, &renderer_tx, true);
}

pub fn terminal_workflow_plan() -> WorkflowPlan {
    WorkflowBuilder::new()
        .thread_task(
            "updater-config",
            "updater-config",
            "Config Migration",
            "Load and migrate setup.toml, then plan repository targets.",
            "load and migrate setup.toml",
        )
        .parallel(vec![
            WorkflowTask::new(
                "main-repository",
                "main-repository",
                "Main Repository",
                "Clone or update the main BAAS repository.",
                "git or MirrorC main repository sync",
            ),
            WorkflowTask::new(
                "cpp-repository",
                "cpp-repository",
                "Cpp Repository",
                "Clone or update the Cpp/OCR prebuild repository.",
                "git or MirrorC cpp repository sync",
            ),
            WorkflowTask::new(
                "uv-install",
                "uv-install",
                "Install UV",
                "Download and extract UV when it is missing.",
                "download and extract uv",
            ),
        ])
        .task_after(
            &["uv-install"],
            WorkflowTask::new(
                "cpython-source-ranking",
                "cpython-source-ranking",
                "CPython Source",
                "Benchmark CPython mirrors when managed Python is missing.",
                "rank cpython sources",
            ),
        )
        .task_after(
            &["main-repository", "cpp-repository"],
            WorkflowTask::new(
                "git-record-sha",
                "git-record-sha",
                "Record Git Versions",
                "Read local repository versions after Git CLI updates.",
                "read local git sha",
            ),
        )
        .task_after(
            &["cpython-source-ranking"],
            WorkflowTask::new(
                "uv-python-install",
                "uv-python-install",
                "Install Python",
                "Install the configured managed Python runtime through UV.",
                "uv python install",
            ),
        )
        .task_after(
            &["uv-python-install"],
            WorkflowTask::new(
                "uv-venv",
                "uv-venv",
                "Create Venv",
                "Create the managed virtual environment.",
                "uv venv",
            ),
        )
        .task_after(
            &["git-record-sha", "uv-venv"],
            WorkflowTask::new(
                "updater-finalize-repos",
                "updater-finalize-repos",
                "Finalize Repositories",
                "Move fresh clones into place and persist versions.",
                "move repositories and persist versions",
            ),
        )
        .thread_task(
            "pypi-source-ranking",
            "pypi-source-ranking",
            "PyPI Source",
            "Benchmark PyPI indexes before dependency sync.",
            "rank pypi sources",
        )
        .process_task(
            "uv-compile",
            "uv-compile",
            "Compile Dependencies",
            "Generate the dependency lock file when requirements changed.",
            "uv pip compile",
        )
        .process_task(
            "uv-sync",
            "uv-sync",
            "Sync Dependencies",
            "If it takes too long time, restart by clicking the red button.",
            "uv pip sync",
        )
        .process_task(
            "uv-cache-clean",
            "uv-cache-clean",
            "Clean UV Cache",
            "Clean UV cache after dependency synchronization.",
            "uv cache clean",
        )
        .process_task(
            "launch-backend",
            "launch-backend",
            "Launch Backend",
            "Start the backend service and wait for it to accept connections.",
            "spawn backend service",
        )
        .build()
}

fn planned_thread_task(plan: &WorkflowPlan, task_id: &str) -> TaskSpec {
    let node = plan.node(task_id).expect("workflow task missing from plan");
    TaskSpec {
        task_id: node.task_id.clone(),
        region_id: node.region_id.clone(),
        step_index: node.step_index,
        step_total: node.step_total,
        name: node.name.clone(),
        command: node.command.clone(),
        program: String::new(),
        args: Vec::new(),
        cwd: ".".to_string(),
        env: Vec::new(),
    }
}

fn planned_process_task(plan: &WorkflowPlan, task_id: &str, script: ScriptCommand) -> TaskSpec {
    let node = plan.node(task_id).expect("workflow task missing from plan");
    TaskSpec {
        task_id: node.task_id.clone(),
        region_id: node.region_id.clone(),
        step_index: node.step_index,
        step_total: node.step_total,
        name: node.name.clone(),
        command: script.display,
        program: script.program,
        args: script.args,
        cwd: script.cwd,
        env: script.env,
    }
}

fn run_terminal_update_and_prepare_stage(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    workflow_plan: &WorkflowPlan,
    state: Arc<Mutex<TerminalWorkflowState>>,
) -> bool {
    let (repo_completion_tx, repo_completion_rx) = mpsc::channel::<TaskCompletion>();
    let (prepare_completion_tx, prepare_completion_rx) = mpsc::channel::<TaskCompletion>();

    thread::scope(|scope| {
        let repo_inner = Arc::clone(inner);
        let repo_renderer_tx = renderer_tx.clone();
        let repo_state = Arc::clone(&state);
        let repo_session_id = session_id.to_string();
        let repo_handle = scope.spawn(move || {
            run_terminal_repo_stage(
                &repo_inner,
                &repo_session_id,
                &repo_renderer_tx,
                &repo_completion_tx,
                &repo_completion_rx,
                workflow_plan,
                repo_state,
            )
        });

        let prepare_inner = Arc::clone(inner);
        let prepare_renderer_tx = renderer_tx.clone();
        let prepare_state = state;
        let prepare_session_id = session_id.to_string();
        let prepare_handle = scope.spawn(move || {
            run_terminal_environment_prepare_stage(
                &prepare_inner,
                &prepare_session_id,
                &prepare_renderer_tx,
                &prepare_completion_tx,
                &prepare_completion_rx,
                workflow_plan,
                prepare_state,
            )
        });

        repo_handle.join().unwrap_or(false) && prepare_handle.join().unwrap_or(false)
    })
}

struct TerminalConfigArgs {
    options: WorkflowOptions,
    state: Arc<Mutex<TerminalWorkflowState>>,
    cleanup_state: Arc<Mutex<WorkflowCleanupState>>,
}

fn terminal_config_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalConfigArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("config task cancelled".to_string());
    }
    output.with_spinner("configuration", "Configuration ready", |spinner| {
        spinner.set_detail("loading setup.toml");
        let mut manager = load_manager(&args.options).map_err(|error| error.message())?;
        if let Some(path) = &args.options.install_path {
            spinner.set_detail("applying selected install path");
            manager.config.paths.baas_root_path = path.to_string_lossy().to_string();
        }
        if !manager.config.general.mirrorc_cdk.trim().is_empty() {
            spinner.set_detail("validating MirrorC CDK");
            validate_mirrorc_cdk_before_workflow(&manager.config)
                .map_err(|error| error.message())?;
        }
        spinner.set_detail("saving migrated configuration");
        manager.save().map_err(|error| error.message())?;
        fs::create_dir_all(manager.config.baas_root()).map_err(|error| error.to_string())?;
        let ranking_dir = environment_ranking_dir(&manager.config);
        fs::create_dir_all(&ranking_dir).map_err(|error| error.to_string())?;

        spinner.set_detail("planning repository targets");
        let main_job = repository_job(&manager.config, RepositoryKind::Main);
        let cpp_job = repository_job(&manager.config, RepositoryKind::Cpp);
        register_cleanup_paths(&args.cleanup_state, &main_job, &cpp_job)
            .map_err(|error| error.message())?;
        let mut state = args
            .state
            .lock()
            .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
        state.manager = Some(manager);
        state.main_job = Some(main_job);
        state.cpp_job = Some(cpp_job);
        state.ranking_dir = Some(ranking_dir);
        Ok(())
    })
}

fn run_terminal_repo_stage(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    completion_rx: &mpsc::Receiver<TaskCompletion>,
    workflow_plan: &WorkflowPlan,
    state: Arc<Mutex<TerminalWorkflowState>>,
) -> bool {
    let (config, main_job, cpp_job, ranking_dir) = match terminal_state_snapshot(&state) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "updater-repo-stage".to_string(),
                region_id: "updater-repo-stage".to_string(),
                tx: renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };

    if !config.general.mirrorc_cdk.is_empty() || !RealGitExecutor.has_cli() {
        return run_terminal_thread_repo_stage(
            inner,
            session_id,
            renderer_tx,
            completion_tx,
            completion_rx,
            workflow_plan,
            state,
        );
    }

    let main_plan = match plan_git_cli_process(
        RepositoryKind::Main,
        &config,
        &main_job.target_dir,
        &ranking_dir.join("main.json"),
    ) {
        Ok(plan) => plan,
        Err(_) => {
            return run_terminal_thread_repo_stage(
                inner,
                session_id,
                renderer_tx,
                completion_tx,
                completion_rx,
                workflow_plan,
                state,
            );
        }
    };
    let cpp_plan = match plan_git_cli_process(
        RepositoryKind::Cpp,
        &config,
        &cpp_job.target_dir,
        &ranking_dir.join("cpp.json"),
    ) {
        Ok(plan) => plan,
        Err(_) => {
            return run_terminal_thread_repo_stage(
                inner,
                session_id,
                renderer_tx,
                completion_tx,
                completion_rx,
                workflow_plan,
                state,
            );
        }
    };

    let main_spec = planned_process_task(
        workflow_plan,
        "main-repository",
        direct_script(&main_plan.command),
    );
    let cpp_spec = planned_process_task(
        workflow_plan,
        "cpp-repository",
        direct_script(&cpp_plan.command),
    );
    let main_id = main_spec.task_id.clone();
    let cpp_id = cpp_spec.task_id.clone();
    let _ = renderer_tx.send(RendererEvent::BufferRegions {
        region_ids: vec![main_spec.region_id.clone(), cpp_spec.region_id.clone()],
    });
    if spawn_process_task(inner, session_id, main_spec, renderer_tx, completion_tx).is_err()
        || spawn_process_task(inner, session_id, cpp_spec, renderer_tx, completion_tx).is_err()
    {
        return false;
    }
    let success = wait_for_completions(completion_rx, vec![main_id, cpp_id]).unwrap_or(false);
    let _ = renderer_tx.send(RendererEvent::FlushRegions {
        region_ids: vec!["main-repository".to_string(), "cpp-repository".to_string()],
    });
    if !success || !session_is_current(inner, session_id) {
        return false;
    }

    let record_spec = planned_thread_task(workflow_plan, "git-record-sha");
    spawn_thread_task(
        inner,
        session_id,
        record_spec,
        renderer_tx,
        completion_tx,
        TerminalGitRecordArgs {
            state,
            main_plan,
            cpp_plan,
        },
        terminal_git_record_task,
    )
    .is_ok()
        && wait_for_task(completion_rx, "git-record-sha")
}

fn run_terminal_thread_repo_stage(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    completion_rx: &mpsc::Receiver<TaskCompletion>,
    workflow_plan: &WorkflowPlan,
    state: Arc<Mutex<TerminalWorkflowState>>,
) -> bool {
    let main = planned_thread_task(workflow_plan, "main-repository");
    let cpp = planned_thread_task(workflow_plan, "cpp-repository");
    let main_id = main.task_id.clone();
    let cpp_id = cpp.task_id.clone();
    let _ = renderer_tx.send(RendererEvent::BufferRegions {
        region_ids: vec![main.region_id.clone(), cpp.region_id.clone()],
    });
    let main_spawn = spawn_thread_task(
        inner,
        session_id,
        main,
        renderer_tx,
        completion_tx,
        TerminalRepoArgs {
            kind: RepositoryKind::Main,
            state: Arc::clone(&state),
        },
        terminal_repo_thread_task,
    );
    let cpp_spawn = spawn_thread_task(
        inner,
        session_id,
        cpp,
        renderer_tx,
        completion_tx,
        TerminalRepoArgs {
            kind: RepositoryKind::Cpp,
            state,
        },
        terminal_repo_thread_task,
    );
    if main_spawn.is_err() || cpp_spawn.is_err() {
        return false;
    }
    let success = wait_for_completions(completion_rx, vec![main_id, cpp_id]).unwrap_or(false);
    let _ = renderer_tx.send(RendererEvent::FlushRegions {
        region_ids: vec!["main-repository".to_string(), "cpp-repository".to_string()],
    });
    success && session_is_current(inner, session_id)
}

struct TerminalRepoArgs {
    kind: RepositoryKind,
    state: Arc<Mutex<TerminalWorkflowState>>,
}

fn terminal_repo_thread_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalRepoArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("repository task cancelled".to_string());
    }
    let (config, job, ranking_path) = {
        let state = args
            .state
            .lock()
            .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
        let manager = state
            .manager
            .as_ref()
            .ok_or_else(|| "configuration not initialized".to_string())?;
        let job = match args.kind {
            RepositoryKind::Main => state.main_job.clone(),
            RepositoryKind::Cpp => state.cpp_job.clone(),
        }
        .ok_or_else(|| "repository job not initialized".to_string())?;
        let ranking_dir = state
            .ranking_dir
            .as_ref()
            .ok_or_else(|| "ranking directory not initialized".to_string())?;
        (
            manager.config.clone(),
            job,
            ranking_dir.join(format!("{}.json", args.kind.as_str())),
        )
    };
    let outcome = output.with_spinner(
        format!("{} repository", args.kind.as_str()),
        format!("{} repository ready", args.kind.as_str()),
        |spinner| {
            spinner.set_detail("choosing MirrorC or Git source");
            RealWorkflowServices
                .update_repository(args.kind, &config, &job.target_dir, &ranking_path, &output)
                .map_err(|error| error.message())
        },
    )?;
    let mut state = args
        .state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    match args.kind {
        RepositoryKind::Main => state.main_outcome = Some(outcome),
        RepositoryKind::Cpp => state.cpp_outcome = Some(outcome),
    }
    Ok(())
}

#[derive(Clone)]
struct GitCliPlan {
    kind: RepositoryKind,
    command: CommandSpec,
    target_dir: PathBuf,
    status: UpdateStatus,
}

fn plan_git_cli_process(
    kind: RepositoryKind,
    config: &UpdaterConfig,
    target_dir: &Path,
    ranking_path: &Path,
) -> UpdaterResult<GitCliPlan> {
    let expected_urls = repository_urls(kind, config.general.channel);
    let ranking = load_or_benchmark_ranking(Some(ranking_path), &expected_urls, &GitSourceProbe)?;
    save_ranking(ranking_path, &ranking)?;
    let source = ranking
        .active_sources()
        .into_iter()
        .next()
        .ok_or_else(|| UpdaterError::Git("no active repository source".to_string()))?;
    let branch = repository_branch(kind)?;
    let is_update = target_dir.join(".git").exists();
    let executor = RealGitExecutor;
    let local_sha = if is_update {
        executor
            .local_sha_cli(target_dir)
            .or_else(|_| executor.local_sha_git2(target_dir))
            .ok()
    } else {
        None
    };
    let remote_sha = if is_update {
        executor.remote_sha(&source.url, &branch).ok()
    } else {
        None
    };
    let (command, status) = if is_update && local_sha.is_some() && local_sha == remote_sha {
        (git_rev_parse_command(target_dir), UpdateStatus::Skipped)
    } else if is_update {
        (
            git_update_command(&source.url, &branch, target_dir),
            UpdateStatus::Updated,
        )
    } else {
        (
            git_clone_command(&source.url, &branch, target_dir),
            UpdateStatus::Installed,
        )
    };
    Ok(GitCliPlan {
        kind,
        command,
        target_dir: target_dir.to_path_buf(),
        status,
    })
}

fn git_clone_command(url: &str, branch: &str, target_dir: &Path) -> CommandSpec {
    CommandSpec::new("git")
        .arg("clone")
        .arg("--depth")
        .arg("1")
        .arg("--branch")
        .arg(branch)
        .arg(url)
        .arg(target_dir.to_string_lossy())
        .env("GIT_TERMINAL_PROMPT", "0")
}

fn git_update_command(url: &str, branch: &str, target_dir: &Path) -> CommandSpec {
    CommandSpec::new("git")
        .arg("-C")
        .arg(target_dir.to_string_lossy())
        .arg("remote")
        .arg("set-url")
        .arg("origin")
        .arg(url)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("BAAS_UPDATER_GIT_UPDATE_BRANCH", branch)
        .env("BAAS_UPDATER_GIT_UPDATE_DIR", target_dir.to_string_lossy())
}

fn git_rev_parse_command(target_dir: &Path) -> CommandSpec {
    CommandSpec::new("git")
        .arg("-C")
        .arg(target_dir.to_string_lossy())
        .arg("rev-parse")
        .arg("HEAD")
        .env("GIT_TERMINAL_PROMPT", "0")
}

struct TerminalGitRecordArgs {
    state: Arc<Mutex<TerminalWorkflowState>>,
    main_plan: GitCliPlan,
    cpp_plan: GitCliPlan,
}

fn terminal_git_record_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalGitRecordArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("git record task cancelled".to_string());
    }
    let executor = RealGitExecutor;
    let main_sha = executor
        .local_sha_cli(&args.main_plan.target_dir)
        .or_else(|_| executor.local_sha_git2(&args.main_plan.target_dir))
        .map_err(|error| error.message())?;
    let cpp_sha = executor
        .local_sha_cli(&args.cpp_plan.target_dir)
        .or_else(|_| executor.local_sha_git2(&args.cpp_plan.target_dir))
        .map_err(|error| error.message())?;
    output.line(OutputStyle::Success, "Git versions captured");
    let mut state = args
        .state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    state.main_outcome = Some(RepositoryOutcome {
        kind: args.main_plan.kind,
        status: args.main_plan.status,
        sha: main_sha,
    });
    state.cpp_outcome = Some(RepositoryOutcome {
        kind: args.cpp_plan.kind,
        status: args.cpp_plan.status,
        sha: cpp_sha,
    });
    Ok(())
}

fn terminal_finalize_repos_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    state: Arc<Mutex<TerminalWorkflowState>>,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("finalize task cancelled".to_string());
    }
    output.with_spinner(
        "repository finalize",
        "Repository state persisted",
        |spinner| {
            let mut state = state
                .lock()
                .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
            let main_job = state
                .main_job
                .clone()
                .ok_or_else(|| "main repository job missing".to_string())?;
            let cpp_job = state
                .cpp_job
                .clone()
                .ok_or_else(|| "cpp repository job missing".to_string())?;
            spinner.set_detail("placing main repository files");
            finalize_job(&main_job).map_err(|error| error.message())?;
            spinner.set_detail("placing Cpp repository files");
            finalize_job(&cpp_job).map_err(|error| error.message())?;
            let main_sha = state
                .main_outcome
                .as_ref()
                .map(|outcome| outcome.sha.clone())
                .ok_or_else(|| "main repository outcome missing".to_string())?;
            let cpp_sha = state
                .cpp_outcome
                .as_ref()
                .map(|outcome| outcome.sha.clone())
                .ok_or_else(|| "cpp repository outcome missing".to_string())?;
            let manager = state
                .manager
                .as_mut()
                .ok_or_else(|| "configuration manager missing".to_string())?;
            spinner.set_detail("saving repository versions");
            manager.config.general.current_baas_sha = main_sha;
            manager.config.general.current_baas_cpp_sha = cpp_sha;
            manager.save().map_err(|error| error.message())?;
            copy_setup_to_install_root(manager).map_err(|error| error.message())?;
            Ok(())
        },
    )
}

fn copy_setup_to_install_root(manager: &ConfigManager) -> UpdaterResult<()> {
    let root = manager.config.baas_root();
    if root.as_os_str().is_empty() {
        return Ok(());
    }

    let install_config = root.join("setup.toml");
    if manager.config_path == install_config {
        return Ok(());
    }

    fs::create_dir_all(&root)?;
    let content = toml::to_string_pretty(&manager.config)?;
    fs::write(install_config, content)?;
    Ok(())
}

fn run_terminal_environment_prepare_stage(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    completion_rx: &mpsc::Receiver<TaskCompletion>,
    workflow_plan: &WorkflowPlan,
    state: Arc<Mutex<TerminalWorkflowState>>,
) -> bool {
    let config = match terminal_config(&state) {
        Ok(config) => config,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "environment".to_string(),
                region_id: "environment".to_string(),
                tx: renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };
    let ranking_dir = match terminal_environment_ranking_dir(&state, &config) {
        Ok(path) => path,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "environment-ranking".to_string(),
                region_id: "environment-ranking".to_string(),
                tx: renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };
    if !uses_managed_runtime(&config) {
        let spec = planned_thread_task(workflow_plan, "uv-install");
        return spawn_thread_task(
            inner,
            session_id,
            spec,
            renderer_tx,
            completion_tx,
            config,
            terminal_custom_runtime_task,
        )
        .is_ok()
            && wait_for_task(completion_rx, "uv-install");
    }

    let uv_spec = planned_thread_task(workflow_plan, "uv-install");
    if spawn_thread_task(
        inner,
        session_id,
        uv_spec,
        renderer_tx,
        completion_tx,
        (config.clone(), ranking_dir.clone()),
        terminal_uv_install_task,
    )
    .is_err()
        || !wait_for_task(completion_rx, "uv-install")
    {
        return false;
    }

    if managed_python_configured(&config) {
        return run_terminal_skip_task(
            inner,
            session_id,
            renderer_tx,
            completion_tx,
            completion_rx,
            workflow_plan,
            "cpython-source-ranking",
            "Python virtual environment exists; skipping CPython source ranking",
        ) && run_terminal_skip_task(
            inner,
            session_id,
            renderer_tx,
            completion_tx,
            completion_rx,
            workflow_plan,
            "uv-python-install",
            "Python virtual environment exists; skipping uv python install",
        ) && run_terminal_skip_task(
            inner,
            session_id,
            renderer_tx,
            completion_tx,
            completion_rx,
            workflow_plan,
            "uv-venv",
            "Python virtual environment exists; skipping uv venv",
        );
    }

    let cpython_rank_spec = planned_thread_task(workflow_plan, "cpython-source-ranking");
    if spawn_thread_task(
        inner,
        session_id,
        cpython_rank_spec,
        renderer_tx,
        completion_tx,
        TerminalCpythonRankArgs {
            state: Arc::clone(&state),
            config: config.clone(),
            ranking_dir: ranking_dir.clone(),
        },
        terminal_cpython_rank_task,
    )
    .is_err()
        || !wait_for_task(completion_rx, "cpython-source-ranking")
    {
        return false;
    }

    let cpython_mirror = match terminal_cpython_source(&state) {
        Ok(source) => source,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "cpython-source-ranking".to_string(),
                region_id: "cpython-source-ranking".to_string(),
                tx: renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };

    if !run_process_and_wait(
        inner,
        session_id,
        planned_process_task(
            workflow_plan,
            "uv-python-install",
            direct_script(&uv_python_install_command_with_mirror(
                &config,
                &cpython_mirror,
            )),
        ),
        renderer_tx,
        completion_tx,
        completion_rx,
    ) {
        return false;
    }

    if !managed_python_configured(&config)
        && !run_process_and_wait(
            inner,
            session_id,
            planned_process_task(
                workflow_plan,
                "uv-venv",
                direct_script(&uv_venv_command(&config)),
            ),
            renderer_tx,
            completion_tx,
            completion_rx,
        )
    {
        return false;
    }

    true
}

fn run_terminal_dependency_stage(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    completion_rx: &mpsc::Receiver<TaskCompletion>,
    workflow_plan: &WorkflowPlan,
    state: Arc<Mutex<TerminalWorkflowState>>,
    launch: bool,
) -> bool {
    let config = match terminal_config(&state) {
        Ok(config) => config,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "dependencies".to_string(),
                region_id: "dependencies".to_string(),
                tx: renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };

    if !uses_managed_runtime(&config) {
        let spec = planned_thread_task(workflow_plan, "uv-sync");
        if spawn_thread_task(
            inner,
            session_id,
            spec,
            renderer_tx,
            completion_tx,
            config.clone(),
            terminal_custom_runtime_task,
        )
        .is_err()
            || !wait_for_task(completion_rx, "uv-sync")
        {
            return false;
        }
        return run_terminal_launch_stage(
            inner,
            session_id,
            renderer_tx,
            completion_tx,
            completion_rx,
            workflow_plan,
            config,
            launch,
        );
    }

    let requirements = match requirements_path(&config) {
        Some(path) => path,
        None => {
            let output = ThreadOutput {
                task_id: "uv-requirements".to_string(),
                region_id: "uv-requirements".to_string(),
                tx: renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, "requirements file not found");
            return false;
        }
    };

    let ranking_dir = match terminal_environment_ranking_dir(&state, &config) {
        Ok(path) => path,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "pypi-source-ranking".to_string(),
                region_id: "pypi-source-ranking".to_string(),
                tx: renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };
    let pypi_rank_spec = planned_thread_task(workflow_plan, "pypi-source-ranking");
    if spawn_thread_task(
        inner,
        session_id,
        pypi_rank_spec,
        renderer_tx,
        completion_tx,
        TerminalPypiRankArgs {
            state: Arc::clone(&state),
            config: config.clone(),
            ranking_dir,
        },
        terminal_pypi_rank_task,
    )
    .is_err()
        || !wait_for_task(completion_rx, "pypi-source-ranking")
    {
        return false;
    }

    let pypi_index = match terminal_pypi_source(&state) {
        Ok(source) => source,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "pypi-source-ranking".to_string(),
                region_id: "pypi-source-ranking".to_string(),
                tx: renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };
    if requirements_compile_cached(&config, &requirements, &pypi_index).unwrap_or(false) {
        for (task_id, message) in [
            ("uv-compile", "requirements unchanged; skipping uv compile"),
            ("uv-sync", "requirements unchanged; skipping uv sync"),
            (
                "uv-cache-clean",
                "requirements unchanged; skipping uv cache clean",
            ),
        ] {
            if !run_terminal_skip_task(
                inner,
                session_id,
                renderer_tx,
                completion_tx,
                completion_rx,
                workflow_plan,
                task_id,
                message,
            ) {
                return false;
            }
        }
    } else if !run_process_and_wait(
        inner,
        session_id,
        planned_process_task(
            workflow_plan,
            "uv-compile",
            direct_script(&uv_compile_command_with_index(
                &config,
                &requirements,
                &pypi_index,
            )),
        ),
        renderer_tx,
        completion_tx,
        completion_rx,
    ) {
        return false;
    } else {
        for (task_id, command) in [
            ("uv-sync", uv_sync_command_with_index(&config, &pypi_index)),
            ("uv-cache-clean", uv_cache_clean_command(&config)),
        ] {
            if !run_process_and_wait(
                inner,
                session_id,
                planned_process_task(workflow_plan, task_id, direct_script(&command)),
                renderer_tx,
                completion_tx,
                completion_rx,
            ) {
                return false;
            }
        }
        if save_requirements_cache(&config, &requirements, &pypi_index).is_err() {
            return false;
        }
    }

    run_terminal_launch_stage(
        inner,
        session_id,
        renderer_tx,
        completion_tx,
        completion_rx,
        workflow_plan,
        config,
        launch,
    )
}

fn run_terminal_skip_task(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    completion_rx: &mpsc::Receiver<TaskCompletion>,
    workflow_plan: &WorkflowPlan,
    task_id: &str,
    message: &str,
) -> bool {
    spawn_thread_task(
        inner,
        session_id,
        planned_thread_task(workflow_plan, task_id),
        renderer_tx,
        completion_tx,
        TerminalSkipArgs {
            message: message.to_string(),
        },
        terminal_skip_task,
    )
    .is_ok()
        && wait_for_task(completion_rx, task_id)
}

struct TerminalSkipArgs {
    message: String,
}

fn terminal_skip_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalSkipArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("skip task cancelled".to_string());
    }
    output.line(OutputStyle::Success, &args.message);
    Ok(())
}

fn run_terminal_launch_stage(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    completion_rx: &mpsc::Receiver<TaskCompletion>,
    workflow_plan: &WorkflowPlan,
    config: UpdaterConfig,
    launch: bool,
) -> bool {
    if !launch || !config.general.launch {
        return true;
    }
    let port = match available_port() {
        Ok(port) => port,
        Err(_) => return false,
    };
    let command = launch_backend_command(&config, port);
    let success = run_process_and_wait(
        inner,
        session_id,
        planned_process_task(
            workflow_plan,
            "launch-backend",
            script_from_command(&command),
        ),
        renderer_tx,
        completion_tx,
        completion_rx,
    );
    if !success {
        return false;
    }
    if wait_for_backend_port_for_session(inner, session_id, port).is_err() {
        return false;
    }
    let _ = renderer_tx.send(RendererEvent::BackendReady {
        base_backend_addr: "127.0.0.1".to_string(),
        base_backend_port: port,
    });
    true
}

fn terminal_uv_install_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    (config, ranking_dir): (UpdaterConfig, PathBuf),
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("uv install task cancelled".to_string());
    }
    if uv_executable(&config).exists() {
        output.line(OutputStyle::Success, "uv is already installed");
        return Ok(());
    }
    let uv_url = ranked_environment_source_with_output(
        EnvironmentSourceKind::Uv,
        &config,
        Some(&ranking_dir),
        &HttpSourceProbe,
        &output,
    )
    .map_err(|error| error.message())?;
    ensure_uv_installed_from(&config, &uv_url, &ReqwestDownloader, &output)
        .map_err(|error| error.message())
}

struct TerminalCpythonRankArgs {
    state: Arc<Mutex<TerminalWorkflowState>>,
    config: UpdaterConfig,
    ranking_dir: PathBuf,
}

fn terminal_cpython_rank_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalCpythonRankArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("cpython source ranking task cancelled".to_string());
    }
    let cpython_mirror = ranked_environment_source_with_output(
        EnvironmentSourceKind::Cpython,
        &args.config,
        Some(&args.ranking_dir),
        &HttpSourceProbe,
        &output,
    )
    .map_err(|error| error.message())?;
    let mut state = args
        .state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    state.cpython_mirror = Some(cpython_mirror);
    output.line(OutputStyle::Success, "CPython source ranked");
    Ok(())
}

struct TerminalPypiRankArgs {
    state: Arc<Mutex<TerminalWorkflowState>>,
    config: UpdaterConfig,
    ranking_dir: PathBuf,
}

fn terminal_pypi_rank_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalPypiRankArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("pypi source ranking task cancelled".to_string());
    }
    let pypi_index = ranked_environment_source_with_output(
        EnvironmentSourceKind::Pypi,
        &args.config,
        Some(&args.ranking_dir),
        &HttpSourceProbe,
        &output,
    )
    .map_err(|error| error.message())?;
    let mut state = args
        .state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    state.pypi_index = Some(pypi_index);
    output.line(OutputStyle::Success, "PyPI source ranked");
    Ok(())
}

fn terminal_custom_runtime_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    config: UpdaterConfig,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("custom runtime task cancelled".to_string());
    }
    output.line(
        OutputStyle::Info,
        &format!("Using custom runtime: {}", config.python.runtime_path),
    );
    Ok(())
}

fn wait_for_backend_port_for_session(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    port: u16,
) -> UpdaterResult<()> {
    let started = std::time::Instant::now();
    let timeout = Duration::from_secs(30);
    while started.elapsed() < timeout {
        if !session_is_current(inner, session_id) {
            return Err(UpdaterError::Cancelled);
        }
        if backend_auth_endpoint_ready(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(300));
    }
    Err(UpdaterError::Workflow(format!(
        "backend auth endpoint did not become ready on 127.0.0.1:{port}"
    )))
}

fn backend_auth_endpoint_ready(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(700));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    if stream
        .write_all(b"GET /auth/remember HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 16];
    stream
        .read(&mut response)
        .map(|read| read > 0 && response.starts_with(b"HTTP/"))
        .unwrap_or(false)
}

fn terminal_state_snapshot(
    state: &Arc<Mutex<TerminalWorkflowState>>,
) -> Result<(UpdaterConfig, RepositoryJob, RepositoryJob, PathBuf), String> {
    let state = state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    let manager = state
        .manager
        .as_ref()
        .ok_or_else(|| "configuration not initialized".to_string())?;
    Ok((
        manager.config.clone(),
        state
            .main_job
            .clone()
            .ok_or_else(|| "main repository job missing".to_string())?,
        state
            .cpp_job
            .clone()
            .ok_or_else(|| "cpp repository job missing".to_string())?,
        state
            .ranking_dir
            .clone()
            .ok_or_else(|| "ranking directory missing".to_string())?,
    ))
}

fn terminal_config(state: &Arc<Mutex<TerminalWorkflowState>>) -> Result<UpdaterConfig, String> {
    let state = state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    state
        .manager
        .as_ref()
        .map(|manager| manager.config.clone())
        .ok_or_else(|| "configuration not initialized".to_string())
}

fn terminal_cpython_source(state: &Arc<Mutex<TerminalWorkflowState>>) -> Result<String, String> {
    let state = state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    state
        .cpython_mirror
        .clone()
        .ok_or_else(|| "CPython mirror not ranked".to_string())
}

fn terminal_pypi_source(state: &Arc<Mutex<TerminalWorkflowState>>) -> Result<String, String> {
    let state = state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    state
        .pypi_index
        .clone()
        .ok_or_else(|| "PyPI index not ranked".to_string())
}

fn terminal_environment_ranking_dir(
    state: &Arc<Mutex<TerminalWorkflowState>>,
    config: &UpdaterConfig,
) -> Result<PathBuf, String> {
    let state = state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    Ok(state
        .ranking_dir
        .clone()
        .unwrap_or_else(|| environment_ranking_dir(config)))
}

fn wait_for_task(completion_rx: &mpsc::Receiver<TaskCompletion>, task_id: &str) -> bool {
    baas_term::common::wait_for_completion(completion_rx, task_id)
        .map(|completion| completion.success)
        .unwrap_or(false)
}

fn finish_terminal_session(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    success: bool,
) {
    if session_is_current(inner, session_id) {
        let _ = renderer_tx.send(RendererEvent::SessionFinished { success });
    }
}

fn fail_terminal_session(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    cleanup_state: &Arc<Mutex<WorkflowCleanupState>>,
) {
    let _ = cleanup_workflow_state(cleanup_state);
    finish_terminal_session(inner, session_id, renderer_tx, false);
}

fn script_from_command(command: &CommandSpec) -> ScriptCommand {
    #[cfg(windows)]
    {
        powershell_script(command)
    }
    #[cfg(not(windows))]
    {
        sh_script(command)
    }
}

fn direct_script(command: &CommandSpec) -> ScriptCommand {
    let program = command.program.to_string_lossy().to_string();
    let display = std::iter::once(program.as_str())
        .chain(command.args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");

    ScriptCommand {
        program: program.to_string(),
        args: command.args.clone(),
        display,
        cwd: command
            .cwd
            .as_ref()
            .map(|cwd| cwd.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string()),
        env: command.env.clone(),
    }
}

#[cfg(windows)]
fn powershell_script(command: &CommandSpec) -> ScriptCommand {
    use std::os::windows::process::CommandExt;

    let shell = if std::process::Command::new("pwsh")
        .creation_flags(0x08000000)
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-Command")
        .arg("$PSVersionTable.PSVersion")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
    {
        "pwsh"
    } else {
        "powershell.exe"
    };
    let mut script = String::new();
    for (key, value) in &command.env {
        script.push_str(&format!(
            "$env:{} = '{}'; ",
            escape_powershell(key),
            escape_powershell(value)
        ));
    }
    if let Some(cwd) = &command.cwd {
        script.push_str(&format!(
            "Set-Location -LiteralPath '{}'; ",
            escape_powershell(&cwd.to_string_lossy())
        ));
    }
    if command.detached {
        script.push_str(&format!(
            "$backendProcess = Start-Process -WindowStyle Hidden -PassThru -FilePath '{}' -ArgumentList @({}); if ($env:BAAS_BACKEND_PID_FILE) {{ $pidDir = Split-Path -Parent $env:BAAS_BACKEND_PID_FILE; if ($pidDir) {{ New-Item -ItemType Directory -Force -Path $pidDir | Out-Null }}; Set-Content -LiteralPath $env:BAAS_BACKEND_PID_FILE -Value $backendProcess.Id -Encoding ASCII }}; exit 0",
            escape_powershell(&command.program.to_string_lossy()),
            command
                .args
                .iter()
                .map(|arg| format!("'{}'", escape_powershell(arg)))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    } else if command.program.to_string_lossy() == "git"
        && command
            .env
            .iter()
            .any(|(key, _)| key == "BAAS_UPDATER_GIT_UPDATE_BRANCH")
    {
        let dir = env_value(command, "BAAS_UPDATER_GIT_UPDATE_DIR").unwrap_or_default();
        let branch = env_value(command, "BAAS_UPDATER_GIT_UPDATE_BRANCH").unwrap_or("master");
        let url = command.args.last().map(String::as_str).unwrap_or_default();
        script.push_str(&format!(
            "& git -C '{}' remote set-url origin '{}'; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}; & git -C '{}' fetch --depth 1 origin '{}'; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}; & git -C '{}' reset --hard FETCH_HEAD; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}; & git -C '{}' reflog expire --expire=now --all; & git -C '{}' gc --prune=now; exit 0",
            escape_powershell(dir),
            escape_powershell(url),
            escape_powershell(dir),
            escape_powershell(branch),
            escape_powershell(dir),
            escape_powershell(dir),
            escape_powershell(dir),
        ));
    } else {
        script.push_str(&format!(
            "& '{}' {}; exit $LASTEXITCODE",
            escape_powershell(&command.program.to_string_lossy()),
            command
                .args
                .iter()
                .map(|arg| format!("'{}'", escape_powershell(arg)))
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }
    ScriptCommand {
        program: shell.to_string(),
        args: vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            script,
        ],
        display: display_command(command),
        cwd: command
            .cwd
            .as_ref()
            .map(|cwd| cwd.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string()),
        env: command.env.clone(),
    }
}

#[cfg(not(windows))]
fn sh_script(command: &CommandSpec) -> ScriptCommand {
    let mut script = String::new();
    for (key, value) in &command.env {
        script.push_str(&format!("{key}={} ", shell_quote(value)));
    }
    if let Some(cwd) = &command.cwd {
        script.push_str(&format!("cd {} && ", shell_quote(&cwd.to_string_lossy())));
    }
    if command.detached {
        script.push_str(&format!(
            "nohup {} {} >/dev/null 2>&1 & backend_pid=$!; if [ -n \"$BAAS_BACKEND_PID_FILE\" ]; then mkdir -p \"$(dirname \"$BAAS_BACKEND_PID_FILE\")\" && printf '%s\\n' \"$backend_pid\" > \"$BAAS_BACKEND_PID_FILE\"; fi",
            shell_quote(&command.program.to_string_lossy()),
            command
                .args
                .iter()
                .map(|arg| shell_quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        ));
    } else if command.program.to_string_lossy() == "git"
        && command
            .env
            .iter()
            .any(|(key, _)| key == "BAAS_UPDATER_GIT_UPDATE_BRANCH")
    {
        let dir = env_value(command, "BAAS_UPDATER_GIT_UPDATE_DIR").unwrap_or_default();
        let branch = env_value(command, "BAAS_UPDATER_GIT_UPDATE_BRANCH").unwrap_or("master");
        let url = command.args.last().map(String::as_str).unwrap_or_default();
        script.push_str(&format!(
            "git -C {} remote set-url origin {} && git -C {} fetch --depth 1 origin {} && git -C {} reset --hard FETCH_HEAD && git -C {} reflog expire --expire=now --all; git -C {} gc --prune=now",
            shell_quote(dir),
            shell_quote(url),
            shell_quote(dir),
            shell_quote(branch),
            shell_quote(dir),
            shell_quote(dir),
            shell_quote(dir),
        ));
    } else {
        script.push_str(&format!(
            "{} {}",
            shell_quote(&command.program.to_string_lossy()),
            command
                .args
                .iter()
                .map(|arg| shell_quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }
    ScriptCommand {
        program: std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
        args: vec!["-lc".to_string(), script],
        display: display_command(command),
        cwd: command
            .cwd
            .as_ref()
            .map(|cwd| cwd.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string()),
        env: command.env,
    }
}

#[cfg(windows)]
fn escape_powershell(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(not(windows))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn env_value<'a>(command: &'a CommandSpec, key: &str) -> Option<&'a str> {
    command
        .env
        .iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value.as_str())
}

fn display_command(command: &CommandSpec) -> String {
    let mut parts = vec![command.program.to_string_lossy().to_string()];
    parts.extend(command.args.iter().cloned());
    parts.join(" ")
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
            fs::create_dir_all(target_dir)?;
            fs::write(target_dir.join(format!("{}.txt", kind.as_str())), "ok")?;
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
            config: &UpdaterConfig,
            _output: &(dyn OutputSink + Send + Sync),
        ) -> UpdaterResult<()> {
            assert!(!config.baas_root().join("main.txt").exists());
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
    fn git_cpp_job_reclones_when_existing_bin_has_no_git_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let install_path = dir.path().join("BAAS");
        let bin_dir = install_path
            .join("core")
            .join("ocr")
            .join("baas_ocr_client")
            .join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::write(bin_dir.join("mirror-file.txt"), "from mirror").unwrap();

        let mut config = UpdaterConfig::default();
        config.paths.baas_root_path = install_path.to_string_lossy().to_string();

        let job = repository_job(&config, RepositoryKind::Cpp);

        assert!(job.needs_move);
        assert_eq!(job.target_dir, install_path.join("tmp").join("cpp-repo"));
        assert_eq!(job.final_dir, bin_dir);
    }

    #[test]
    fn mirrorc_jobs_use_final_dirs_without_requiring_git_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let install_path = dir.path().join("BAAS");
        let mut config = UpdaterConfig::default();
        config.paths.baas_root_path = install_path.to_string_lossy().to_string();
        config.general.mirrorc_cdk = "cdk".to_string();

        let main_job = repository_job(&config, RepositoryKind::Main);
        let cpp_job = repository_job(&config, RepositoryKind::Cpp);

        assert!(!main_job.needs_move);
        assert_eq!(main_job.target_dir, install_path);
        assert!(!cpp_job.needs_move);
        assert_eq!(
            cpp_job.target_dir,
            install_path
                .join("core")
                .join("ocr")
                .join("baas_ocr_client")
                .join("bin")
        );
    }

    #[test]
    fn mirrorc_cleanup_removes_extra_git_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        let git_dir = target.join(".git");
        fs::create_dir_all(&git_dir).unwrap();
        fs::write(git_dir.join("HEAD"), "ref: refs/heads/master").unwrap();

        remove_git_metadata_if_present(&target, &NoopOutput).unwrap();

        assert!(!git_dir.exists());
    }

    #[test]
    fn terminal_workflow_plan_models_parallel_update_and_dependency_order() {
        let plan = terminal_workflow_plan();
        let main = plan.node("main-repository").unwrap();
        let cpp = plan.node("cpp-repository").unwrap();
        let uv = plan.node("uv-install").unwrap();
        let cpython = plan.node("cpython-source-ranking").unwrap();
        let python = plan.node("uv-python-install").unwrap();
        let venv = plan.node("uv-venv").unwrap();
        let git_record = plan.node("git-record-sha").unwrap();
        let finalize = plan.node("updater-finalize-repos").unwrap();
        let compile = plan.node("uv-compile").unwrap();

        assert_eq!(main.stage, cpp.stage);
        assert_eq!(main.stage, uv.stage);
        assert_eq!(cpython.stage, uv.stage + 1);
        assert_eq!(python.stage, cpython.stage + 1);
        assert_eq!(venv.stage, python.stage + 1);
        assert!(git_record.stage > main.stage);
        assert!(finalize.stage > git_record.stage);
        assert!(finalize.stage > venv.stage);
        assert!(compile.stage > finalize.stage);
        assert!(
            plan.edges
                .iter()
                .any(|edge| edge.from == "uv-install" && edge.to == "cpython-source-ranking")
        );
        assert!(
            plan.edges
                .iter()
                .any(|edge| edge.from == "git-record-sha" && edge.to == "updater-finalize-repos")
        );
        assert_eq!(plan.nodes.len() as u8, compile.step_total);
    }

    #[test]
    fn backend_ready_probe_requires_http_response() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 128];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });

        assert!(backend_auth_endpoint_ready(port));
        handle.join().unwrap();
    }

    #[test]
    fn workflow_returns_structured_failure() {
        struct Failing;
        impl WorkflowServices for Failing {
            fn update_repository(
                &self,
                _kind: RepositoryKind,
                _config: &UpdaterConfig,
                target_dir: &Path,
                _ranking_path: &Path,
                _output: &(dyn OutputSink + Send + Sync),
            ) -> UpdaterResult<RepositoryOutcome> {
                fs::create_dir_all(target_dir)?;
                fs::write(target_dir.join("partial.txt"), "partial")?;
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
        let install_path = dir.path().join("BAAS");
        let failure = run_workflow_with_services(
            WorkflowOptions {
                config_path: Some(dir.path().join("setup.toml")),
                install_path: Some(install_path.clone()),
                launch: false,
            },
            Arc::new(Failing),
            Arc::new(NoopOutput),
        )
        .unwrap_err();

        assert_eq!(failure.code, "git");
        assert!(failure.step == "main_repo" || failure.step == "cpp_repo");
        assert!(!install_path.join("tmp").join("main-repo").exists());
        assert!(!install_path.join("tmp").join("cpp-repo").exists());
        assert!(
            install_path
                .join(".baas-updater")
                .join("source-ranking")
                .exists()
        );
    }
}
