//! End-to-end updater workflow orchestration.

use crate::{
    NoopOutput, OutputSink, OutputStyle, RepositoryKind, UpdateStatus, UpdaterError, UpdaterResult,
    WorkflowOptions,
    config::{ConfigManager, UpdaterConfig},
    environ::{
        CommandSpec, EnvironmentManager, EnvironmentSourceKind, HttpSourceProbe, ProcessRunner,
        RealProcessRunner, ReqwestDownloader, ensure_uv_installed_from, launch_backend_command,
        ranked_environment_source_with_output, requirements_path, uses_managed_runtime,
        uv_cache_clean_command, uv_compile_command_with_index,
        uv_python_install_command_with_mirror, uv_sync_command_with_index, uv_venv_command,
        venv_python,
    },
    mirrorc::{MirrorCClient, MirrorUpdateRequest, ReqwestMirrorHttp},
    repo::{
        GitExecutor, GitSourceProbe, RealGitExecutor, RepoManager, RepoSyncOptions,
        load_or_benchmark_ranking, repository_branch, repository_urls, save_ranking,
    },
};
use baas_term::{
    common::{session_is_current, wait_for_completions},
    processor::{ScriptCommand, create_process_task, run_process_and_wait, spawn_process_task},
    threader::{ThreadOutput, create_thread_task, spawn_thread_task},
    types::{RendererEvent, TaskCompletion, TermState},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
        mpsc::Sender,
    },
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
    register_cleanup_paths(&cleanup_state, &main_job, &cpp_job, &ranking_dir)
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

fn register_cleanup_paths(
    cleanup_state: &Arc<Mutex<WorkflowCleanupState>>,
    main_job: &RepositoryJob,
    cpp_job: &RepositoryJob,
    ranking_dir: &Path,
) -> UpdaterResult<()> {
    let mut cleanup = cleanup_state
        .lock()
        .map_err(|_| UpdaterError::Workflow("workflow cleanup lock poisoned".to_string()))?;
    cleanup.register_path(ranking_dir.to_path_buf());
    if main_job.needs_move {
        cleanup.register_path(main_job.target_dir.clone());
    }
    if cpp_job.needs_move {
        cleanup.register_path(cpp_job.target_dir.clone());
    }
    Ok(())
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

fn environment_ranking_dir(config: &UpdaterConfig) -> PathBuf {
    config.tmp_dir().join("source-ranking")
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

    let config_spec = create_thread_task(
        "updater-config",
        "updater-config",
        1,
        "Config Migration",
        "load and migrate setup.toml",
    );
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

    if !run_terminal_update_and_prepare_stage(&inner, &session_id, &renderer_tx, Arc::clone(&state))
    {
        fail_terminal_session(&inner, &session_id, &renderer_tx, &cleanup_state);
        return;
    }

    let finalize_spec = create_thread_task(
        "updater-finalize-repos",
        "updater-finalize-repos",
        3,
        "Finalize Repositories",
        "move repositories and persist versions",
    );
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
        Arc::clone(&state),
        options.launch,
    ) {
        fail_terminal_session(&inner, &session_id, &renderer_tx, &cleanup_state);
        return;
    }

    finish_terminal_session(&inner, &session_id, &renderer_tx, true);
}

fn run_terminal_update_and_prepare_stage(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
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
        spinner.set_detail("saving migrated configuration");
        manager.save().map_err(|error| error.message())?;
        fs::create_dir_all(manager.config.baas_root()).map_err(|error| error.to_string())?;
        let ranking_dir = manager.config.tmp_dir().join("source-ranking");
        fs::create_dir_all(&ranking_dir).map_err(|error| error.to_string())?;

        spinner.set_detail("planning repository targets");
        let main_job = repository_job(&manager.config, RepositoryKind::Main);
        let cpp_job = repository_job(&manager.config, RepositoryKind::Cpp);
        register_cleanup_paths(&args.cleanup_state, &main_job, &cpp_job, &ranking_dir)
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
                state,
            );
        }
    };

    let main_spec = create_process_task(
        "git-main",
        "git-main",
        2,
        "Main Repository Git",
        script_from_command(&main_plan.command),
    );
    let cpp_spec = create_process_task(
        "git-cpp",
        "git-cpp",
        2,
        "Cpp Repository Git",
        script_from_command(&cpp_plan.command),
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
        region_ids: vec!["git-main".to_string(), "git-cpp".to_string()],
    });
    if !success || !session_is_current(inner, session_id) {
        return false;
    }

    let record_spec = create_thread_task(
        "git-record-sha",
        "git-record-sha",
        2,
        "Record Git Versions",
        "read local git sha",
    );
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
    state: Arc<Mutex<TerminalWorkflowState>>,
) -> bool {
    let main = create_thread_task(
        "repo-main-thread",
        "repo-main-thread",
        2,
        "Main Repository",
        "mirrorc or git2 repository sync",
    );
    let cpp = create_thread_task(
        "repo-cpp-thread",
        "repo-cpp-thread",
        2,
        "Cpp Repository",
        "mirrorc or git2 repository sync",
    );
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
        region_ids: vec![
            "repo-main-thread".to_string(),
            "repo-cpp-thread".to_string(),
        ],
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
    let command = if target_dir.join(".git").exists() {
        git_update_command(&source.url, &branch, target_dir)
    } else {
        git_clone_command(&source.url, &branch, target_dir)
    };
    Ok(GitCliPlan {
        kind,
        command,
        target_dir: target_dir.to_path_buf(),
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
        status: UpdateStatus::Updated,
        sha: main_sha,
    });
    state.cpp_outcome = Some(RepositoryOutcome {
        kind: args.cpp_plan.kind,
        status: UpdateStatus::Updated,
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
            Ok(())
        },
    )
}

fn run_terminal_environment_prepare_stage(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    completion_rx: &mpsc::Receiver<TaskCompletion>,
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
        let spec = create_thread_task(
            "custom-runtime",
            "custom-runtime",
            4,
            "Custom Runtime",
            "skip managed uv setup",
        );
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
            && wait_for_task(completion_rx, "custom-runtime");
    }

    let uv_spec = create_thread_task(
        "uv-install",
        "uv-install",
        4,
        "Install UV",
        "download and extract uv",
    );
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

    let env_rank_spec = create_thread_task(
        "environment-source-ranking",
        "environment-source-ranking",
        4,
        "Environment Sources",
        "rank cpython and pypi sources",
    );
    if spawn_thread_task(
        inner,
        session_id,
        env_rank_spec,
        renderer_tx,
        completion_tx,
        TerminalEnvironmentRankArgs {
            state: Arc::clone(&state),
            config: config.clone(),
            ranking_dir: ranking_dir.clone(),
        },
        terminal_environment_rank_task,
    )
    .is_err()
        || !wait_for_task(completion_rx, "environment-source-ranking")
    {
        return false;
    }

    let (cpython_mirror, _) = match terminal_environment_sources(&state) {
        Ok(sources) => sources,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "environment-source-ranking".to_string(),
                region_id: "environment-source-ranking".to_string(),
                tx: renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };

    if !run_process_and_wait(
        inner,
        session_id,
        create_process_task(
            "uv-python-install",
            "uv-python-install",
            4,
            "Install Python",
            script_from_command(&uv_python_install_command_with_mirror(
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

    if !venv_python(&config).exists()
        && !run_process_and_wait(
            inner,
            session_id,
            create_process_task(
                "uv-venv",
                "uv-venv",
                4,
                "Create Venv",
                script_from_command(&uv_venv_command(&config)),
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
        let spec = create_thread_task(
            "custom-runtime-dependencies",
            "custom-runtime-dependencies",
            4,
            "Custom Runtime",
            "skip managed dependency sync",
        );
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
            || !wait_for_task(completion_rx, "custom-runtime-dependencies")
        {
            return false;
        }
        return run_terminal_launch_stage(
            inner,
            session_id,
            renderer_tx,
            completion_tx,
            completion_rx,
            config,
            launch,
        );
    }

    let (_, pypi_index) = match terminal_environment_sources(&state) {
        Ok(sources) => sources,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "environment-source-ranking".to_string(),
                region_id: "environment-source-ranking".to_string(),
                tx: renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };

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
    for (task_id, name, command) in [
        (
            "uv-compile",
            "Compile Dependencies",
            uv_compile_command_with_index(&config, &requirements, &pypi_index),
        ),
        (
            "uv-sync",
            "Sync Dependencies",
            uv_sync_command_with_index(&config, &pypi_index),
        ),
        (
            "uv-cache-clean",
            "Clean UV Cache",
            uv_cache_clean_command(&config),
        ),
    ] {
        if !run_process_and_wait(
            inner,
            session_id,
            create_process_task(task_id, task_id, 4, name, script_from_command(&command)),
            renderer_tx,
            completion_tx,
            completion_rx,
        ) {
            return false;
        }
    }

    run_terminal_launch_stage(
        inner,
        session_id,
        renderer_tx,
        completion_tx,
        completion_rx,
        config,
        launch,
    )
}

fn run_terminal_launch_stage(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    completion_rx: &mpsc::Receiver<TaskCompletion>,
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
    let spec = create_thread_task(
        "launch-backend",
        "launch-backend",
        4,
        "Launch Backend",
        "spawn backend service",
    );
    spawn_thread_task(
        inner,
        session_id,
        spec,
        renderer_tx,
        completion_tx,
        (config, port),
        terminal_launch_task,
    )
    .is_ok()
        && wait_for_task(completion_rx, "launch-backend")
}

fn terminal_uv_install_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    (config, ranking_dir): (UpdaterConfig, PathBuf),
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("uv install task cancelled".to_string());
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

struct TerminalEnvironmentRankArgs {
    state: Arc<Mutex<TerminalWorkflowState>>,
    config: UpdaterConfig,
    ranking_dir: PathBuf,
}

fn terminal_environment_rank_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalEnvironmentRankArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("environment source ranking task cancelled".to_string());
    }
    let cpython_mirror = ranked_environment_source_with_output(
        EnvironmentSourceKind::Cpython,
        &args.config,
        Some(&args.ranking_dir),
        &HttpSourceProbe,
        &output,
    )
    .map_err(|error| error.message())?;
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
    state.cpython_mirror = Some(cpython_mirror);
    state.pypi_index = Some(pypi_index);
    output.line(OutputStyle::Success, "Environment sources ranked");
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

fn terminal_launch_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    (config, port): (UpdaterConfig, u16),
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("launch task cancelled".to_string());
    }
    RealProcessRunner
        .run(&launch_backend_command(&config, port), &output)
        .map_err(|error| error.message())
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

fn terminal_environment_sources(
    state: &Arc<Mutex<TerminalWorkflowState>>,
) -> Result<(String, String), String> {
    let state = state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    Ok((
        state
            .cpython_mirror
            .clone()
            .ok_or_else(|| "CPython mirror not ranked".to_string())?,
        state
            .pypi_index
            .clone()
            .ok_or_else(|| "PyPI index not ranked".to_string())?,
    ))
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

#[cfg(windows)]
fn powershell_script(command: &CommandSpec) -> ScriptCommand {
    let shell = if std::process::Command::new("pwsh")
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
            "Start-Process -WindowStyle Hidden -FilePath '{}' -ArgumentList @({}); exit 0",
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
            "nohup {} {} >/dev/null 2>&1 &",
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
    }
}
