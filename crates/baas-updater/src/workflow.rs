//! End-to-end updater workflow orchestration.

use crate::{
    GitBackend, OutputSink, OutputStyle, RepositoryKind, UpdateStatus, UpdaterError, UpdaterResult,
    WorkflowOptions,
    config::{ConfigManager, UpdaterConfig},
    environ::{
        CommandSpec, EnvironmentManager, EnvironmentSourceKind, HttpSourceProbe, RealProcessRunner,
        ReqwestDownloader, ensure_uv_installed_from, launch_backend_command,
        managed_python_configured, ranked_environment_source_with_output,
        repair_corrupt_lock_package_metadata, requirements_compile_cached, requirements_lock_path,
        requirements_path, save_requirements_cache, uses_managed_runtime, uv_cache_clean_command,
        uv_compile_command_with_index, uv_executable, uv_python_install_command_with_mirror,
        uv_sync_command_with_index, uv_venv_command,
    },
    mirrorc::{MirrorCClient, MirrorUpdateRequest, ReqwestMirrorHttp},
    repo::{
        GitExecutor, GitHttpSourceProbe, GitSourceProbe, RealGitExecutor, RepoManager,
        RepoSyncOptions, load_or_benchmark_ranking, repository_branch, repository_urls,
        save_ranking,
    },
};
use baas_term::{
    common::{session_is_current, wait_for_completions},
    processor::{ScriptCommand, run_process_and_wait, spawn_process_task},
    threader::{ThreadOutput, spawn_thread_task},
    types::{RendererEvent, TaskCompletion, TaskSpec, TermState, WorkflowPlan},
    workflow::{WorkflowBuilder, WorkflowTask},
};
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
        output.line(
            OutputStyle::Info,
            &format!("Launching backend on 127.0.0.1:{port}"),
        );
        EnvironmentManager::new(RealProcessRunner, ReqwestDownloader)
            .launch_backend(config, port, output)?;
        output.line(
            OutputStyle::Info,
            &format!("Backend process spawned; probing 127.0.0.1:{port}"),
        );
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(30) {
            if backend_auth_endpoint_ready(port) {
                output.line(
                    OutputStyle::Success,
                    &format!(
                        "Backend accepted connections on 127.0.0.1:{port} after {:.1}s",
                        started.elapsed().as_secs_f64()
                    ),
                );
                return Ok(());
            }
            thread::sleep(Duration::from_millis(300));
        }
        Err(UpdaterError::Workflow(format!(
            "backend auth endpoint did not become ready on 127.0.0.1:{port}"
        )))
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
) -> bool {
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
        return false;
    }

    if !run_terminal_update_and_prepare_stage(
        &inner,
        &session_id,
        &renderer_tx,
        &workflow_plan,
        Arc::clone(&state),
    ) {
        fail_terminal_session(&inner, &session_id, &renderer_tx, &cleanup_state);
        return false;
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
        return false;
    }

    let dependency_ctx = TerminalRunContext {
        inner: &inner,
        session_id: &session_id,
        renderer_tx: &renderer_tx,
        completion_tx: &completion_tx,
        completion_rx: &completion_rx,
        workflow_plan: &workflow_plan,
    };
    if !run_terminal_dependency_stage(&dependency_ctx, Arc::clone(&state), options.launch) {
        fail_terminal_session(&inner, &session_id, &renderer_tx, &cleanup_state);
        return false;
    }

    finish_terminal_session(&inner, &session_id, &renderer_tx, true);
    true
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
            "Clean UV Cache",
            "Clean UV cache after dependency synchronization.",
            "uv cache clean",
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
            WorkflowTask::new(
                "backend-ready",
                "backend-ready",
                "Backend Ready",
                "Wait until the backend auth endpoint accepts local connections.",
                "probe backend readiness",
            ),
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

struct TerminalRunContext<'a> {
    inner: &'a Arc<Mutex<TermState>>,
    session_id: &'a str,
    renderer_tx: &'a Sender<RendererEvent>,
    completion_tx: &'a Sender<TaskCompletion>,
    completion_rx: &'a mpsc::Receiver<TaskCompletion>,
    workflow_plan: &'a WorkflowPlan,
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
            let ctx = TerminalRunContext {
                inner: &repo_inner,
                session_id: &repo_session_id,
                renderer_tx: &repo_renderer_tx,
                completion_tx: &repo_completion_tx,
                completion_rx: &repo_completion_rx,
                workflow_plan,
            };
            run_terminal_repo_stage(&ctx, repo_state)
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
    ctx: &TerminalRunContext<'_>,
    state: Arc<Mutex<TerminalWorkflowState>>,
) -> bool {
    let (config, main_job, cpp_job, ranking_dir) = match terminal_state_snapshot(&state) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "updater-repo-stage".to_string(),
                region_id: "updater-repo-stage".to_string(),
                tx: ctx.renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };

    if config.general.no_update {
        return run_terminal_thread_repo_stage(ctx, state, None);
    }

    if !config.general.mirrorc_cdk.is_empty()
        || config.general.git_backend == GitBackend::Git2
        || !RealGitExecutor.has_cli()
    {
        let git_backend_override = if config.general.git_backend == GitBackend::Auto
            && config.general.mirrorc_cdk.is_empty()
        {
            Some(GitBackend::Git2)
        } else {
            None
        };
        return run_terminal_thread_repo_stage(ctx, state, git_backend_override);
    }

    let main_plan = match plan_git_cli_process(
        RepositoryKind::Main,
        &config,
        &main_job.target_dir,
        &ranking_dir.join("main.json"),
    ) {
        Ok(plan) => plan,
        Err(_) => {
            return if config.general.git_backend == GitBackend::Auto {
                run_terminal_thread_repo_stage(ctx, state, Some(GitBackend::Git2))
            } else {
                run_terminal_thread_repo_stage(ctx, state, None)
            };
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
            return if config.general.git_backend == GitBackend::Auto {
                run_terminal_thread_repo_stage(ctx, state, Some(GitBackend::Git2))
            } else {
                run_terminal_thread_repo_stage(ctx, state, None)
            };
        }
    };

    let main_spec =
        planned_direct_process_task(ctx.workflow_plan, "main-repository", &main_plan.command);
    let cpp_spec =
        planned_direct_process_task(ctx.workflow_plan, "cpp-repository", &cpp_plan.command);
    let main_id = main_spec.task_id.clone();
    let cpp_id = cpp_spec.task_id.clone();
    let _ = ctx.renderer_tx.send(RendererEvent::BufferRegions {
        region_ids: vec![main_spec.region_id.clone(), cpp_spec.region_id.clone()],
    });
    if spawn_process_task(
        ctx.inner,
        ctx.session_id,
        main_spec,
        ctx.renderer_tx,
        ctx.completion_tx,
    )
    .is_err()
        || spawn_process_task(
            ctx.inner,
            ctx.session_id,
            cpp_spec,
            ctx.renderer_tx,
            ctx.completion_tx,
        )
        .is_err()
    {
        return false;
    }
    let success = wait_for_completions(ctx.completion_rx, vec![main_id, cpp_id]).unwrap_or(false);
    let _ = ctx.renderer_tx.send(RendererEvent::FlushRegions {
        region_ids: vec!["main-repository".to_string(), "cpp-repository".to_string()],
    });
    if !success || !session_is_current(ctx.inner, ctx.session_id) {
        if config.general.git_backend == GitBackend::Auto
            && session_is_current(ctx.inner, ctx.session_id)
        {
            return run_terminal_thread_repo_stage(ctx, state, Some(GitBackend::Git2));
        }
        return false;
    }

    let record_spec = planned_thread_task(ctx.workflow_plan, "git-record-sha");
    spawn_thread_task(
        ctx.inner,
        ctx.session_id,
        record_spec,
        ctx.renderer_tx,
        ctx.completion_tx,
        TerminalGitRecordArgs {
            state,
            main_plan,
            cpp_plan,
        },
        terminal_git_record_task,
    )
    .is_ok()
        && wait_for_task(ctx.completion_rx, "git-record-sha")
}

/// Performs the run terminal thread repo stage operation.
fn run_terminal_thread_repo_stage(
    ctx: &TerminalRunContext<'_>,
    state: Arc<Mutex<TerminalWorkflowState>>,
    git_backend_override: Option<GitBackend>,
) -> bool {
    let main = planned_thread_task(ctx.workflow_plan, "main-repository");
    let cpp = planned_thread_task(ctx.workflow_plan, "cpp-repository");
    let main_id = main.task_id.clone();
    let cpp_id = cpp.task_id.clone();
    let _ = ctx.renderer_tx.send(RendererEvent::BufferRegions {
        region_ids: vec![main.region_id.clone(), cpp.region_id.clone()],
    });
    let main_spawn = spawn_thread_task(
        ctx.inner,
        ctx.session_id,
        main,
        ctx.renderer_tx,
        ctx.completion_tx,
        TerminalRepoArgs {
            kind: RepositoryKind::Main,
            state: Arc::clone(&state),
            git_backend_override,
        },
        terminal_repo_thread_task,
    );
    let cpp_spawn = spawn_thread_task(
        ctx.inner,
        ctx.session_id,
        cpp,
        ctx.renderer_tx,
        ctx.completion_tx,
        TerminalRepoArgs {
            kind: RepositoryKind::Cpp,
            state,
            git_backend_override,
        },
        terminal_repo_thread_task,
    );
    if main_spawn.is_err() || cpp_spawn.is_err() {
        return false;
    }
    let success = wait_for_completions(ctx.completion_rx, vec![main_id, cpp_id]).unwrap_or(false);
    let _ = ctx.renderer_tx.send(RendererEvent::FlushRegions {
        region_ids: vec!["main-repository".to_string(), "cpp-repository".to_string()],
    });
    success && session_is_current(ctx.inner, ctx.session_id)
}

struct TerminalRepoArgs {
    kind: RepositoryKind,
    state: Arc<Mutex<TerminalWorkflowState>>,
    git_backend_override: Option<GitBackend>,
}

/// Handles the terminal repo thread task workflow.
fn terminal_repo_thread_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: TerminalRepoArgs,
) -> Result<(), String> {
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
    let outcome = if config.general.no_update {
        output.line(
            OutputStyle::Info,
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
        let outcome = RealWorkflowServices
            .update_repository(args.kind, &config, &job.target_dir, &ranking_path, &output)
            .map_err(|error| error.message())?;
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
    Ok(())
}

#[derive(Clone)]
struct GitCliPlan {
    kind: RepositoryKind,
    command: CommandSpec,
    target_dir: PathBuf,
    status: UpdateStatus,
}

/// Handles the plan git cli process workflow.
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

/// Handles the git update command workflow.
fn git_update_command(url: &str, branch: &str, target_dir: &Path) -> CommandSpec {
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
                .arg("1")
                .arg("origin")
                .arg(branch),
        )
        .after(
            git_cli_command()
                .arg("-C")
                .arg(target_dir.to_string_lossy())
                .arg("reset")
                .arg("--hard")
                .arg("FETCH_HEAD"),
        )
        .after(
            git_cli_command()
                .arg("-C")
                .arg(target_dir.to_string_lossy())
                .arg("reflog")
                .arg("expire")
                .arg("--expire=now")
                .arg("--all"),
        )
        .after(
            git_cli_command()
                .arg("-C")
                .arg(target_dir.to_string_lossy())
                .arg("gc")
                .arg("--prune=now"),
        )
}

/// Handles the git rev parse command workflow.
fn git_rev_parse_command(target_dir: &Path) -> CommandSpec {
    git_cli_command()
        .arg("-C")
        .arg(target_dir.to_string_lossy())
        .arg("rev-parse")
        .arg("HEAD")
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

struct TerminalGitRecordArgs {
    state: Arc<Mutex<TerminalWorkflowState>>,
    main_plan: GitCliPlan,
    cpp_plan: GitCliPlan,
}

/// Handles the terminal git record task workflow.
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
        let ctx = TerminalRunContext {
            inner,
            session_id,
            renderer_tx,
            completion_tx,
            completion_rx,
            workflow_plan,
        };
        return run_terminal_skip_task(
            &ctx,
            "cpython-source-ranking",
            "Python virtual environment exists; skipping CPython source ranking",
        ) && run_terminal_skip_task(
            &ctx,
            "uv-python-install",
            "Python virtual environment exists; skipping uv python install",
        ) && run_terminal_skip_task(
            &ctx,
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
        planned_direct_process_task(
            workflow_plan,
            "uv-python-install",
            &uv_python_install_command_with_mirror(&config, &cpython_mirror),
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
            planned_direct_process_task(workflow_plan, "uv-venv", &uv_venv_command(&config)),
            renderer_tx,
            completion_tx,
            completion_rx,
        )
    {
        return false;
    }

    true
}

/// Performs the run terminal dependency stage operation.
fn run_terminal_dependency_stage(
    ctx: &TerminalRunContext<'_>,
    state: Arc<Mutex<TerminalWorkflowState>>,
    launch: bool,
) -> bool {
    let config = match terminal_config(&state) {
        Ok(config) => config,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "dependencies".to_string(),
                region_id: "dependencies".to_string(),
                tx: ctx.renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };

    if !uses_managed_runtime(&config) {
        let spec = planned_thread_task(ctx.workflow_plan, "uv-sync");
        if spawn_thread_task(
            ctx.inner,
            ctx.session_id,
            spec,
            ctx.renderer_tx,
            ctx.completion_tx,
            config.clone(),
            terminal_custom_runtime_task,
        )
        .is_err()
            || !wait_for_task(ctx.completion_rx, "uv-sync")
        {
            return false;
        }
        return run_terminal_launch_stage(ctx, config, launch);
    }

    let requirements = match requirements_path(&config) {
        Some(path) => path,
        None => {
            let output = ThreadOutput {
                task_id: "uv-requirements".to_string(),
                region_id: "uv-requirements".to_string(),
                tx: ctx.renderer_tx.clone(),
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
                tx: ctx.renderer_tx.clone(),
            };
            output.line(OutputStyle::Error, &error);
            return false;
        }
    };
    let pypi_rank_spec = planned_thread_task(ctx.workflow_plan, "pypi-source-ranking");
    if spawn_thread_task(
        ctx.inner,
        ctx.session_id,
        pypi_rank_spec,
        ctx.renderer_tx,
        ctx.completion_tx,
        TerminalPypiRankArgs {
            state: Arc::clone(&state),
            config: config.clone(),
            ranking_dir,
        },
        terminal_pypi_rank_task,
    )
    .is_err()
        || !wait_for_task(ctx.completion_rx, "pypi-source-ranking")
    {
        return false;
    }

    let pypi_index = match terminal_pypi_source(&state) {
        Ok(source) => source,
        Err(error) => {
            let output = ThreadOutput {
                task_id: "pypi-source-ranking".to_string(),
                region_id: "pypi-source-ranking".to_string(),
                tx: ctx.renderer_tx.clone(),
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
            if !run_terminal_skip_task(ctx, task_id, message) {
                return false;
            }
        }
    } else if !run_process_and_wait(
        ctx.inner,
        ctx.session_id,
        planned_direct_process_task(
            ctx.workflow_plan,
            "uv-compile",
            &uv_compile_command_with_index(&config, &requirements, &pypi_index),
        ),
        ctx.renderer_tx,
        ctx.completion_tx,
        ctx.completion_rx,
    ) {
        return false;
    } else {
        let output = ThreadOutput {
            task_id: "uv-sync".to_string(),
            region_id: "uv-sync".to_string(),
            tx: ctx.renderer_tx.clone(),
        };
        if repair_corrupt_lock_package_metadata(&config, &requirements_lock_path(&config), &output)
            .is_err()
        {
            return false;
        }
        for (task_id, command) in [
            ("uv-sync", uv_sync_command_with_index(&config, &pypi_index)),
            ("uv-cache-clean", uv_cache_clean_command(&config)),
        ] {
            let task = planned_direct_process_task(ctx.workflow_plan, task_id, &command)
                .with_running_region_max_lines(4);
            if !run_process_and_wait(
                ctx.inner,
                ctx.session_id,
                task,
                ctx.renderer_tx,
                ctx.completion_tx,
                ctx.completion_rx,
            ) {
                return false;
            }
        }
        if save_requirements_cache(&config, &requirements, &pypi_index).is_err() {
            return false;
        }
    }

    run_terminal_launch_stage(ctx, config, launch)
}

/// Performs the run terminal skip task operation.
fn run_terminal_skip_task(ctx: &TerminalRunContext<'_>, task_id: &str, message: &str) -> bool {
    spawn_thread_task(
        ctx.inner,
        ctx.session_id,
        planned_thread_task(ctx.workflow_plan, task_id),
        ctx.renderer_tx,
        ctx.completion_tx,
        TerminalSkipArgs {
            message: message.to_string(),
        },
        terminal_skip_task,
    )
    .is_ok()
        && wait_for_task(ctx.completion_rx, task_id)
}

struct TerminalSkipArgs {
    message: String,
}

/// Handles the terminal skip task workflow.
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

/// Performs the run terminal launch stage operation.
fn run_terminal_launch_stage(
    ctx: &TerminalRunContext<'_>,
    config: UpdaterConfig,
    launch: bool,
) -> bool {
    if !launch || !config.general.launch {
        return run_terminal_skip_task(
            ctx,
            "launch-backend",
            "backend launch disabled; skipping backend start",
        ) && run_terminal_skip_task(
            ctx,
            "backend-ready",
            "backend launch disabled; skipping readiness probe",
        );
    }
    let output = ThreadOutput {
        task_id: "launch-backend".to_string(),
        region_id: "launch-backend".to_string(),
        tx: ctx.renderer_tx.clone(),
    };
    output.line(OutputStyle::Info, "Preparing backend launch");
    let port = match available_port() {
        Ok(port) => port,
        Err(error) => {
            output.line(OutputStyle::Error, &error.message());
            return false;
        }
    };
    output.line(
        OutputStyle::Info,
        &format!("Selected backend port 127.0.0.1:{port}"),
    );
    let command = launch_backend_command(&config, port);
    let success = run_process_and_wait(
        ctx.inner,
        ctx.session_id,
        planned_direct_process_task(ctx.workflow_plan, "launch-backend", &command),
        ctx.renderer_tx,
        ctx.completion_tx,
        ctx.completion_rx,
    );
    if !success {
        return false;
    }
    let ready_task = planned_thread_task(ctx.workflow_plan, "backend-ready");
    if spawn_thread_task(
        ctx.inner,
        ctx.session_id,
        ready_task,
        ctx.renderer_tx,
        ctx.completion_tx,
        BackendReadyArgs {
            inner: Arc::clone(ctx.inner),
            session_id: ctx.session_id.to_string(),
            port,
        },
        terminal_backend_ready_task,
    )
    .is_err()
        || !wait_for_task(ctx.completion_rx, "backend-ready")
    {
        return false;
    }
    let _ = ctx.renderer_tx.send(RendererEvent::BackendReady {
        base_backend_addr: "127.0.0.1".to_string(),
        base_backend_port: port,
    });
    true
}

struct BackendReadyArgs {
    inner: Arc<Mutex<TermState>>,
    session_id: String,
    port: u16,
}

/// Handles the backend readiness probe workflow.
fn terminal_backend_ready_task(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: BackendReadyArgs,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let timeout = Duration::from_secs(30);
    let mut next_notice = Duration::ZERO;
    output.line(
        OutputStyle::Info,
        &format!("Waiting for backend on 127.0.0.1:{}...", args.port),
    );

    while started.elapsed() < timeout {
        if cancelled.load(Ordering::Relaxed) {
            return Err("backend readiness probe cancelled".to_string());
        }
        if !session_is_current(&args.inner, &args.session_id) {
            return Err("backend readiness probe cancelled".to_string());
        }
        if backend_auth_endpoint_ready(args.port) {
            output.line(
                OutputStyle::Success,
                &format!(
                    "Backend accepted connections on 127.0.0.1:{} after {:.1}s",
                    args.port,
                    started.elapsed().as_secs_f64()
                ),
            );
            return Ok(());
        }

        let elapsed = started.elapsed();
        if elapsed >= next_notice {
            output.line(
                OutputStyle::Info,
                &format!(
                    "Backend is still starting ({:.1}s elapsed, timeout {:.0}s)",
                    elapsed.as_secs_f64(),
                    timeout.as_secs_f64()
                ),
            );
            next_notice = elapsed + Duration::from_secs(3);
        }
        thread::sleep(Duration::from_millis(300));
    }

    Err(format!(
        "backend auth endpoint did not become ready on 127.0.0.1:{} after {:.0}s",
        args.port,
        timeout.as_secs_f64()
    ))
}

/// Handles the terminal uv install task workflow.
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

/// Handles the terminal cpython rank task workflow.
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

/// Handles the terminal pypi rank task workflow.
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

/// Handles the terminal custom runtime task workflow.
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

/// Handles the backend auth endpoint ready workflow.
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

/// Handles the terminal state snapshot workflow.
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
        let ready = plan.node("backend-ready").unwrap();

        assert_eq!(main.stage, cpp.stage);
        assert_eq!(main.stage, uv.stage);
        assert_eq!(cpython.stage, uv.stage + 1);
        assert_eq!(python.stage, cpython.stage + 1);
        assert_eq!(venv.stage, python.stage + 1);
        assert!(git_record.stage > main.stage);
        assert!(finalize.stage > git_record.stage);
        assert!(finalize.stage > venv.stage);
        assert!(compile.stage > finalize.stage);
        assert!(launch.stage > compile.stage);
        assert!(ready.stage > launch.stage);
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
        assert_eq!(plan.nodes.len() as u8, ready.step_total);
        assert!(launch.running_region_unlimited);
        assert_eq!(launch.running_region_max_lines, None);
    }

    /// Handles the git update command uses serial command chain workflow.
    #[test]
    fn git_update_command_uses_serial_command_chain() {
        let command = git_update_command(
            "https://example.invalid/repo.git",
            "master",
            Path::new("repo"),
        );
        let sequence = command.command_sequence();
        let git_prefix = [
            "-c",
            "credential.helper=",
            "-c",
            "credential.interactive=never",
            "-c",
            "core.askPass=echo",
            "-c",
            "core.sshCommand=ssh -o BatchMode=yes",
        ];

        assert_eq!(sequence.len(), 5);
        assert_eq!(
            sequence[0].args,
            [
                git_prefix.as_slice(),
                &[
                    "-C",
                    "repo",
                    "remote",
                    "set-url",
                    "origin",
                    "https://example.invalid/repo.git",
                ]
            ]
            .concat()
        );
        assert_eq!(
            sequence[1].args,
            [
                git_prefix.as_slice(),
                &["-C", "repo", "fetch", "--depth", "1", "origin", "master",]
            ]
            .concat()
        );
        assert_eq!(
            sequence[2].args,
            [
                git_prefix.as_slice(),
                &["-C", "repo", "reset", "--hard", "FETCH_HEAD",]
            ]
            .concat()
        );
        assert_eq!(
            sequence[3].args,
            [
                git_prefix.as_slice(),
                &["-C", "repo", "reflog", "expire", "--expire=now", "--all",]
            ]
            .concat()
        );
        assert_eq!(
            sequence[4].args,
            [git_prefix.as_slice(), &["-C", "repo", "gc", "--prune=now",]].concat()
        );
    }

    /// Handles the backend ready probe requires http response workflow.
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
}
