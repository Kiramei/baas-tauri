//! Android-only repository updater.
//!
//! Android cannot rely on UV or a system Git executable. This module keeps the
//! mobile workflow deliberately narrow: synchronize the BAAS Python repository
//! and the Android Cpp/OCR prebuild repository with libgit2, then persist the
//! resulting SHAs in setup.toml.

use crate::{
    GitBackend, OutputSink, OutputStyle, RepositoryKind, UpdateChannel, UpdateStatus, UpdaterError,
    UpdaterResult, WorkflowOptions,
    config::{ConfigManager, UpdaterConfig},
    repo::{SourceRanking, load_or_default_ranking, repository_urls, save_ranking},
};
use baas_term::{
    common::{session_is_current, wait_for_completions},
    renderer::renderer_loop,
    threader::{
        ThreadLogStyle, ThreadProgressBar, create_thread_task_with_total, spawn_thread_task,
    },
    types::{
        RendererEvent, SessionMetadata, SessionStartedPayload, TaskCompletion, TaskHandle,
        TermState, WorkflowPlan,
    },
    workflow::{WorkflowBuilder, WorkflowTask},
};
use git2::{
    CertificateCheckStatus, Direction, FetchOptions, Oid, RemoteCallbacks, Repository,
    build::RepoBuilder,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
        mpsc::Sender,
    },
    thread,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const ANDROID_STEP_TOTAL: u8 = 4;

/// Request payload for aborting an Android updater workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidWorkflowAbortRequest {
    /// Whether terminal session-finished events should be emitted.
    #[serde(default = "default_abort_emit_events")]
    pub emit_events: bool,
}

impl Default for AndroidWorkflowAbortRequest {
    /// Handles the default workflow.
    fn default() -> Self {
        Self { emit_events: true }
    }
}

/// Handles the default abort emit events workflow.
fn default_abort_emit_events() -> bool {
    true
}

/// Result payload returned after aborting an Android updater workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidWorkflowAbortReport {
    /// Number of currently registered tasks that were stopped.
    pub stopped_tasks: usize,
}

/// Current Android terminal workflow snapshot for late frontend subscribers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidTerminalSnapshot {
    /// Active session id when one exists.
    pub session_id: Option<String>,
    /// Last planned workflow graph for the active session.
    pub workflow_plan: Option<WorkflowPlan>,
}

/// Terminal-backed Android updater session manager.
#[derive(Clone, Default)]
pub struct AndroidUpdaterTermManager {
    inner: Arc<Mutex<TermState>>,
}

impl AndroidUpdaterTermManager {
    /// Starts a terminal-rendered Android git2 update workflow.
    pub fn start(
        &self,
        app: AppHandle,
        options: WorkflowOptions,
    ) -> Result<SessionMetadata, String> {
        self.abort(AndroidWorkflowAbortRequest { emit_events: false })?;

        let session_id = Uuid::new_v4().to_string();
        let (renderer_tx, renderer_rx) = mpsc::channel();
        let workflow_plan = android_workflow_plan();
        let (initial_rows, initial_cols) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "android updater manager lock poisoned")?;
            state.current_session_id = Some(session_id.clone());
            state.renderer_tx = Some(renderer_tx.clone());
            state.workflow_plan = Some(workflow_plan);
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
            run_android_update_flow(flow_inner, flow_session_id, renderer_tx, options)
        });

        Ok(SessionMetadata {
            session_id,
            status: "running".to_string(),
        })
    }

    /// Returns the active terminal workflow snapshot.
    pub fn snapshot(&self) -> Result<AndroidTerminalSnapshot, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "android updater manager lock poisoned")?;
        Ok(AndroidTerminalSnapshot {
            session_id: state.current_session_id.clone(),
            workflow_plan: state.workflow_plan.clone(),
        })
    }

    /// Resizes active terminal renderer state.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let tx = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "android updater manager lock poisoned")?;
            state.rows = rows;
            state.cols = cols;
            state.renderer_tx.clone()
        };
        if let Some(tx) = tx {
            let _ = tx.send(RendererEvent::Resize { rows, cols });
        }
        Ok(())
    }

    /// Aborts the current Android updater workflow.
    pub fn abort(
        &self,
        request: AndroidWorkflowAbortRequest,
    ) -> Result<AndroidWorkflowAbortReport, String> {
        let (tasks, tx) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "android updater manager lock poisoned")?;
            let tasks = state.tasks.drain().collect::<Vec<_>>();
            let tx = state.renderer_tx.take();
            state.current_session_id = None;
            state.workflow_plan = None;
            (tasks, tx)
        };
        let stopped_tasks = tasks.len();
        for (task_id, handle) in tasks {
            match &*handle {
                TaskHandle::Process { child, .. } => {
                    let _ = child
                        .lock()
                        .map_err(|_| "android updater child lock poisoned")?
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
        if request.emit_events
            && let Some(tx) = tx
        {
            let _ = tx.send(RendererEvent::SessionFinished { success: false });
        }
        Ok(AndroidWorkflowAbortReport { stopped_tasks })
    }
}

/// Builds the Android-only update graph.
pub fn android_workflow_plan() -> WorkflowPlan {
    WorkflowBuilder::new()
        .thread_task(
            "android-config",
            "android-config",
            "Android Config",
            "Load setup.toml and force Android git2 update mode.",
            "load Android setup.toml",
        )
        .parallel(vec![
            WorkflowTask::new(
                "android-main-repository",
                "android-main-repository",
                "Main Repository",
                "Clone or update the BAAS Python repository with git2.",
                "git2 sync main repository",
            ),
            WorkflowTask::new(
                "android-cpp-repository",
                "android-cpp-repository",
                "Cpp Repository",
                "Clone or update the Android Cpp/OCR repository with git2.",
                "git2 sync Android cpp repository",
            ),
        ])
        .thread_task(
            "android-finalize",
            "android-finalize",
            "Finalize",
            "Persist repository SHAs after Android git2 synchronization.",
            "persist Android repository versions",
        )
        .build()
}

#[derive(Default)]
struct AndroidWorkflowState {
    manager: Option<ConfigManager>,
    main_outcome: Option<AndroidRepositoryOutcome>,
    cpp_outcome: Option<AndroidRepositoryOutcome>,
}

#[derive(Debug, Clone)]
struct AndroidRepositoryOutcome {
    status: UpdateStatus,
    sha: String,
    source_url: String,
}

/// Performs the run android update flow operation.
fn run_android_update_flow(
    inner: Arc<Mutex<TermState>>,
    session_id: String,
    renderer_tx: Sender<RendererEvent>,
    options: WorkflowOptions,
) {
    let (completion_tx, completion_rx) = mpsc::channel::<TaskCompletion>();
    let state = Arc::new(Mutex::new(AndroidWorkflowState::default()));
    let workflow_plan = android_workflow_plan();
    let _ = renderer_tx.send(RendererEvent::WorkflowPlanned(workflow_plan.clone()));

    if spawn_thread_task(
        &inner,
        &session_id,
        android_task(&workflow_plan, "android-config"),
        &renderer_tx,
        &completion_tx,
        AndroidConfigArgs {
            options,
            state: Arc::clone(&state),
        },
        android_config_task,
    )
    .is_err()
        || !wait_for_android_task(&completion_rx, "android-config")
    {
        finish_android_session(&inner, &session_id, &renderer_tx, false);
        return;
    }

    if !run_android_repository_stage(
        &inner,
        &session_id,
        &renderer_tx,
        &completion_tx,
        &completion_rx,
        &workflow_plan,
        Arc::clone(&state),
    ) {
        finish_android_session(&inner, &session_id, &renderer_tx, false);
        return;
    }

    if spawn_thread_task(
        &inner,
        &session_id,
        android_task(&workflow_plan, "android-finalize"),
        &renderer_tx,
        &completion_tx,
        state,
        android_finalize_task,
    )
    .is_err()
        || !wait_for_android_task(&completion_rx, "android-finalize")
    {
        finish_android_session(&inner, &session_id, &renderer_tx, false);
        return;
    }

    finish_android_session(&inner, &session_id, &renderer_tx, true);
}

/// Handles the android task workflow.
fn android_task(plan: &WorkflowPlan, task_id: &str) -> baas_term::types::TaskSpec {
    let node = plan.node(task_id).expect("android workflow task missing");
    create_thread_task_with_total(
        &node.task_id,
        &node.region_id,
        node.step_index,
        ANDROID_STEP_TOTAL,
        &node.name,
        &node.command,
    )
}

struct AndroidConfigArgs {
    options: WorkflowOptions,
    state: Arc<Mutex<AndroidWorkflowState>>,
}

/// Handles the android config task workflow.
fn android_config_task(
    output: baas_term::threader::ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: AndroidConfigArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("android config task cancelled".to_string());
    }
    let config_path = args
        .options
        .config_path
        .clone()
        .ok_or_else(|| "Android updater requires an explicit setup.toml path".to_string())?;
    let mut manager = ConfigManager::load_from(&config_path).map_err(|error| error.message())?;
    let install_path = args
        .options
        .install_path
        .clone()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| manager.config.baas_root());
    if install_path.as_os_str().is_empty() {
        return Err("Android updater requires a BAAS root path".to_string());
    }
    fs::create_dir_all(&install_path).map_err(|error| error.to_string())?;
    manager
        .update(|config| {
            config.paths.baas_root_path = install_path.to_string_lossy().to_string();
            config.general.git_backend = GitBackend::Git2;
            config.general.mirrorc_cdk.clear();
            config.general.launch = args.options.launch;
            config.python.runtime_path = "embedded-python-3.9".to_string();
        })
        .map_err(|error| error.message())?;
    output.line(
        OutputStyle::Info,
        &format!("Android BAAS root: {}", install_path.display()),
    );
    output.line(
        OutputStyle::Success,
        "Android updater will use Rust git2 only; no archive packages or system git",
    );
    args.state
        .lock()
        .map_err(|_| "android workflow state lock poisoned".to_string())?
        .manager = Some(manager);
    Ok(())
}

/// Performs the run android repository stage operation.
fn run_android_repository_stage(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    completion_rx: &mpsc::Receiver<TaskCompletion>,
    workflow_plan: &WorkflowPlan,
    state: Arc<Mutex<AndroidWorkflowState>>,
) -> bool {
    let main = android_task(workflow_plan, "android-main-repository");
    let cpp = android_task(workflow_plan, "android-cpp-repository");
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
        AndroidRepositoryArgs {
            kind: RepositoryKind::Main,
            state: Arc::clone(&state),
        },
        android_repository_task,
    );
    let cpp_spawn = spawn_thread_task(
        inner,
        session_id,
        cpp,
        renderer_tx,
        completion_tx,
        AndroidRepositoryArgs {
            kind: RepositoryKind::Cpp,
            state,
        },
        android_repository_task,
    );
    if main_spawn.is_err() || cpp_spawn.is_err() {
        return false;
    }
    let success = wait_for_completions(completion_rx, vec![main_id, cpp_id]).unwrap_or(false);
    let _ = renderer_tx.send(RendererEvent::FlushRegions {
        region_ids: vec![
            "android-main-repository".to_string(),
            "android-cpp-repository".to_string(),
        ],
    });
    success && session_is_current(inner, session_id)
}

struct AndroidRepositoryArgs {
    kind: RepositoryKind,
    state: Arc<Mutex<AndroidWorkflowState>>,
}

/// Handles the android repository task workflow.
fn android_repository_task(
    output: baas_term::threader::ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: AndroidRepositoryArgs,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("android repository task cancelled".to_string());
    }
    let config = {
        let state = args
            .state
            .lock()
            .map_err(|_| "android workflow state lock poisoned".to_string())?;
        state
            .manager
            .as_ref()
            .ok_or_else(|| "android configuration not initialized".to_string())?
            .config
            .clone()
    };
    let outcome =
        sync_android_repository(args.kind, &config, &output).map_err(|error| error.message())?;
    output.line(
        OutputStyle::Success,
        &format!(
            "{} repository {} at {}",
            args.kind.as_str(),
            update_status_text(&outcome.status),
            short_sha(&outcome.sha)
        ),
    );
    let mut state = args
        .state
        .lock()
        .map_err(|_| "android workflow state lock poisoned".to_string())?;
    match args.kind {
        RepositoryKind::Main => state.main_outcome = Some(outcome),
        RepositoryKind::Cpp => state.cpp_outcome = Some(outcome),
    }
    Ok(())
}

/// Performs the sync android repository operation.
fn sync_android_repository(
    kind: RepositoryKind,
    config: &UpdaterConfig,
    output: &(dyn OutputSink + Send + Sync),
) -> UpdaterResult<AndroidRepositoryOutcome> {
    let root = config.baas_root();
    let target_dir = android_repository_target(&root, kind);
    let ranking_dir = root.join(".baas-updater").join("source-ranking");
    fs::create_dir_all(&ranking_dir)?;
    let ranking_path = ranking_dir.join(format!("android-{}.json", kind.as_str()));
    let urls = repository_urls(kind, config.general.channel);
    let ranking = load_or_default_ranking(Some(&ranking_path), &urls)?;
    let mut ranking = if ranking.all_disabled() {
        output.line(
            OutputStyle::Warning,
            "Every Android git2 source is disabled in ranking; trying configured order",
        );
        SourceRanking::from_urls(&urls)
    } else {
        ranking
    };
    let branch = android_repository_branch(kind, config.general.channel)?;
    let mut last_error = None;

    for source in ranking.active_sources() {
        output.line(
            OutputStyle::Info,
            &format!(
                "git2 {} {} from {}",
                if is_git_repository(&target_dir) {
                    "fetch"
                } else {
                    "clone"
                },
                branch,
                source.url
            ),
        );
        match sync_git2_worktree(&source.url, &branch, &target_dir, output) {
            Ok((status, sha)) => {
                save_ranking(&ranking_path, &ranking)?;
                return Ok(AndroidRepositoryOutcome {
                    status,
                    sha,
                    source_url: source.url,
                });
            }
            Err(error) => {
                output.line(OutputStyle::Warning, &format!("{error}"));
                ranking.demote_failed(&source.url);
                save_ranking(&ranking_path, &ranking)?;
                last_error = Some(error);
            }
        }
    }

    Err(UpdaterError::Git(format!(
        "all Android git2 sources failed for {}{}",
        kind.as_str(),
        last_error
            .map(|error| format!("; last error: {}", error.message()))
            .unwrap_or_default()
    )))
}

/// Handles the android repository target workflow.
fn android_repository_target(root: &Path, kind: RepositoryKind) -> PathBuf {
    match kind {
        RepositoryKind::Main => root.to_path_buf(),
        RepositoryKind::Cpp => root
            .join("core")
            .join("ocr")
            .join("baas_ocr_client")
            .join("bin"),
    }
}

/// Handles the android repository branch workflow.
fn android_repository_branch(
    kind: RepositoryKind,
    _channel: UpdateChannel,
) -> UpdaterResult<String> {
    match kind {
        RepositoryKind::Main => Ok("master".to_string()),
        RepositoryKind::Cpp => android_cpp_branch_for(std::env::consts::ARCH),
    }
}

/// Returns the local Android repository HEAD SHA using git2.
pub fn android_repository_local_sha(root: &Path, kind: RepositoryKind) -> UpdaterResult<String> {
    let target = android_repository_target(root, kind);
    let repo = Repository::open(target)?;
    head_sha(&repo)
}

/// Reads a remote branch HEAD SHA with git2 without downloading the repository.
pub fn android_repository_remote_sha(
    root: &Path,
    kind: RepositoryKind,
    channel: UpdateChannel,
    url: &str,
) -> UpdaterResult<String> {
    let output = crate::NoopOutput;
    configure_android_git2_ssl(&output)?;
    let branch = android_repository_branch(kind, channel)?;
    let scratch_dir = root
        .join(".baas-updater")
        .join("remote-probe")
        .join(kind.as_str());
    fs::create_dir_all(&scratch_dir)?;
    let repo =
        Repository::open_bare(&scratch_dir).or_else(|_| Repository::init_bare(&scratch_dir))?;
    let mut remote = repo.remote_anonymous(url)?;
    let callbacks = android_remote_callbacks(&output);
    remote.connect_auth(Direction::Fetch, Some(callbacks), None)?;
    let branch_ref = format!("refs/heads/{branch}");
    let sha = remote
        .list()?
        .iter()
        .find(|head| head.name() == branch_ref || head.name() == branch)
        .map(|head| head.oid().to_string())
        .ok_or_else(|| UpdaterError::Git(format!("remote branch not found: {url} {branch}")))?;
    remote.disconnect()?;
    Ok(sha)
}

/// Handles the android cpp branch for workflow.
fn android_cpp_branch_for(arch: &str) -> UpdaterResult<String> {
    match arch {
        "aarch64" | "arm64" => Ok("android-arm64-v8a".to_string()),
        "x86_64" | "amd64" => Ok("android-x86_64".to_string()),
        other => Err(UpdaterError::Git(format!(
            "unsupported Android Cpp repository architecture: {other}"
        ))),
    }
}

/// Performs the sync git2 worktree operation.
fn sync_git2_worktree(
    url: &str,
    branch: &str,
    target_dir: &Path,
    output: &(dyn OutputSink + Send + Sync),
) -> UpdaterResult<(UpdateStatus, String)> {
    configure_android_git2_ssl(output)?;

    if can_clone_into(target_dir) {
        if target_dir.exists() {
            fs::remove_dir(target_dir)?;
        }
        clone_git2_worktree(url, branch, target_dir, output)?;
        let repo = Repository::open(target_dir)?;
        let sha = head_sha(&repo)?;
        return Ok((UpdateStatus::Installed, sha));
    }

    fs::create_dir_all(target_dir)?;
    let repo = open_or_init_repository(target_dir, output)?;
    let before = head_oid(&repo).ok();
    fetch_and_reset_git2(&repo, url, branch, output)?;
    let sha = head_sha(&repo)?;
    let after = Oid::from_str(&sha).ok();
    let status = match (before, after) {
        (None, _) => UpdateStatus::Installed,
        (Some(before), Some(after)) if before == after => UpdateStatus::Skipped,
        _ => UpdateStatus::Updated,
    };
    Ok((status, sha))
}

/// Handles the configure android git2 ssl workflow.
#[cfg(target_os = "android")]
fn configure_android_git2_ssl(output: &(dyn OutputSink + Send + Sync)) -> UpdaterResult<()> {
    static SSL_CERT_DIR_RESULT: std::sync::OnceLock<Result<Option<String>, String>> =
        std::sync::OnceLock::new();

    let result = SSL_CERT_DIR_RESULT.get_or_init(|| {
        unsafe {
            git2::opts::set_server_connect_timeout_in_milliseconds(8_000)
                .map_err(|error| format!("failed to configure git2 connect timeout: {error}"))?;
            git2::opts::set_server_timeout_in_milliseconds(20_000)
                .map_err(|error| format!("failed to configure git2 server timeout: {error}"))?;
        }
        for cert_dir in [
            "/system/etc/security/cacerts",
            "/apex/com.android.conscrypt/cacerts",
        ] {
            if Path::new(cert_dir).is_dir() {
                return Ok(Some(cert_dir.to_string()));
            }
        }
        Ok(None)
    });

    match result {
        Ok(Some(cert_dir)) => {
            let message = format!(
                "Android system CA store detected at {cert_dir}; using restricted git2 certificate callback"
            );
            output.line(OutputStyle::Info, &message);
            Ok(())
        }
        Ok(None) => {
            output.line(
                OutputStyle::Warning,
                "Android system CA store was not found; using restricted git2 certificate callback",
            );
            Ok(())
        }
        Err(error) => Err(UpdaterError::Git(error.clone())),
    }
}

/// Handles the configure android git2 ssl workflow.
#[cfg(not(target_os = "android"))]
fn configure_android_git2_ssl(_output: &(dyn OutputSink + Send + Sync)) -> UpdaterResult<()> {
    Ok(())
}

/// Returns the can clone into result.
fn can_clone_into(target_dir: &Path) -> bool {
    if !target_dir.exists() {
        return true;
    }
    if target_dir.join(".git").exists() {
        return false;
    }
    fs::read_dir(target_dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

/// Handles the clone git2 worktree workflow.
fn clone_git2_worktree(
    url: &str,
    branch: &str,
    target_dir: &Path,
    output: &(dyn OutputSink + Send + Sync),
) -> UpdaterResult<()> {
    if let Some(parent) = target_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut fetch_options = android_fetch_options(output);
    fetch_options.depth(1);
    let mut builder = RepoBuilder::new();
    builder.fetch_options(fetch_options);
    builder.branch(branch);
    builder.clone(url, target_dir)?;
    Ok(())
}

/// Performs the open or init repository operation.
fn open_or_init_repository(
    target_dir: &Path,
    output: &(dyn OutputSink + Send + Sync),
) -> UpdaterResult<Repository> {
    match Repository::open(target_dir) {
        Ok(repo) => Ok(repo),
        Err(_) => {
            if target_dir.join(".git").exists() {
                output.line(
                    OutputStyle::Warning,
                    "Existing .git metadata is unreadable; replacing only .git metadata",
                );
                fs::remove_dir_all(target_dir.join(".git"))?;
            }
            output.line(
                OutputStyle::Info,
                "Initializing git2 repository in existing Android app data directory",
            );
            Ok(Repository::init(target_dir)?)
        }
    }
}

/// Handles the fetch and reset git2 workflow.
fn fetch_and_reset_git2(
    repo: &Repository,
    url: &str,
    branch: &str,
    output: &(dyn OutputSink + Send + Sync),
) -> UpdaterResult<()> {
    if repo.find_remote("origin").is_ok() {
        repo.remote_set_url("origin", url)?;
    } else {
        repo.remote("origin", url)?;
    }
    let mut remote = repo.find_remote("origin")?;
    let mut fetch_options = android_fetch_options(output);
    fetch_options.depth(1);
    remote.fetch(&[branch], Some(&mut fetch_options), None)?;
    let fetch_head = repo.find_reference("FETCH_HEAD")?;
    let object = fetch_head.peel(git2::ObjectType::Commit)?;
    let commit_id = object.id();
    let branch_ref = format!("refs/heads/{branch}");
    repo.reference(&branch_ref, commit_id, true, "Android git2 update")?;
    repo.set_head(&branch_ref)?;
    repo.reset(&object, git2::ResetType::Hard, None)?;
    Ok(())
}

/// Handles the android fetch options workflow.
fn android_fetch_options(output: &(dyn OutputSink + Send + Sync)) -> FetchOptions<'_> {
    let callbacks = android_remote_callbacks(output);
    let mut options = FetchOptions::new();
    options.remote_callbacks(callbacks);
    options
}

/// Handles the android remote callbacks workflow.
fn android_remote_callbacks(output: &(dyn OutputSink + Send + Sync)) -> RemoteCallbacks<'_> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.certificate_check(|_, host| {
        if is_allowed_android_git_host(host) {
            Ok(CertificateCheckStatus::CertificateOk)
        } else {
            Ok(CertificateCheckStatus::CertificatePassthrough)
        }
    });
    let term = output.thread_output().cloned();
    let mut progress: Option<ThreadProgressBar> = None;
    callbacks.transfer_progress(move |stats| {
        let total = stats.total_objects() as u64;
        let received = stats.received_objects() as u64;
        if total > 0 {
            if progress.is_none()
                && let Some(term) = term.clone()
            {
                progress = Some(term.progress_bar("git2 transfer", total, 30));
            }
            if let Some(progress_bar) = progress.as_mut() {
                progress_bar.set(received, format!("{received}/{total} objects"));
                if received >= total {
                    progress_bar.finish(ThreadLogStyle::Success, "git2 transfer complete");
                    progress = None;
                }
            }
        }
        true
    });
    callbacks
}

/// Returns the is allowed android git host result.
fn is_allowed_android_git_host(host: &str) -> bool {
    let host = host
        .split(':')
        .next()
        .unwrap_or(host)
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    matches!(
        host.as_str(),
        "github.com"
            | "gitee.com"
            | "gitcode.com"
            | "v4.gh-proxy.org"
            | "v6.gh-proxy.org"
            | "cdn.gh-proxy.org"
            | "gh-proxy.org"
            | "gh.sevencdn.com"
            | "githubfast.com"
            | "baas-cdn.kiramei.workers.dev"
    )
}

/// Returns the is git repository result.
fn is_git_repository(target_dir: &Path) -> bool {
    target_dir.join(".git").exists() && Repository::open(target_dir).is_ok()
}

/// Handles the head oid workflow.
fn head_oid(repo: &Repository) -> UpdaterResult<Oid> {
    Ok(repo.head()?.peel_to_commit()?.id())
}

/// Handles the head sha workflow.
fn head_sha(repo: &Repository) -> UpdaterResult<String> {
    Ok(head_oid(repo)?.to_string())
}

/// Handles the android finalize task workflow.
fn android_finalize_task(
    output: baas_term::threader::ThreadOutput,
    cancelled: Arc<AtomicBool>,
    state: Arc<Mutex<AndroidWorkflowState>>,
) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("android finalize task cancelled".to_string());
    }
    let mut state = state
        .lock()
        .map_err(|_| "android workflow state lock poisoned".to_string())?;
    let main = state
        .main_outcome
        .clone()
        .ok_or_else(|| "main repository outcome missing".to_string())?;
    let cpp = state
        .cpp_outcome
        .clone()
        .ok_or_else(|| "cpp repository outcome missing".to_string())?;
    let manager = state
        .manager
        .as_mut()
        .ok_or_else(|| "android configuration not initialized".to_string())?;
    manager
        .update(|config| {
            config.general.current_baas_sha = main.sha.clone();
            config.general.current_baas_cpp_sha = cpp.sha.clone();
            config.general.git_backend = GitBackend::Git2;
        })
        .map_err(|error| error.message())?;
    output.line(
        OutputStyle::Info,
        &format!(
            "main: {} {} from {}",
            update_status_text(&main.status),
            short_sha(&main.sha),
            main.source_url
        ),
    );
    output.line(
        OutputStyle::Info,
        &format!(
            "cpp: {} {} from {}",
            update_status_text(&cpp.status),
            short_sha(&cpp.sha),
            cpp.source_url
        ),
    );
    output.line(
        OutputStyle::Success,
        "Android repository versions persisted",
    );
    Ok(())
}

/// Performs the wait for android task operation.
fn wait_for_android_task(completion_rx: &mpsc::Receiver<TaskCompletion>, task_id: &str) -> bool {
    baas_term::common::wait_for_completion(completion_rx, task_id)
        .map(|completion| completion.success)
        .unwrap_or(false)
}

/// Handles the finish android session workflow.
fn finish_android_session(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    renderer_tx: &Sender<RendererEvent>,
    success: bool,
) {
    if session_is_current(inner, session_id) {
        let _ = renderer_tx.send(RendererEvent::SessionFinished { success });
    }
}

/// Performs the update status text operation.
fn update_status_text(status: &UpdateStatus) -> &'static str {
    match status {
        UpdateStatus::Installed => "installed",
        UpdateStatus::Updated => "updated",
        UpdateStatus::Skipped => "already up to date",
    }
}

/// Handles the short sha workflow.
fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Handles the android cpp branch maps supported abis workflow.
    #[test]
    fn android_cpp_branch_maps_supported_abis() {
        assert_eq!(
            android_cpp_branch_for("aarch64").unwrap(),
            "android-arm64-v8a"
        );
        assert_eq!(android_cpp_branch_for("x86_64").unwrap(), "android-x86_64");
        assert!(android_cpp_branch_for("arm").is_err());
    }

    /// Handles the android targets keep main repo at root workflow.
    #[test]
    fn android_targets_keep_main_repo_at_root() {
        let root = Path::new("/data/user/0/io.github.kiramei.baas_tauri/files");
        assert_eq!(android_repository_target(root, RepositoryKind::Main), root);
        assert_eq!(
            android_repository_target(root, RepositoryKind::Cpp),
            root.join("core")
                .join("ocr")
                .join("baas_ocr_client")
                .join("bin")
        );
    }
}
