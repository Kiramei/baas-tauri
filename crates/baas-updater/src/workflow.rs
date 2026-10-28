//! End-to-end updater workflow orchestration.

use crate::{
    GitBackend, OutputSink, OutputStyle, RepositoryKind, UpdateStatus, UpdaterError, UpdaterResult,
    WorkflowOptions,
    config::{ConfigManager, UpdaterConfig},
    environ::{
        CommandSpec, EnvironmentManager, EnvironmentSourceKind, HttpSourceProbe, RealProcessRunner,
        ReqwestDownloader, ensure_uv_installed_from, launch_backend_command,
        launch_backend_pipe_command, launch_backend_shm_command, managed_python_configured,
        requirements_compile_cached, requirements_path, save_requirements_cache,
        uses_managed_runtime, uv_compile_command_with_index, uv_executable,
        uv_python_install_command_with_mirror, uv_sync_command_with_index, uv_venv_command,
        validate_backend_shm_support, with_environment_source_failover,
    },
    mirrorc::{MirrorCClient, MirrorUpdateRequest, ReqwestMirrorHttp},
    repo::{
        GitExecutor, GitHttpSourceProbe, GitSourceProbe, GitUpdateGuard, RealGitExecutor,
        RepoManager, RepoSyncOptions,
    },
};
use baas_term::{
    common::{session_is_current, wait_for_completions},
    processor::{ScriptCommand, run_process_and_wait, run_process_commands},
    threader::{
        ThreadOutput, ThreadTaskOutcome, spawn_thread_task, spawn_thread_task_with_outcome,
    },
    types::{RendererEvent, TaskCompletion, TaskSpec, TermState, WorkflowPlan},
    workflow::{WorkflowBuilder, WorkflowTask},
};
#[cfg(test)]
use std::time::Instant;
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
    /// Performs the update repository operation.
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

        let executor = RealGitExecutor;
        let repo = RepoManager::new(executor);
        let options = RepoSyncOptions {
            kind,
            channel: config.general.channel,
            target_dir: target_dir.to_path_buf(),
            ranking_path: Some(ranking_path.to_path_buf()),
            git_backend: config.general.git_backend,
        };
        let result = if config.general.git_backend == GitBackend::Git2
            || (config.general.git_backend == GitBackend::Auto && !executor.has_cli())
        {
            repo.sync(&options, &GitHttpSourceProbe, output)?
        } else {
            repo.sync(&options, &GitSourceProbe, output)?
        };
        Ok(RepositoryOutcome {
            kind,
            status: result.status,
            sha: result.sha,
        })
    }

    /// Handles the prepare environment workflow.
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

    /// Performs the sync dependencies operation.
    fn sync_dependencies(
        &self,
        config: &UpdaterConfig,
        output: &(dyn OutputSink + Send + Sync),
    ) -> UpdaterResult<()> {
        let ranking_dir = environment_ranking_dir(config);
        EnvironmentManager::new(RealProcessRunner, ReqwestDownloader)
            .sync_dependencies_with_ranking(config, Some(&ranking_dir), output)
    }

    /// Handles the launch backend workflow.
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

#[derive(Debug, Clone)]
struct RepositoryJob {
    target_dir: PathBuf,
    final_dir: PathBuf,
    needs_move: bool,
}

/// Returns the load manager result.
fn load_manager(options: &WorkflowOptions) -> UpdaterResult<ConfigManager> {
    if let Some(path) = &options.config_path {
        ConfigManager::load_from(path)
    } else {
        ConfigManager::load_default_path()
    }
}

/// Handles the repository job workflow.
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

/// Handles the skipped repository outcome workflow.
fn skipped_repository_outcome(kind: RepositoryKind, config: &UpdaterConfig) -> RepositoryOutcome {
    let sha = match kind {
        RepositoryKind::Main => config.general.current_baas_sha.clone(),
        RepositoryKind::Cpp => config.general.current_baas_cpp_sha.clone(),
    };
    RepositoryOutcome {
        kind,
        status: UpdateStatus::Skipped,
        sha,
    }
}

/// Performs the register cleanup paths operation.
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

/// Performs the finalize job operation.
fn finalize_job(job: &RepositoryJob) -> UpdaterResult<()> {
    if !job.needs_move {
        return Ok(());
    }
    move_dir_contents(&job.target_dir, &job.final_dir)
}

/// Handles the validate mirrorc cdk before workflow workflow.
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

/// Performs the remove git metadata if present operation.
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

/// Performs the move dir contents operation.
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

/// Performs the copy dir operation.
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

/// Handles the available port workflow.
fn available_port() -> UpdaterResult<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| UpdaterError::Workflow(error.to_string()))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| UpdaterError::Workflow(error.to_string()))
}

/// Handles the environment ranking dir workflow.
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
    dependencies_changed: Option<bool>,
}

struct TerminalStageContext<'a> {
    inner: &'a Arc<Mutex<TermState>>,
    session_id: &'a str,
    renderer_tx: &'a Sender<RendererEvent>,
    completion_tx: &'a Sender<TaskCompletion>,
    completion_rx: &'a mpsc::Receiver<TaskCompletion>,
    workflow_plan: &'a WorkflowPlan,
}

/// Runs environment commands through the same session-owned PTY as Git tasks.
#[derive(Clone)]
struct TerminalProcessContext {
    inner: Arc<Mutex<TermState>>,
    session_id: String,
    renderer_tx: Sender<RendererEvent>,
    workflow_plan: WorkflowPlan,
}

impl TerminalProcessContext {
    fn new(context: &TerminalStageContext<'_>) -> Self {
        Self {
            inner: Arc::clone(context.inner),
            session_id: context.session_id.to_string(),
            renderer_tx: context.renderer_tx.clone(),
            workflow_plan: context.workflow_plan.clone(),
        }
    }

    fn run(
        &self,
        command: &CommandSpec,
        output: &ThreadOutput,
        cancelled: &AtomicBool,
    ) -> UpdaterResult<()> {
        if cancelled.load(Ordering::Relaxed) || !session_is_current(&self.inner, &self.session_id) {
            return Err(UpdaterError::Cancelled);
        }
        let spec = planned_direct_process_task(&self.workflow_plan, &output.task_id, command);
        output.line(OutputStyle::Info, &format!("Running {}", spec.command));
        let result = run_process_commands(&self.inner, &self.session_id, spec, &self.renderer_tx);
        if cancelled.load(Ordering::Relaxed) || !session_is_current(&self.inner, &self.session_id) {
            return Err(UpdaterError::Cancelled);
        }
        result.map_err(UpdaterError::Environment)
    }
}

/// Runs the BAAS updater workflow as a `baas-term` task graph.
///
/// This is the integration entry point intended for the Tauri app. It mirrors
/// the orchestration style in `crates/baas-term`: configuration and
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
    let context = TerminalStageContext {
        inner: &inner,
        session_id: &session_id,
        renderer_tx: &renderer_tx,
        completion_tx: &completion_tx,
        completion_rx: &completion_rx,
        workflow_plan: &workflow_plan,
    };

    let config_spec = planned_thread_task(context.workflow_plan, "updater-config");
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
        &context,
        Arc::clone(&state),
        options.launch,
        options.pipe_name.as_deref(),
        options.shm_name.as_deref(),
    ) {
        fail_terminal_session(&inner, &session_id, &renderer_tx, &cleanup_state);
        return;
    }

    finish_terminal_session(&inner, &session_id, &renderer_tx, true);
}

/// Handles the terminal workflow plan workflow.
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
            "Retain UV Cache",
            "Keep downloaded and built wheels for subsequent dependency updates.",
            "Retain UV cache",
        )
        .serial(vec![
            WorkflowTask::new(
                "launch-backend",
                "launch-backend",
                "Launch Backend",
                "Start the backend service and wait for it to accept connections.",
                "spawn backend service",
            )
            .without_running_region_limit(),
        ])
        .build()
}

/// Handles the planned thread task workflow.
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
        detached: false,
        detached_pid_file: None,
        after: Vec::new(),
        running_region_max_lines: node.running_region_max_lines,
        running_region_unlimited: node.running_region_unlimited,
    }
}

/// Handles the planned process task workflow.
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
        detached: script.detached,
        detached_pid_file: script.detached_pid_file,
        after: Vec::new(),
        running_region_max_lines: node.running_region_max_lines,
        running_region_unlimited: node.running_region_unlimited,
    }
}

/// Handles the planned direct process task workflow.
fn planned_direct_process_task(
    plan: &WorkflowPlan,
    task_id: &str,
    command: &CommandSpec,
) -> TaskSpec {
    planned_command_process_task(plan, task_id, command, direct_script)
}

/// Handles the planned command process task workflow.
fn planned_command_process_task(
    plan: &WorkflowPlan,
    task_id: &str,
    command: &CommandSpec,
    build_script: fn(&CommandSpec) -> ScriptCommand,
) -> TaskSpec {
    let mut scripts = command
        .command_sequence()
        .into_iter()
        .map(|command| build_script(&command));
    let first = scripts.next().unwrap_or_else(|| build_script(command));
    let mut spec = planned_process_task(plan, task_id, first);
    for script in scripts {
        spec = spec.after(script);
    }
    spec
}

/// Performs the run terminal update and prepare stage operation.
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
            let context = TerminalStageContext {
                inner: &repo_inner,
                session_id: &repo_session_id,
                renderer_tx: &repo_renderer_tx,
                completion_tx: &repo_completion_tx,
                completion_rx: &repo_completion_rx,
                workflow_plan,
            };
            run_terminal_repo_stage(&context, repo_state)
        });

        let prepare_inner = Arc::clone(inner);
        let prepare_renderer_tx = renderer_tx.clone();
        let prepare_state = state;
        let prepare_session_id = session_id.to_string();
        let prepare_handle = scope.spawn(move || {
            let context = TerminalStageContext {
                inner: &prepare_inner,
                session_id: &prepare_session_id,
                renderer_tx: &prepare_renderer_tx,
                completion_tx: &prepare_completion_tx,
                completion_rx: &prepare_completion_rx,
                workflow_plan,
            };
            run_terminal_environment_prepare_stage(&context, prepare_state)
        });

        repo_handle.join().unwrap_or(false) && prepare_handle.join().unwrap_or(false)
    })
}

struct TerminalConfigArgs {
    options: WorkflowOptions,
    state: Arc<Mutex<TerminalWorkflowState>>,
    cleanup_state: Arc<Mutex<WorkflowCleanupState>>,
}

/// Handles the terminal config task workflow.
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
        if !manager.config.general.no_update
            && !manager.config.general.mirrorc_cdk.trim().is_empty()
        {
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

/// Performs the run terminal repo stage operation.
fn run_terminal_repo_stage(
    context: &TerminalStageContext<'_>,
    state: Arc<Mutex<TerminalWorkflowState>>,
) -> bool {
    // All Git backends use RepoManager, including PTY CLI operations. Keeping a
    // second direct fetch/reset planner would bypass mirror validation/failover.
    run_terminal_thread_repo_stage(context, state, None)
}

/// Performs the run terminal thread repo stage operation.
fn run_terminal_thread_repo_stage(
    context: &TerminalStageContext<'_>,
    state: Arc<Mutex<TerminalWorkflowState>>,
    git_backend_override: Option<GitBackend>,
) -> bool {
    let main = planned_thread_task(context.workflow_plan, "main-repository");
    let cpp = planned_thread_task(context.workflow_plan, "cpp-repository");
    let main_id = main.task_id.clone();
    let cpp_id = cpp.task_id.clone();
    let main_spawn = spawn_thread_task_with_outcome(
        context.inner,
        context.session_id,
        main,
        context.renderer_tx,
        context.completion_tx,
        TerminalRepoArgs {
            kind: RepositoryKind::Main,
            state: Arc::clone(&state),
            git_backend_override,
            inner: Arc::clone(context.inner),
            session_id: context.session_id.to_string(),
            renderer_tx: context.renderer_tx.clone(),
            workflow_plan: context.workflow_plan.clone(),
        },
        terminal_repo_thread_task,
    );
    let cpp_spawn = spawn_thread_task_with_outcome(
        context.inner,
        context.session_id,
        cpp,
        context.renderer_tx,
        context.completion_tx,
        TerminalRepoArgs {
            kind: RepositoryKind::Cpp,
            state,
            git_backend_override,
            inner: Arc::clone(context.inner),
            session_id: context.session_id.to_string(),
            renderer_tx: context.renderer_tx.clone(),
            workflow_plan: context.workflow_plan.clone(),
        },
        terminal_repo_thread_task,
    );
    if main_spawn.is_err() || cpp_spawn.is_err() {
        return false;
    }
    let success =
        wait_for_completions(context.completion_rx, vec![main_id, cpp_id]).unwrap_or(false);
    let _ = context.renderer_tx.send(RendererEvent::FlushRegions {
        region_ids: vec!["main-repository".to_string(), "cpp-repository".to_string()],
    });
    success && session_is_current(context.inner, context.session_id)
}

struct TerminalRepoArgs {
    kind: RepositoryKind,
    state: Arc<Mutex<TerminalWorkflowState>>,
    git_backend_override: Option<GitBackend>,
    inner: Arc<Mutex<TermState>>,
    session_id: String,
    renderer_tx: mpsc::Sender<RendererEvent>,
    workflow_plan: WorkflowPlan,
}

struct TerminalGitExecutor<'a> {
    args: &'a TerminalRepoArgs,
    output: &'a ThreadOutput,
    cancelled: &'a AtomicBool,
}

impl TerminalGitExecutor<'_> {
    fn run(&self, command: &CommandSpec) -> UpdaterResult<()> {
        self.check_cancelled()?;
        let spec =
            planned_direct_process_task(&self.args.workflow_plan, &self.output.task_id, command);
        let result = run_process_commands(
            &self.args.inner,
            &self.args.session_id,
            spec,
            &self.args.renderer_tx,
        );
        self.check_cancelled()?;
        result.map_err(UpdaterError::Git)
    }
}

impl GitExecutor for TerminalGitExecutor<'_> {
    fn record_delivery(&self, url: &str, branch: &str, target: &Path) -> UpdaterResult<()> {
        self.check_cancelled()?;
        RealGitExecutor.record_delivery(url, branch, target)
    }
    fn check_cancelled(&self) -> UpdaterResult<()> {
        if self.cancelled.load(Ordering::Relaxed)
            || !session_is_current(&self.args.inner, &self.args.session_id)
        {
            Err(UpdaterError::Cancelled)
        } else {
            Ok(())
        }
    }
    fn has_cli(&self) -> bool {
        RealGitExecutor.has_cli()
    }
    fn clone_cli(&self, url: &str, branch: &str, target: &Path) -> UpdaterResult<()> {
        self.run(&git_clone_command(url, branch, target))
    }
    fn update_cli(&self, url: &str, branch: &str, target: &Path) -> UpdaterResult<()> {
        let guard = GitUpdateGuard::capture(url, branch, target)?;
        self.run(&git_fetch_command(url, branch, target, "1"))?;
        if guard.validated_target(target)?.is_none() {
            self.run(&git_fetch_command(url, branch, target, "64"))?;
        }
        let verified = guard.require_target(target)?;
        self.run(&git_reset_command(target, &verified.to_string()))?;
        guard.record_success(target)
    }
    fn local_sha_cli(&self, target: &Path) -> UpdaterResult<String> {
        RealGitExecutor.local_sha_cli(target)
    }
    fn remote_sha(&self, url: &str, branch: &str) -> UpdaterResult<String> {
        RealGitExecutor.remote_sha(url, branch)
    }
    fn clone_git2(
        &self,
        url: &str,
        branch: &str,
        target: &Path,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<()> {
        RealGitExecutor.clone_git2(url, branch, target, output)
    }
    fn update_git2(
        &self,
        url: &str,
        branch: &str,
        target: &Path,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<()> {
        RealGitExecutor.update_git2(url, branch, target, output)
    }
    fn local_sha_git2(&self, target: &Path) -> UpdaterResult<String> {
        RealGitExecutor.local_sha_git2(target)
    }
}

/// Handles the terminal repo thread task workflow.
fn terminal_repo_thread_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalRepoArgs,
) -> Result<ThreadTaskOutcome, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("repository task cancelled".to_string());
    }
    let (mut config, job, ranking_path) = {
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
    if let Some(git_backend) = args.git_backend_override {
        config.general.git_backend = git_backend;
        output.line(
            OutputStyle::Warning,
            &format!(
                "Retrying {} repository with {}",
                args.kind.as_str(),
                git_backend.as_str()
            ),
        );
    }
    let skipped = config.general.no_update;
    let outcome = if skipped {
        output.line(
            OutputStyle::Muted,
            &format!(
                "{} repository: no_update enabled; skipping repository sync",
                args.kind.as_str()
            ),
        );
        skipped_repository_outcome(args.kind, &config)
    } else {
        output.line(
            OutputStyle::Info,
            &format!(
                "{} repository: choosing MirrorC or Git source",
                args.kind.as_str()
            ),
        );
        let outcome = if config.general.mirrorc_cdk.is_empty()
            && config.general.git_backend != GitBackend::Git2
            && RealGitExecutor.has_cli()
        {
            let executor = TerminalGitExecutor {
                args: &args,
                output: &output,
                cancelled: &cancelled,
            };
            let result = RepoManager::new(executor)
                .sync(
                    &RepoSyncOptions {
                        kind: args.kind,
                        channel: config.general.channel,
                        target_dir: job.target_dir.clone(),
                        ranking_path: Some(ranking_path.clone()),
                        git_backend: config.general.git_backend,
                    },
                    &GitSourceProbe,
                    &output,
                )
                .map_err(|error| error.message())?;
            RepositoryOutcome {
                kind: args.kind,
                status: result.status,
                sha: result.sha,
            }
        } else {
            RealWorkflowServices
                .update_repository(args.kind, &config, &job.target_dir, &ranking_path, &output)
                .map_err(|error| error.message())?
        };
        output.line(
            OutputStyle::Success,
            &format!("{} repository ready", args.kind.as_str()),
        );
        outcome
    };
    let mut state = args
        .state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    match args.kind {
        RepositoryKind::Main => state.main_outcome = Some(outcome),
        RepositoryKind::Cpp => state.cpp_outcome = Some(outcome),
    }
    Ok(if skipped {
        ThreadTaskOutcome::Skipped
    } else {
        ThreadTaskOutcome::Success
    })
}

/// Handles the git clone command workflow.
fn git_clone_command(url: &str, branch: &str, target_dir: &Path) -> CommandSpec {
    git_cli_command()
        .arg("clone")
        .arg("--depth")
        .arg("1")
        .arg("--branch")
        .arg(branch)
        .arg(url)
        .arg(target_dir.to_string_lossy())
}

/// Keep fetching separate from reset so the installed version can be verified.
fn git_fetch_command(url: &str, branch: &str, target_dir: &Path, depth: &str) -> CommandSpec {
    git_cli_command()
        .arg("-C")
        .arg(target_dir.to_string_lossy())
        .arg("remote")
        .arg("set-url")
        .arg("origin")
        .arg(url)
        .after(
            git_cli_command()
                .arg("-C")
                .arg(target_dir.to_string_lossy())
                .arg("fetch")
                .arg("--depth")
                .arg(depth)
                .arg("origin")
                .arg(branch),
        )
}

fn git_reset_command(target_dir: &Path, verified_sha: &str) -> CommandSpec {
    git_cli_command()
        .arg("-C")
        .arg(target_dir.to_string_lossy())
        .arg("reset")
        .arg("--hard")
        .arg(verified_sha)
}

/// Handles the git cli command workflow.
fn git_cli_command() -> CommandSpec {
    CommandSpec::new("git")
        .arg("-c")
        .arg("credential.helper=")
        .arg("-c")
        .arg("credential.interactive=never")
        .arg("-c")
        .arg("core.askPass=echo")
        .arg("-c")
        .arg("core.sshCommand=ssh -o BatchMode=yes")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GCM_MODAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo")
        .env("SSH_ASKPASS", "echo")
}

/// Handles the terminal finalize repos task workflow.
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
            if !manager.config.general.no_update {
                spinner.set_detail("placing main repository files");
                finalize_job(&main_job).map_err(|error| error.message())?;
                spinner.set_detail("placing Cpp repository files");
                finalize_job(&cpp_job).map_err(|error| error.message())?;
            } else {
                spinner.set_detail("no_update enabled; keeping existing repository files");
            }
            spinner.set_detail("saving repository versions");
            if !manager.config.general.no_update {
                manager.config.general.current_baas_sha = main_sha;
                manager.config.general.current_baas_cpp_sha = cpp_sha;
            }
            manager.save().map_err(|error| error.message())?;
            copy_setup_to_install_root(manager).map_err(|error| error.message())?;
            Ok(())
        },
    )
}

/// Performs the copy setup to install root operation.
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

/// Performs the run terminal environment prepare stage operation.
fn run_terminal_environment_prepare_stage(
    context: &TerminalStageContext<'_>,
    state: Arc<Mutex<TerminalWorkflowState>>,
) -> bool {
    let config = match terminal_config(&state) {
        Ok(config) => config,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "environment".to_string(),
                region_id: "environment".to_string(),
                tx: context.renderer_tx.clone(),
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
                tx: context.renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };
    if !uses_managed_runtime(&config) {
        for (task_id, message) in [
            (
                "uv-install",
                "Custom Python runtime configured; skipping UV install",
            ),
            (
                "cpython-source-ranking",
                "Custom Python runtime configured; skipping CPython source ranking",
            ),
            (
                "uv-python-install",
                "Custom Python runtime configured; skipping managed Python install",
            ),
            (
                "uv-venv",
                "Custom Python runtime configured; skipping managed virtual environment",
            ),
        ] {
            if !run_terminal_skip_task(context, task_id, message) {
                return false;
            }
        }
        return true;
    }

    let uv_spec = planned_thread_task(context.workflow_plan, "uv-install");
    if spawn_thread_task_with_outcome(
        context.inner,
        context.session_id,
        uv_spec,
        context.renderer_tx,
        context.completion_tx,
        (config.clone(), ranking_dir.clone()),
        terminal_uv_install_task,
    )
    .is_err()
        || !wait_for_task(context.completion_rx, "uv-install")
    {
        return false;
    }

    if managed_python_configured(&config) {
        return run_terminal_skip_task(
            context,
            "cpython-source-ranking",
            "Python virtual environment exists; skipping CPython source ranking",
        ) && run_terminal_skip_task(
            context,
            "uv-python-install",
            "Python virtual environment exists; skipping uv python install",
        ) && run_terminal_skip_task(
            context,
            "uv-venv",
            "Python virtual environment exists; skipping uv venv",
        );
    }

    let cpython_rank_spec = planned_thread_task(context.workflow_plan, "cpython-source-ranking");
    if spawn_thread_task(
        context.inner,
        context.session_id,
        cpython_rank_spec,
        context.renderer_tx,
        context.completion_tx,
        TerminalCpythonRankArgs {
            state: Arc::clone(&state),
            config: config.clone(),
            ranking_dir: ranking_dir.clone(),
            process: TerminalProcessContext::new(context),
        },
        terminal_cpython_rank_task,
    )
    .is_err()
        || !wait_for_task(context.completion_rx, "cpython-source-ranking")
    {
        return false;
    }

    let cpython_mirror = match terminal_cpython_source(&state) {
        Ok(source) => source,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "cpython-source-ranking".to_string(),
                region_id: "cpython-source-ranking".to_string(),
                tx: context.renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };

    if !run_terminal_skip_task(
        context,
        "uv-python-install",
        &format!("Python installed from {cpython_mirror}"),
    ) {
        return false;
    }

    if !managed_python_configured(&config)
        && !run_process_and_wait(
            context.inner,
            context.session_id,
            planned_direct_process_task(
                context.workflow_plan,
                "uv-venv",
                &uv_venv_command(&config),
            ),
            context.renderer_tx,
            context.completion_tx,
            context.completion_rx,
        )
    {
        return false;
    }

    true
}

/// Performs the run terminal dependency stage operation.
fn run_terminal_dependency_stage(
    context: &TerminalStageContext<'_>,
    state: Arc<Mutex<TerminalWorkflowState>>,
    launch: bool,
    pipe_name: Option<&str>,
    shm_name: Option<&str>,
) -> bool {
    let config = match terminal_config(&state) {
        Ok(config) => config,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "dependencies".to_string(),
                region_id: "dependencies".to_string(),
                tx: context.renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };

    if !uses_managed_runtime(&config) {
        for (task_id, message) in [
            (
                "pypi-source-ranking",
                "Custom Python runtime configured; skipping PyPI source ranking",
            ),
            (
                "uv-compile",
                "Custom Python runtime configured; skipping dependency compilation",
            ),
            (
                "uv-sync",
                "Custom Python runtime configured; skipping dependency synchronization",
            ),
            (
                "uv-cache-clean",
                "Custom Python runtime configured; skipping UV cache cleanup",
            ),
        ] {
            if !run_terminal_skip_task(context, task_id, message) {
                return false;
            }
        }
        return run_terminal_launch_stage(context, config, launch, pipe_name, shm_name);
    }

    let requirements = match requirements_path(&config) {
        Some(path) => path,
        None => {
            let output = ThreadOutput {
                task_id: "uv-requirements".to_string(),
                region_id: "uv-requirements".to_string(),
                tx: context.renderer_tx.clone(),
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
                tx: context.renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };
    let pypi_rank_spec = planned_thread_task(context.workflow_plan, "pypi-source-ranking");
    if spawn_thread_task(
        context.inner,
        context.session_id,
        pypi_rank_spec,
        context.renderer_tx,
        context.completion_tx,
        TerminalPypiRankArgs {
            state: Arc::clone(&state),
            config: config.clone(),
            ranking_dir,
            process: TerminalProcessContext::new(context),
        },
        terminal_pypi_rank_task,
    )
    .is_err()
        || !wait_for_task(context.completion_rx, "pypi-source-ranking")
    {
        return false;
    }

    let pypi_index = match terminal_pypi_source(&state) {
        Ok(source) => source,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "pypi-source-ranking".to_string(),
                region_id: "pypi-source-ranking".to_string(),
                tx: context.renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };
    let dependencies_changed = state
        .lock()
        .ok()
        .and_then(|state| state.dependencies_changed)
        .unwrap_or(false);
    for (task_id, message) in [
        (
            "uv-compile",
            "uv compile completed during PyPI source failover",
        ),
        ("uv-sync", "uv sync completed during PyPI source failover"),
    ] {
        if !run_terminal_skip_task(context, task_id, message) {
            return false;
        }
    }
    if dependencies_changed && save_requirements_cache(&config, &requirements, &pypi_index).is_err()
    {
        return false;
    }
    if !run_terminal_skip_task(
        context,
        "uv-cache-clean",
        "Retaining UV cache for subsequent dependency updates",
    ) {
        return false;
    }

    run_terminal_launch_stage(context, config, launch, pipe_name, shm_name)
}

/// Performs the run terminal skip task operation.
fn run_terminal_skip_task(
    context: &TerminalStageContext<'_>,
    task_id: &str,
    message: &str,
) -> bool {
    spawn_thread_task_with_outcome(
        context.inner,
        context.session_id,
        planned_thread_task(context.workflow_plan, task_id),
        context.renderer_tx,
        context.completion_tx,
        TerminalSkipArgs {
            message: message.to_string(),
        },
        terminal_skip_task,
    )
    .is_ok()
        && wait_for_task(context.completion_rx, task_id)
}

struct TerminalSkipArgs {
    message: String,
}

/// Handles the terminal skip task workflow.
fn terminal_skip_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalSkipArgs,
) -> Result<ThreadTaskOutcome, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("skip task cancelled".to_string());
    }
    output.line(OutputStyle::Muted, &args.message);
    Ok(ThreadTaskOutcome::Skipped)
}

/// Performs the run terminal launch stage operation.
fn run_terminal_launch_stage(
    context: &TerminalStageContext<'_>,
    config: UpdaterConfig,
    launch: bool,
    pipe_name: Option<&str>,
    shm_name: Option<&str>,
) -> bool {
    if !launch || !config.general.launch {
        return run_terminal_skip_task(
            context,
            "launch-backend",
            "Backend launch disabled; skipping backend launch",
        );
    }
    if shm_name.is_some()
        && let Err(error) = validate_backend_shm_support(&config)
    {
        // Report a failed launch task immediately instead of leaving the
        // frontend on the connection screen until its port timeout expires.
        if spawn_thread_task(
            context.inner,
            context.session_id,
            planned_thread_task(context.workflow_plan, "launch-backend"),
            context.renderer_tx,
            context.completion_tx,
            error.message(),
            |_output, _cancel, message| Err(message),
        )
        .is_ok()
        {
            let _ = wait_for_task(context.completion_rx, "launch-backend");
        }
        return false;
    }
    let port = match available_port() {
        Ok(port) => port,
        Err(_) => return false,
    };
    let command = match (shm_name, pipe_name) {
        (Some(name), _) => launch_backend_shm_command(&config, port, name),
        (None, Some(name)) => launch_backend_pipe_command(&config, port, name),
        (None, None) => launch_backend_command(&config, port),
    };
    let success = run_process_and_wait(
        context.inner,
        context.session_id,
        planned_direct_process_task(context.workflow_plan, "launch-backend", &command),
        context.renderer_tx,
        context.completion_tx,
        context.completion_rx,
    );
    if !success {
        return false;
    }
    if wait_for_backend_port_for_session(context.inner, context.session_id, port).is_err() {
        return false;
    }
    let _ = context.renderer_tx.send(RendererEvent::BackendReady {
        base_backend_addr: "127.0.0.1".to_string(),
        base_backend_port: port,
    });
    true
}

/// Handles the terminal uv install task workflow.
fn terminal_uv_install_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    (config, ranking_dir): (UpdaterConfig, PathBuf),
) -> Result<ThreadTaskOutcome, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("uv install task cancelled".to_string());
    }
    if uv_executable(&config).exists() {
        output.line(
            OutputStyle::Muted,
            "uv is already installed; skipping UV install",
        );
        return Ok(ThreadTaskOutcome::Skipped);
    }
    with_environment_source_failover(
        EnvironmentSourceKind::Uv,
        &config,
        Some(&ranking_dir),
        &HttpSourceProbe,
        &output,
        |url| ensure_uv_installed_from(&config, url, &ReqwestDownloader, &output),
    )
    .map(|_| ThreadTaskOutcome::Success)
    .map_err(|error| error.message())
}

struct TerminalCpythonRankArgs {
    state: Arc<Mutex<TerminalWorkflowState>>,
    config: UpdaterConfig,
    ranking_dir: PathBuf,
    process: TerminalProcessContext,
}

/// Handles the terminal cpython rank task workflow.
fn terminal_cpython_rank_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalCpythonRankArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("cpython source ranking task cancelled".to_string());
    }
    let (cpython_mirror, ()) = with_environment_source_failover(
        EnvironmentSourceKind::Cpython,
        &args.config,
        Some(&args.ranking_dir),
        &HttpSourceProbe,
        &output,
        |url| {
            args.process.run(
                &uv_python_install_command_with_mirror(&args.config, url),
                &output,
                &cancelled,
            )
        },
    )
    .map_err(|error| error.message())?;
    let mut state = args
        .state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    state.cpython_mirror = Some(cpython_mirror);
    output.line(
        OutputStyle::Success,
        "CPython installed from selected source",
    );
    Ok(())
}

struct TerminalPypiRankArgs {
    state: Arc<Mutex<TerminalWorkflowState>>,
    config: UpdaterConfig,
    ranking_dir: PathBuf,
    process: TerminalProcessContext,
}

/// Handles the terminal pypi rank task workflow.
fn terminal_pypi_rank_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalPypiRankArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("pypi source ranking task cancelled".to_string());
    }
    let requirements =
        requirements_path(&args.config).ok_or_else(|| "requirements file not found".to_string())?;
    let (pypi_index, dependencies_changed) = with_environment_source_failover(
        EnvironmentSourceKind::Pypi,
        &args.config,
        Some(&args.ranking_dir),
        &HttpSourceProbe,
        &output,
        |url| {
            if requirements_compile_cached(&args.config, &requirements, url)? {
                return Ok(false);
            }
            args.process.run(
                &uv_compile_command_with_index(&args.config, &requirements, url),
                &output,
                &cancelled,
            )?;
            args.process.run(
                &uv_sync_command_with_index(&args.config, url),
                &output,
                &cancelled,
            )?;
            Ok(true)
        },
    )
    .map_err(|error| error.message())?;
    let mut state = args
        .state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    state.pypi_index = Some(pypi_index);
    state.dependencies_changed = Some(dependencies_changed);
    output.line(
        OutputStyle::Success,
        if dependencies_changed {
            "Dependencies synchronized from selected PyPI source"
        } else {
            "Requirements unchanged for persisted PyPI source"
        },
    );
    Ok(())
}

/// Performs the wait for backend port for session operation.
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
        thread::sleep(Duration::from_millis(20));
    }
    Err(UpdaterError::Workflow(format!(
        "backend auth endpoint did not become ready on 127.0.0.1:{port}"
    )))
}

/// Handles the backend auth endpoint ready workflow.
fn backend_auth_endpoint_ready(port: u16) -> bool {
    // A refused loopback connect can otherwise stall for ~1 second on Windows.
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(20)) else {
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

/// Handles the terminal config workflow.
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

/// Handles the terminal cpython source workflow.
fn terminal_cpython_source(state: &Arc<Mutex<TerminalWorkflowState>>) -> Result<String, String> {
    let state = state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    state
        .cpython_mirror
        .clone()
        .ok_or_else(|| "CPython mirror not ranked".to_string())
}

/// Handles the terminal pypi source workflow.
fn terminal_pypi_source(state: &Arc<Mutex<TerminalWorkflowState>>) -> Result<String, String> {
    let state = state
        .lock()
        .map_err(|_| "terminal workflow state lock poisoned".to_string())?;
    state
        .pypi_index
        .clone()
        .ok_or_else(|| "PyPI index not ranked".to_string())
}

/// Handles the terminal environment ranking dir workflow.
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

/// Performs the wait for task operation.
fn wait_for_task(completion_rx: &mpsc::Receiver<TaskCompletion>, task_id: &str) -> bool {
    baas_term::common::wait_for_completion(completion_rx, task_id)
        .map(|completion| completion.success)
        .unwrap_or(false)
}

/// Handles the finish terminal session workflow.
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

/// Handles the fail terminal session workflow.
fn fail_terminal_session(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    cleanup_state: &Arc<Mutex<WorkflowCleanupState>>,
) {
    let _ = cleanup_workflow_state(cleanup_state);
    finish_terminal_session(inner, session_id, renderer_tx, false);
}

/// Handles the direct script workflow.
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
        detached: command.detached,
        detached_pid_file: command
            .detached_pid_file
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NoopOutput;
    use baas_term::types::TaskHandle;

    fn terminal_process_fixture() -> (
        TerminalProcessContext,
        ThreadOutput,
        Arc<AtomicBool>,
        mpsc::Receiver<RendererEvent>,
    ) {
        let (tx, rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut state = TermState {
            current_session_id: Some("uv-test".to_string()),
            rows: 32,
            cols: 120,
            ..TermState::default()
        };
        state.tasks.insert(
            "pypi-source-ranking".to_string(),
            Arc::new(TaskHandle::Thread {
                cancel: Arc::clone(&cancelled),
            }),
        );
        let context = TerminalProcessContext {
            inner: Arc::new(Mutex::new(state)),
            session_id: "uv-test".to_string(),
            renderer_tx: tx.clone(),
            workflow_plan: terminal_workflow_plan(),
        };
        let output = ThreadOutput {
            task_id: "pypi-source-ranking".to_string(),
            region_id: "pypi-source-ranking".to_string(),
            tx,
        };
        (context, output, cancelled, rx)
    }

    #[cfg(windows)]
    fn gated_terminal_command(root: &Path, exit_code: i32) -> CommandSpec {
        let script = root.join("child.ps1");
        fs::write(&script, format!(
            "[Console]::Out.Write(\"uv-live-out`nuv-live-progress`r\"); [Console]::Out.Flush(); [Console]::Error.Write(\"uv-live-err`n\"); [Console]::Error.Flush(); $until = [DateTime]::UtcNow.AddSeconds(20); while (!(Test-Path -LiteralPath $env:BAAS_TERM_TEST_GATE) -and [DateTime]::UtcNow -lt $until) {{ Start-Sleep -Milliseconds 20 }}; exit {exit_code}"
        )).unwrap();
        CommandSpec::new("powershell.exe")
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-File")
            .arg(script.to_string_lossy())
            .env(
                "BAAS_TERM_TEST_GATE",
                root.join("release").to_string_lossy(),
            )
            .cwd(root)
    }

    #[cfg(not(windows))]
    fn gated_terminal_command(root: &Path, exit_code: i32) -> CommandSpec {
        let script = root.join("child.sh");
        fs::write(&script, format!(
            "printf 'uv-live-out\\nuv-live-progress\\r'; printf 'uv-live-err\\n' >&2; count=0; while [ ! -f \"$BAAS_TERM_TEST_GATE\" ] && [ $count -lt 1000 ]; do sleep 0.02; count=$((count+1)); done; exit {exit_code}"
        )).unwrap();
        CommandSpec::new("/bin/sh")
            .arg(script.to_string_lossy())
            .env(
                "BAAS_TERM_TEST_GATE",
                root.join("release").to_string_lossy(),
            )
            .cwd(root)
    }

    fn receive_live_child_output(rx: &mpsc::Receiver<RendererEvent>) -> String {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut text = String::new();
        while Instant::now() < deadline {
            if let Ok(RendererEvent::Output {
                task_id,
                region_id,
                chunk,
            }) = rx.recv_timeout(Duration::from_millis(100))
            {
                assert_eq!(task_id, "pypi-source-ranking");
                assert_eq!(region_id, "pypi-source-ranking");
                text.push_str(&String::from_utf8_lossy(&chunk));
                if text.contains("uv-live-out") && text.contains("uv-live-err") {
                    return text;
                }
            }
        }
        panic!("PTY did not deliver live stdout and stderr: {text:?}");
    }

    #[test]
    fn terminal_environment_pty_streams_before_exit_and_preserves_failure() {
        let root = tempfile::tempdir().unwrap();
        let command = gated_terminal_command(root.path(), 7);
        let (context, output, cancelled, rx) = terminal_process_fixture();
        let child_context = context.clone();
        let child_cancelled = Arc::clone(&cancelled);
        let worker = thread::spawn(move || child_context.run(&command, &output, &child_cancelled));
        let text = receive_live_child_output(&rx);
        assert!(
            text.contains('\r'),
            "carriage-return output was lost: {text:?}"
        );
        assert!(
            !worker.is_finished(),
            "output must arrive while the child is alive"
        );
        {
            let state = context.inner.lock().unwrap();
            assert!(
                matches!(state.tasks["pypi-source-ranking"].as_ref(), TaskHandle::Thread { cancel } if Arc::ptr_eq(cancel, &cancelled))
            );
            assert!(
                state
                    .tasks
                    .values()
                    .any(|handle| matches!(handle.as_ref(), TaskHandle::Process { .. }))
            );
        }
        fs::write(root.path().join("release"), "continue").unwrap();
        let error = worker.join().unwrap().unwrap_err();
        assert!(error.message().contains("7"), "exit code lost: {error}");
        assert_eq!(context.inner.lock().unwrap().tasks.len(), 1);
        assert!(!cancelled.load(Ordering::Relaxed));
    }

    #[test]
    fn terminal_environment_pty_abort_cancels_child_and_preserves_new_session() {
        let root = tempfile::tempdir().unwrap();
        let command = gated_terminal_command(root.path(), 0);
        let (context, _output, _cancelled, rx) = terminal_process_fixture();
        let child_context = context.clone();
        let (completion_tx, completion_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        spawn_thread_task(
            &context.inner,
            &context.session_id,
            planned_thread_task(&context.workflow_plan, "pypi-source-ranking"),
            &context.renderer_tx,
            &completion_tx,
            (),
            move |output, cancelled, ()| {
                let result = child_context.run(&command, &output, &cancelled);
                result_tx.send(result.clone()).unwrap();
                result.map_err(|error| error.message())
            },
        )
        .unwrap();
        receive_live_child_output(&rx);
        let cancelled = {
            let state = context.inner.lock().unwrap();
            match state.tasks["pypi-source-ranking"].as_ref() {
                TaskHandle::Thread { cancel } => Arc::clone(cancel),
                _ => panic!("parent thread handle was replaced"),
            }
        };
        let handles = {
            let mut state = context.inner.lock().unwrap();
            state.current_session_id = None;
            state
                .tasks
                .drain()
                .map(|(_, handle)| handle)
                .collect::<Vec<_>>()
        };
        assert_eq!(handles.len(), 2, "abort must own both parent and child");
        for handle in handles {
            match handle.as_ref() {
                TaskHandle::Thread { cancel } => cancel.store(true, Ordering::Relaxed),
                TaskHandle::Process { child, .. } => {
                    child.lock().unwrap().kill().unwrap();
                }
            }
        }
        let new_handle = Arc::new(TaskHandle::Thread {
            cancel: Arc::new(AtomicBool::new(false)),
        });
        {
            let mut state = context.inner.lock().unwrap();
            state.current_session_id = Some("new-session".to_string());
            state
                .tasks
                .insert("pypi-source-ranking".to_string(), Arc::clone(&new_handle));
        }
        let completion = completion_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(!completion.success);
        assert_eq!(
            result_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Err(UpdaterError::Cancelled)
        );
        assert!(cancelled.load(Ordering::Relaxed));
        let state = context.inner.lock().unwrap();
        assert_eq!(state.tasks.len(), 1);
        assert!(Arc::ptr_eq(
            &state.tasks["pypi-source-ranking"],
            &new_handle
        ));
    }

    /// Opt-in integration fixture uses an existing UV/Python and a generated
    /// local wheel. Offline/no-index prevents every package network request.
    #[test]
    #[ignore = "set BAAS_TEST_UV and BAAS_TEST_PYTHON to existing local executables"]
    fn terminal_environment_pty_uv_compiles_and_syncs_offline_wheel() {
        let uv = PathBuf::from(std::env::var_os("BAAS_TEST_UV").expect("BAAS_TEST_UV"));
        let python = std::env::var("BAAS_TEST_PYTHON").expect("BAAS_TEST_PYTHON");
        let root = tempfile::tempdir().unwrap();
        let wheels = root.path().join("wheels");
        fs::create_dir(&wheels).unwrap();
        let wheel =
            fs::File::create(wheels.join("baas_pty_fixture-0.0.1-py3-none-any.whl")).unwrap();
        let mut zip = zip::ZipWriter::new(wheel);
        for (path, content) in [
            ("baas_pty_fixture.py", "value = 1\n"),
            (
                "baas_pty_fixture-0.0.1.dist-info/METADATA",
                "Metadata-Version: 2.1\nName: baas-pty-fixture\nVersion: 0.0.1\n",
            ),
            (
                "baas_pty_fixture-0.0.1.dist-info/WHEEL",
                "Wheel-Version: 1.0\nGenerator: baas-pty-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            ),
            (
                "baas_pty_fixture-0.0.1.dist-info/RECORD",
                "baas_pty_fixture.py,,\nbaas_pty_fixture-0.0.1.dist-info/METADATA,,\nbaas_pty_fixture-0.0.1.dist-info/WHEEL,,\nbaas_pty_fixture-0.0.1.dist-info/RECORD,,\n",
            ),
        ] {
            zip.start_file(path, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let mut config = UpdaterConfig::default();
        config.paths.baas_root_path = root.path().to_string_lossy().to_string();
        let requirements = root.path().join("requirements.txt");
        fs::write(&requirements, "baas-pty-fixture==0.0.1\n").unwrap();
        let (context, output, cancelled, rx) = terminal_process_fixture();
        context
            .run(
                &CommandSpec::new(&uv)
                    .arg("venv")
                    .arg(root.path().join(".venv").to_string_lossy())
                    .arg("--python")
                    .arg(python)
                    .arg("--no-python-downloads")
                    .arg("--offline")
                    .env("UV_CACHE_DIR", root.path().join("cache").to_string_lossy())
                    .cwd(root.path()),
                &output,
                &cancelled,
            )
            .unwrap();
        for mut command in [
            uv_compile_command_with_index(&config, &requirements, "https://unused.invalid/simple"),
            uv_sync_command_with_index(&config, "https://unused.invalid/simple"),
        ] {
            command.program = uv.clone();
            command.args.extend([
                "--offline".to_string(),
                "--no-index".to_string(),
                "--find-links".to_string(),
                wheels.to_string_lossy().to_string(),
            ]);
            context.run(&command, &output, &cancelled).unwrap();
        }
        let text = rx
            .try_iter()
            .filter_map(|event| match event {
                RendererEvent::Output { chunk, .. } => {
                    Some(String::from_utf8_lossy(&chunk).into_owned())
                }
                _ => None,
            })
            .collect::<String>();
        assert!(
            text.contains("Resolved"),
            "compile output missing: {text:?}"
        );
        assert!(text.contains("Installed"), "sync output missing: {text:?}");
        assert!(
            text.contains("baas-pty-fixture"),
            "package output missing: {text:?}"
        );
        assert!(
            fs::read_to_string(root.path().join("requirements.service.lock"))
                .unwrap()
                .contains("baas-pty-fixture==0.0.1")
        );
        assert!(
            !requirements_compile_cached(&config, &requirements, "https://unused.invalid/simple")
                .unwrap()
        );
        save_requirements_cache(&config, &requirements, "https://unused.invalid/simple").unwrap();
        assert!(
            requirements_compile_cached(&config, &requirements, "https://unused.invalid/simple")
                .unwrap()
        );
        assert_eq!(context.inner.lock().unwrap().tasks.len(), 1);
    }

    /// Handles the git cpp job reclones when existing bin has no git metadata workflow.
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

    /// Handles the mirrorc jobs use final dirs without requiring git metadata workflow.
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

    /// Handles the mirrorc cleanup removes extra git metadata workflow.
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

    /// Handles the terminal workflow plan models parallel update and dependency order workflow.
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
        let launch = plan.node("launch-backend").unwrap();

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
        assert!(launch.running_region_unlimited);
        assert_eq!(launch.running_region_max_lines, None);
    }

    #[test]
    fn git_fetch_command_keeps_reset_separate_for_validation() {
        let command = git_fetch_command(
            "https://example.invalid/repo.git",
            "master",
            Path::new("repo"),
            "64",
        );
        let sequence = command.command_sequence();
        assert_eq!(sequence.len(), 2);
        assert!(
            sequence[1]
                .args
                .ends_with(&["fetch", "--depth", "64", "origin", "master"].map(str::to_string))
        );
        assert!(
            sequence
                .iter()
                .all(|command| !command.args.iter().any(|arg| arg == "reset"))
        );
        let reset = git_reset_command(Path::new("repo"), "verified-commit");
        assert!(
            reset
                .args
                .ends_with(&["reset", "--hard", "verified-commit"].map(str::to_string))
        );
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
    fn backend_ready_probe_rejects_non_http_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 128];
            let _ = stream.read(&mut request);
            stream.write_all(b"not an HTTP server").unwrap();
        });
        assert!(!backend_auth_endpoint_ready(port));
        handle.join().unwrap();
    }

    #[test]
    fn refused_backend_probe_has_bounded_connect_time() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let started = Instant::now();
        assert!(!backend_auth_endpoint_ready(port));
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
