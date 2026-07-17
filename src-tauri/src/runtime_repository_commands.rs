use crate::{
    commands::{
        available_backend_port, cleanup_started_backend_checked, ensure_default_config,
        read_runtime_repository_generation, running_managed_backend_runtime,
        start_cpp_backend_detached, track_and_wait_backend, BackendOperationManager,
        BackendProcessManager,
    },
    pipe_commands::BackendPipeManager,
    system_logs::system_log,
};
use baas_updater::config::{BackendRuntime, UpdaterConfig};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

pub const RUNTIME_REPOSITORY_ENVELOPE_MAX_BYTES: usize = 128 * 1_024;
const RUNTIME_REPOSITORY_UPDATER_STDOUT_MAX_BYTES: usize = 64 * 1_024;
const RUNTIME_REPOSITORY_UPDATER_STDERR_MAX_BYTES: usize = 8 * 1_024;
const RUNTIME_REPOSITORY_UPDATER_TIMEOUT: Duration = Duration::from_secs(120);

#[cfg(target_os = "windows")]
const RUNTIME_REPOSITORY_UPDATER_NAME: &str = "BAAS_runtime_repository_update.exe";
#[cfg(not(target_os = "windows"))]
const RUNTIME_REPOSITORY_UPDATER_NAME: &str = "BAAS_runtime_repository_update";

/// The browser-facing shape deliberately contains one opaque value only.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRepositoryApplySignedPlanRequest {
    pub envelope: RuntimeRepositorySignedEnvelope,
}

/// Tauri callers may send the UTF-8 envelope as a string or an exact byte array.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum RuntimeRepositorySignedEnvelope {
    Utf8(String),
    Bytes(Vec<u8>),
}

impl RuntimeRepositorySignedEnvelope {
    fn into_bytes(self) -> Result<Vec<u8>, RuntimeRepositoryApplyFailure> {
        let bytes = match self {
            Self::Utf8(value) => value.into_bytes(),
            Self::Bytes(value) => value,
        };
        if bytes.is_empty() {
            return Err(RuntimeRepositoryApplyFailure::request(
                "empty_envelope",
                "The signed plan envelope is empty.",
            ));
        }
        if bytes.len() > RUNTIME_REPOSITORY_ENVELOPE_MAX_BYTES {
            return Err(RuntimeRepositoryApplyFailure::request(
                "envelope_too_large",
                "The signed plan envelope exceeds 128 KiB.",
            ));
        }
        if std::str::from_utf8(&bytes).is_err() {
            return Err(RuntimeRepositoryApplyFailure::request(
                "envelope_not_utf8",
                "The signed plan envelope is not UTF-8.",
            ));
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeRepositoryBackendOutcome {
    PythonUnchanged,
    CppRestarted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRepositoryApplyReport {
    pub generation: String,
    pub disposition: String,
    pub backend_outcome: RuntimeRepositoryBackendOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_backend_addr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_backend_port: Option<u16>,
}

/// A bounded, non-sensitive failure report. Repository URLs, local paths, and
/// child diagnostics are intentionally never reflected to the browser.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRepositoryApplyFailure {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollback: Option<String>,
}

impl RuntimeRepositoryApplyFailure {
    fn request(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            published_generation: None,
            active_generation: None,
            rollback: None,
        }
    }

    fn publication(code: &str, message: &str) -> Self {
        Self::request(code, message)
    }

    fn restart(
        code: &str,
        message: String,
        published_generation: &str,
        active_generation: Option<String>,
        rollback: &str,
    ) -> Self {
        Self {
            code: code.to_string(),
            message,
            published_generation: Some(published_generation.to_string()),
            active_generation,
            rollback: Some(rollback.to_string()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeRepositoryUpdaterOutput {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    owner_error: Option<String>,
    #[serde(default)]
    plan_error: Option<String>,
    #[serde(default)]
    state_error: Option<String>,
    #[serde(default)]
    update_error: Option<String>,
    #[serde(default)]
    disposition: Option<String>,
    #[serde(default)]
    generation: Option<String>,
}

#[derive(Debug)]
struct RuntimeRepositoryUpdaterProcessResult {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Applies one publisher-signed plan. This command exists only in desktop
/// builds; mobile neither registers it nor receives its permission.
#[tauri::command]
pub async fn runtime_repository_apply_signed_plan(
    app: AppHandle,
    request: RuntimeRepositoryApplySignedPlanRequest,
    operations: State<'_, BackendOperationManager>,
    backend: State<'_, BackendProcessManager>,
    pipe: State<'_, BackendPipeManager>,
) -> Result<RuntimeRepositoryApplyReport, RuntimeRepositoryApplyFailure> {
    let envelope = request.envelope.into_bytes()?;
    let operations = operations.inner().clone();
    let backend = backend.inner().clone();
    let pipe = pipe.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_signed_plan_blocking(&app, &operations, &backend, &pipe, envelope)
    })
    .await
    .map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "update_task_failed",
            "The native repository update task did not complete.",
        )
    })?
}

fn apply_signed_plan_blocking(
    app: &AppHandle,
    operations: &BackendOperationManager,
    backend: &BackendProcessManager,
    pipe: &BackendPipeManager,
    envelope: Vec<u8>,
) -> Result<RuntimeRepositoryApplyReport, RuntimeRepositoryApplyFailure> {
    let _operation = operations.lock().map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "update_lock_failed",
            "The runtime repository update coordinator is unavailable.",
        )
    })?;
    let config_manager = ensure_default_config(app).map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "project_root_unavailable",
            "The application-owned project root is unavailable.",
        )
    })?;
    let config = config_manager.config;
    let project_root = config.baas_root().canonicalize().map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "project_root_unavailable",
            "The application-owned project root is unavailable.",
        )
    })?;
    if !project_root.is_dir() {
        return Err(RuntimeRepositoryApplyFailure::publication(
            "project_root_unavailable",
            "The application-owned project root is unavailable.",
        ));
    }
    let updater = resolve_runtime_repository_updater(app)?;
    let previous_generation = read_runtime_repository_generation(&config).ok();
    let python_running = if config.general.backend_runtime == BackendRuntime::Cpp {
        running_managed_backend_runtime(&config).map_err(|_| {
            RuntimeRepositoryApplyFailure::publication(
                "managed_backend_state_unavailable",
                "The running backend identity could not be validated.",
            )
        })? == Some(BackendRuntime::Python)
    } else {
        true
    };

    system_log(
        "INFO",
        "runtime_repository",
        "Applying one opaque signed runtime repository plan",
    );
    let process = run_runtime_repository_updater(
        &updater,
        &project_root,
        &envelope,
        RUNTIME_REPOSITORY_UPDATER_TIMEOUT,
    )?;
    let machine = parse_updater_output(&process.stdout)?;
    let committed_durability_uncertain =
        is_committed_durability_uncertain(&process.status, &machine);
    if (!process.status.success() || !machine.ok) && !committed_durability_uncertain {
        let stable_error = machine.error.as_deref().unwrap_or("publisher_failed");
        system_log(
            "WARN",
            "runtime_repository",
            format!(
                "Runtime repository publisher rejected the plan class={stable_error} status={:?} stderr_bytes={}",
                process.status.code(),
                process.stderr.len()
            ),
        );
        return Err(RuntimeRepositoryApplyFailure::publication(
            "publisher_rejected",
            "The native publisher did not commit the signed repository plan.",
        ));
    }
    if machine.ok
        && (machine.error.is_some()
            || machine.owner_error.is_some()
            || machine.plan_error.is_some()
            || machine.state_error.is_some()
            || machine.update_error.is_some())
    {
        return Err(RuntimeRepositoryApplyFailure::publication(
            "publisher_output_invalid",
            "The native publisher returned an invalid success result.",
        ));
    }
    let generation = machine.generation.ok_or_else(|| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_output_invalid",
            "The native publisher omitted the published generation.",
        )
    })?;
    crate::commands::validate_runtime_repository_generation(&generation).map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_output_invalid",
            "The native publisher returned an invalid generation.",
        )
    })?;
    let disposition = machine.disposition.ok_or_else(|| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_output_invalid",
            "The native publisher omitted the publication disposition.",
        )
    })?;
    if !matches!(
        disposition.as_str(),
        "committed" | "not_committed" | "committed_durability_uncertain"
    ) {
        return Err(RuntimeRepositoryApplyFailure::publication(
            "publisher_output_invalid",
            "The native publisher returned an invalid publication disposition.",
        ));
    }

    // Never trust stdout as the handoff. Re-open the exact store and validate
    // its current pointer, snapshot, manifests, and generation again.
    let published_generation = read_runtime_repository_generation(&config).map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "publication_validation_failed",
            "The published runtime repository could not be validated.",
        )
    })?;
    if published_generation != generation {
        return Err(RuntimeRepositoryApplyFailure::publication(
            "publication_generation_mismatch",
            "The validated published generation does not match the native publisher result.",
        ));
    }
    if committed_durability_uncertain {
        system_log(
            "WARN",
            "runtime_repository",
            format!(
                "Native publisher reported uncertain durability; independently validated committed generation {generation}"
            ),
        );
    }

    if !should_restart_cpp_after_publication(config.general.backend_runtime, python_running) {
        system_log(
            "INFO",
            "runtime_repository",
            format!(
                "Runtime repository generation {generation} published; Python backend unchanged"
            ),
        );
        return Ok(RuntimeRepositoryApplyReport {
            generation,
            disposition,
            backend_outcome: RuntimeRepositoryBackendOutcome::PythonUnchanged,
            base_backend_addr: None,
            base_backend_port: None,
        });
    }

    restart_cpp_after_publication(
        app,
        backend,
        pipe,
        &config,
        &generation,
        previous_generation.as_deref(),
        disposition,
    )
}

fn restart_cpp_after_publication(
    app: &AppHandle,
    backend: &BackendProcessManager,
    pipe: &BackendPipeManager,
    config: &UpdaterConfig,
    generation: &str,
    previous_generation: Option<&str>,
    disposition: String,
) -> Result<RuntimeRepositoryApplyReport, RuntimeRepositoryApplyFailure> {
    backend.stop_for_config(config).map_err(|_| {
        RuntimeRepositoryApplyFailure::restart(
            "cpp_stop_failed",
            "The new generation was published, but the managed C++ backend could not be stopped."
                .to_string(),
            generation,
            None,
            "not_attempted",
        )
    })?;
    if pipe.close_all().is_err() {
        return Err(report_cpp_rollback_unavailable(
            generation,
            previous_generation,
            "cpp_transport_close_failed",
            "The new generation was published, but the previous transport could not be closed.",
        ));
    }
    thread::sleep(Duration::from_millis(300));
    let port = match available_backend_port() {
        Ok(port) => port,
        Err(_) => {
            return Err(report_cpp_rollback_unavailable(
                generation,
                previous_generation,
                "cpp_restart_port_failed",
                "The new generation was published, but no C++ restart port was available.",
            ));
        }
    };
    let mut started = false;
    let restart = start_cpp_backend_detached(app, config, port, generation)
        .map(|()| started = true)
        .and_then(|()| {
            track_and_wait_backend(backend, config, port, BackendRuntime::Cpp, Some(generation))
        });
    if restart.is_err() {
        if cleanup_started_backend_checked(config, started).is_err() {
            return Err(report_cpp_cleanup_failed(generation, previous_generation));
        }
        return Err(report_cpp_rollback_unavailable(
            generation,
            previous_generation,
            "cpp_restart_failed",
            "The new generation was published, but the C++ backend did not become ready.",
        ));
    }
    system_log(
        "INFO",
        "runtime_repository",
        format!("C++ backend restarted on validated generation {generation}"),
    );
    Ok(RuntimeRepositoryApplyReport {
        generation: generation.to_string(),
        disposition,
        backend_outcome: RuntimeRepositoryBackendOutcome::CppRestarted,
        base_backend_addr: Some("127.0.0.1".to_string()),
        base_backend_port: Some(port),
    })
}

fn should_restart_cpp_after_publication(selected: BackendRuntime, python_running: bool) -> bool {
    selected == BackendRuntime::Cpp && !python_running
}

fn report_cpp_rollback_unavailable(
    published_generation: &str,
    previous_generation: Option<&str>,
    code: &str,
    message: &str,
) -> RuntimeRepositoryApplyFailure {
    let Some(previous_generation) = previous_generation else {
        return RuntimeRepositoryApplyFailure::restart(
            code,
            format!("{message} No previous validated generation was available for rollback."),
            published_generation,
            None,
            "unavailable_no_previous_generation",
        );
    };
    if previous_generation == published_generation {
        return RuntimeRepositoryApplyFailure::restart(
            code,
            format!("{message} The previous and published generations are identical."),
            published_generation,
            None,
            "not_applicable_same_generation",
        );
    }
    system_log(
        "ERROR",
        "runtime_repository",
        format!(
            "Published generation {published_generation} could not be activated; previous generation {previous_generation} was not started because current.json still selects the publication and no native trusted rollback entry exists"
        ),
    );
    RuntimeRepositoryApplyFailure::restart(
        code,
        format!(
            "{message} The previous C++ generation was not started because rollback requires a native trusted pointer-and-policy transaction that is not yet exposed."
        ),
        published_generation,
        None,
        "unavailable_requires_native_trusted_rollback",
    )
}

fn report_cpp_cleanup_failed(
    published_generation: &str,
    previous_generation: Option<&str>,
) -> RuntimeRepositoryApplyFailure {
    system_log(
        "ERROR",
        "runtime_repository",
        format!(
            "Published generation {published_generation} failed readiness and its rejected C++ process could not be confirmed stopped; previous generation {} was not started",
            previous_generation.unwrap_or("unavailable")
        ),
    );
    RuntimeRepositoryApplyFailure::restart(
        "cpp_restart_cleanup_failed",
        "The new C++ generation did not become ready and its process could not be confirmed stopped. The published generation may still be active; trusted rollback was not attempted."
            .to_string(),
        published_generation,
        Some(published_generation.to_string()),
        "unavailable_cleanup_failed_process_may_be_running",
    )
}

fn resolve_runtime_repository_updater(
    app: &AppHandle,
) -> Result<PathBuf, RuntimeRepositoryApplyFailure> {
    let resource_dir = app.path().resource_dir().map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "updater_resource_unavailable",
            "The packaged runtime repository publisher is unavailable.",
        )
    })?;
    validate_owned_runtime_repository_updater(&resource_dir, RUNTIME_REPOSITORY_UPDATER_NAME)
}

fn validate_owned_runtime_repository_updater(
    resource_dir: &Path,
    expected_name: &str,
) -> Result<PathBuf, RuntimeRepositoryApplyFailure> {
    let owner = resource_dir.canonicalize().map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "updater_resource_unavailable",
            "The packaged runtime repository publisher is unavailable.",
        )
    })?;
    let candidate = resource_dir.join(expected_name);
    let metadata = fs::symlink_metadata(&candidate).map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "updater_resource_unavailable",
            "The packaged runtime repository publisher is unavailable.",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(RuntimeRepositoryApplyFailure::publication(
            "updater_resource_invalid",
            "The packaged runtime repository publisher failed ownership validation.",
        ));
    }
    let canonical = candidate.canonicalize().map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "updater_resource_invalid",
            "The packaged runtime repository publisher failed ownership validation.",
        )
    })?;
    if canonical != owner.join(expected_name)
        || canonical.parent() != Some(owner.as_path())
        || canonical.file_name().and_then(|name| name.to_str()) != Some(expected_name)
    {
        return Err(RuntimeRepositoryApplyFailure::publication(
            "updater_resource_invalid",
            "The packaged runtime repository publisher failed ownership validation.",
        ));
    }
    Ok(canonical)
}

fn run_runtime_repository_updater(
    executable: &Path,
    project_root: &Path,
    envelope: &[u8],
    timeout: Duration,
) -> Result<RuntimeRepositoryUpdaterProcessResult, RuntimeRepositoryApplyFailure> {
    let mut command = Command::new(executable);
    command
        .arg("--project-root")
        .arg(project_root)
        .current_dir(project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_spawn_failed",
            "The packaged runtime repository publisher could not be started.",
        )
    })?;
    let stdin = child.stdin.take().ok_or_else(|| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_pipe_failed",
            "The native publisher input pipe is unavailable.",
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_pipe_failed",
            "The native publisher output pipe is unavailable.",
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_pipe_failed",
            "The native publisher diagnostics pipe is unavailable.",
        )
    })?;

    let input = envelope.to_vec();
    let writer = thread::spawn(move || -> std::io::Result<()> {
        let mut stdin = stdin;
        stdin.write_all(&input)?;
        stdin.flush()
    });
    let stdout_reader = thread::spawn(move || {
        read_bounded_stream(stdout, RUNTIME_REPOSITORY_UPDATER_STDOUT_MAX_BYTES)
    });
    let stderr_reader = thread::spawn(move || {
        read_bounded_stream(stderr, RUNTIME_REPOSITORY_UPDATER_STDERR_MAX_BYTES)
    });

    let status = wait_child_bounded(&mut child, timeout)?;
    let input_result = writer.join().map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_pipe_failed",
            "The native publisher input task failed.",
        )
    })?;
    let stdout = stdout_reader.join().map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_pipe_failed",
            "The native publisher output task failed.",
        )
    })??;
    let stderr = stderr_reader.join().map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_pipe_failed",
            "The native publisher diagnostics task failed.",
        )
    })??;
    if input_result.is_err() && status.success() {
        return Err(RuntimeRepositoryApplyFailure::publication(
            "publisher_input_failed",
            "The complete signed envelope was not delivered to the native publisher.",
        ));
    }
    Ok(RuntimeRepositoryUpdaterProcessResult {
        status,
        stdout,
        stderr,
    })
}

fn wait_child_bounded(
    child: &mut Child,
    timeout: Duration,
) -> Result<ExitStatus, RuntimeRepositoryApplyFailure> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(_) => {
                return Err(terminate_and_report_child(
                    child,
                    "publisher_wait_failed",
                    "The native publisher process state could not be read.",
                ));
            }
        }
        if Instant::now() >= deadline {
            return Err(terminate_and_report_child(
                child,
                "publisher_timeout",
                "The native publisher exceeded its bounded execution time.",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn terminate_and_report_child(
    child: &mut Child,
    code: &str,
    message: &str,
) -> RuntimeRepositoryApplyFailure {
    terminate_and_report_child_with_timeout(child, code, message, Duration::from_secs(2))
}

trait PublisherChildControl {
    fn kill_child(&mut self) -> std::io::Result<()>;
    fn try_reap_child(&mut self) -> std::io::Result<bool>;
}

impl PublisherChildControl for Child {
    fn kill_child(&mut self) -> std::io::Result<()> {
        self.kill()
    }

    fn try_reap_child(&mut self) -> std::io::Result<bool> {
        self.try_wait().map(|status| status.is_some())
    }
}

fn terminate_and_report_child_with_timeout(
    child: &mut impl PublisherChildControl,
    code: &str,
    message: &str,
    reap_timeout: Duration,
) -> RuntimeRepositoryApplyFailure {
    let _kill_result = child.kill_child();
    let reap_deadline = Instant::now() + reap_timeout;
    while Instant::now() < reap_deadline {
        match child.try_reap_child() {
            Ok(true) => return RuntimeRepositoryApplyFailure::publication(code, message),
            Ok(false) | Err(_) => thread::sleep(Duration::from_millis(10)),
        }
    }
    RuntimeRepositoryApplyFailure::publication(
        "publisher_termination_failed",
        "The native publisher could not be reliably terminated and reaped; its process state is unknown.",
    )
}

fn read_bounded_stream(
    mut reader: impl Read,
    limit: usize,
) -> Result<Vec<u8>, RuntimeRepositoryApplyFailure> {
    let mut output = Vec::new();
    let mut exceeded = false;
    let mut buffer = [0_u8; 4 * 1_024];
    loop {
        let read = reader.read(&mut buffer).map_err(|_| {
            RuntimeRepositoryApplyFailure::publication(
                "publisher_output_failed",
                "The native publisher output could not be read.",
            )
        })?;
        if read == 0 {
            break;
        }
        if output.len().saturating_add(read) <= limit {
            output.extend_from_slice(&buffer[..read]);
        } else {
            exceeded = true;
        }
    }
    if exceeded {
        Err(RuntimeRepositoryApplyFailure::publication(
            "publisher_output_too_large",
            "The native publisher exceeded its bounded output size.",
        ))
    } else {
        Ok(output)
    }
}

fn parse_updater_output(
    bytes: &[u8],
) -> Result<RuntimeRepositoryUpdaterOutput, RuntimeRepositoryApplyFailure> {
    if bytes.is_empty() || std::str::from_utf8(bytes).is_err() {
        return Err(RuntimeRepositoryApplyFailure::publication(
            "publisher_output_invalid",
            "The native publisher returned invalid machine output.",
        ));
    }
    serde_json::from_slice(bytes).map_err(|_| {
        RuntimeRepositoryApplyFailure::publication(
            "publisher_output_invalid",
            "The native publisher returned invalid machine output.",
        )
    })
}

fn is_committed_durability_uncertain(
    status: &ExitStatus,
    machine: &RuntimeRepositoryUpdaterOutput,
) -> bool {
    !status.success()
        && !machine.ok
        && machine.disposition.as_deref() == Some("committed_durability_uncertain")
        && machine.generation.as_deref().is_some_and(|generation| {
            crate::commands::validate_runtime_repository_generation(generation).is_ok()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    const GENERATION: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn request_accepts_only_one_opaque_utf8_envelope() {
        let string: RuntimeRepositoryApplySignedPlanRequest =
            serde_json::from_str(r#"{"envelope":"signed"}"#).unwrap();
        assert_eq!(string.envelope.into_bytes().unwrap(), b"signed");
        let bytes: RuntimeRepositoryApplySignedPlanRequest =
            serde_json::from_str(r#"{"envelope":[115,105,103,110,101,100]}"#).unwrap();
        assert_eq!(bytes.envelope.into_bytes().unwrap(), b"signed");
        for forbidden in ["url", "ref", "commit", "key", "path", "generation"] {
            let value = format!(r#"{{"envelope":"signed","{forbidden}":"value"}}"#);
            assert!(
                serde_json::from_str::<RuntimeRepositoryApplySignedPlanRequest>(&value).is_err()
            );
        }
    }

    #[test]
    fn request_enforces_utf8_and_exact_128_kib_limit() {
        assert!(RuntimeRepositorySignedEnvelope::Bytes(vec![
            b'a';
            RUNTIME_REPOSITORY_ENVELOPE_MAX_BYTES
        ])
        .into_bytes()
        .is_ok());
        assert_eq!(
            RuntimeRepositorySignedEnvelope::Bytes(vec![
                b'a';
                RUNTIME_REPOSITORY_ENVELOPE_MAX_BYTES + 1
            ])
            .into_bytes()
            .unwrap_err()
            .code,
            "envelope_too_large"
        );
        assert_eq!(
            RuntimeRepositorySignedEnvelope::Bytes(vec![0xff])
                .into_bytes()
                .unwrap_err()
                .code,
            "envelope_not_utf8"
        );
    }

    #[test]
    fn owned_updater_path_rejects_renames_and_symlink_escape() {
        let root = tempdir().unwrap();
        let owner = root.path().join("resources");
        let outside = root.path().join("outside");
        fs::create_dir_all(&owner).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let expected = owner.join(RUNTIME_REPOSITORY_UPDATER_NAME);
        fs::write(&expected, b"publisher").unwrap();
        assert_eq!(
            validate_owned_runtime_repository_updater(&owner, RUNTIME_REPOSITORY_UPDATER_NAME)
                .unwrap(),
            expected.canonicalize().unwrap()
        );
        assert!(validate_owned_runtime_repository_updater(&owner, "renamed-updater").is_err());

        fs::remove_file(&expected).unwrap();
        let target = outside.join(RUNTIME_REPOSITORY_UPDATER_NAME);
        fs::write(&target, b"outside").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &expected).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&target, &expected).is_err() {
            return;
        }
        assert!(
            validate_owned_runtime_repository_updater(&owner, RUNTIME_REPOSITORY_UPDATER_NAME)
                .is_err()
        );
    }

    #[test]
    fn machine_output_is_strict_and_generation_bound() {
        let output =
            format!(r#"{{"ok":true,"disposition":"committed","generation":"{GENERATION}"}}"#);
        let parsed = parse_updater_output(output.as_bytes()).unwrap();
        assert!(parsed.ok);
        assert_eq!(parsed.generation.as_deref(), Some(GENERATION));
        assert!(parse_updater_output(
            format!(r#"{{"ok":true,"disposition":"committed","generation":"{GENERATION}","url":"forbidden"}}"#)
                .as_bytes()
        )
        .is_err());
        assert!(parse_updater_output(b"not-json").is_err());
    }

    #[test]
    fn restart_failure_reports_native_trusted_rollback_as_unavailable() {
        let failure = report_cpp_rollback_unavailable(
            GENERATION,
            Some(&"f".repeat(64)),
            "cpp_restart_failed",
            "restart failed",
        );
        let value = serde_json::to_value(failure).unwrap();
        assert_eq!(value["publishedGeneration"], GENERATION);
        assert!(value.get("activeGeneration").is_none());
        assert_eq!(
            value["rollback"],
            "unavailable_requires_native_trusted_rollback"
        );
    }

    #[test]
    fn cleanup_failure_reports_published_generation_as_potentially_active() {
        let failure = report_cpp_cleanup_failed(GENERATION, Some(&"f".repeat(64)));
        let value = serde_json::to_value(failure).unwrap();
        assert_eq!(value["code"], "cpp_restart_cleanup_failed");
        assert_eq!(value["publishedGeneration"], GENERATION);
        assert_eq!(value["activeGeneration"], GENERATION);
        assert_eq!(
            value["rollback"],
            "unavailable_cleanup_failed_process_may_be_running"
        );
    }

    #[test]
    fn output_reader_enforces_bound_without_allocating_unbounded_data() {
        assert_eq!(read_bounded_stream(&b"okay"[..], 4).unwrap(), b"okay");
        assert_eq!(
            read_bounded_stream(&b"oversized"[..], 4).unwrap_err().code,
            "publisher_output_too_large"
        );
    }

    #[test]
    fn update_manager_serializes_concurrent_operations() {
        let manager = BackendOperationManager::default();
        let first = manager.lock().unwrap();
        let other = manager.clone();
        let (sent, received) = std::sync::mpsc::channel();
        let waiter = thread::spawn(move || {
            let _guard = other.lock().unwrap();
            sent.send(()).unwrap();
        });
        assert!(received.recv_timeout(Duration::from_millis(30)).is_err());
        drop(first);
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        waiter.join().unwrap();
    }

    #[test]
    fn python_selection_or_running_python_never_restarts_cpp() {
        assert!(!should_restart_cpp_after_publication(
            BackendRuntime::Python,
            false
        ));
        assert!(!should_restart_cpp_after_publication(
            BackendRuntime::Python,
            true
        ));
        assert!(!should_restart_cpp_after_publication(
            BackendRuntime::Cpp,
            true
        ));
        assert!(should_restart_cpp_after_publication(
            BackendRuntime::Cpp,
            false
        ));
    }

    fn compile_fake_publisher(root: &Path) -> PathBuf {
        let source = root.join("fake_publisher.rs");
        let executable = root.join(RUNTIME_REPOSITORY_UPDATER_NAME);
        fs::write(
            &source,
            r###"
use std::{env, io::{self, Read}, process, thread, time::Duration};
fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 || args[0] != "--project-root" {
        println!(r#"{{"ok":false,"error":"arguments"}}"#);
        process::exit(2);
    }
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    match input.as_str() {
        "timeout" => thread::sleep(Duration::from_secs(5)),
        "crash" => process::exit(9),
        "oversized_stdout" => { print!("{}", "x".repeat(70 * 1024)); return; }
        "oversized_stderr" => { eprint!("{}", "x".repeat(12 * 1024)); return; }
        "nonzero" => {
            println!(r#"{{"ok":false,"error":"update_failed","owner_error":"none","plan_error":"none","state_error":"none","update_error":"io","disposition":"not_committed","generation":""}}"#);
            process::exit(6);
        }
        "uncertain" => {
            println!(r#"{{"ok":false,"error":"update_failed","owner_error":"update_failed","plan_error":"none","state_error":"none","update_error":"io","disposition":"committed_durability_uncertain","generation":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}"#);
            process::exit(6);
        }
        "stdin-only" => {}
        _ => { println!(r#"{{"ok":false,"error":"input"}}"#); process::exit(3); }
    }
    println!(r#"{{"ok":true,"disposition":"committed","generation":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}"#);
}
"###,
        )
        .unwrap();
        let status = Command::new("rustc")
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .status()
            .unwrap();
        assert!(status.success());
        executable
    }

    #[test]
    fn fake_packaged_publisher_receives_envelope_only_on_stdin() {
        let root = tempdir().unwrap();
        compile_fake_publisher(root.path());
        let executable =
            validate_owned_runtime_repository_updater(root.path(), RUNTIME_REPOSITORY_UPDATER_NAME)
                .unwrap();
        let before = fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>();
        let result = run_runtime_repository_updater(
            &executable,
            root.path(),
            b"stdin-only",
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(result.status.success());
        assert_eq!(
            parse_updater_output(&result.stdout)
                .unwrap()
                .generation
                .as_deref(),
            Some(GENERATION)
        );
        assert!(result.stderr.is_empty());
        let after = fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            after, before,
            "the launcher must not create an envelope file"
        );
    }

    #[test]
    fn fake_packaged_publisher_timeout_nonzero_and_output_bounds_fail_closed() {
        let root = tempdir().unwrap();
        compile_fake_publisher(root.path());
        let executable =
            validate_owned_runtime_repository_updater(root.path(), RUNTIME_REPOSITORY_UPDATER_NAME)
                .unwrap();
        assert_eq!(
            run_runtime_repository_updater(
                &executable,
                root.path(),
                b"timeout",
                Duration::from_millis(50),
            )
            .unwrap_err()
            .code,
            "publisher_timeout"
        );
        let crashed = run_runtime_repository_updater(
            &executable,
            root.path(),
            b"crash",
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(!crashed.status.success());
        assert!(parse_updater_output(&crashed.stdout).is_err());
        let nonzero = run_runtime_repository_updater(
            &executable,
            root.path(),
            b"nonzero",
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(nonzero.status.code(), Some(6));
        assert!(!parse_updater_output(&nonzero.stdout).unwrap().ok);
        let uncertain = run_runtime_repository_updater(
            &executable,
            root.path(),
            b"uncertain",
            Duration::from_secs(5),
        )
        .unwrap();
        let uncertain_machine = parse_updater_output(&uncertain.stdout).unwrap();
        assert!(is_committed_durability_uncertain(
            &uncertain.status,
            &uncertain_machine
        ));
        assert_eq!(
            run_runtime_repository_updater(
                &executable,
                root.path(),
                b"oversized_stdout",
                Duration::from_secs(5),
            )
            .unwrap_err()
            .code,
            "publisher_output_too_large"
        );
        assert_eq!(
            run_runtime_repository_updater(
                &executable,
                root.path(),
                b"oversized_stderr",
                Duration::from_secs(5),
            )
            .unwrap_err()
            .code,
            "publisher_output_too_large"
        );
    }

    #[test]
    fn timeout_terminates_and_reaps_the_publisher_before_reporting_stopped() {
        let root = tempdir().unwrap();
        let executable = compile_fake_publisher(root.path());
        let mut child = Command::new(executable)
            .arg("--project-root")
            .arg(root.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"timeout").unwrap();
        drop(stdin);

        let failure = wait_child_bounded(&mut child, Duration::from_millis(50)).unwrap_err();

        assert_eq!(failure.code, "publisher_timeout");
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn failed_kill_without_reap_reports_unknown_process_state() {
        struct UnkillableChild {
            kill_attempted: bool,
        }
        impl PublisherChildControl for UnkillableChild {
            fn kill_child(&mut self) -> std::io::Result<()> {
                self.kill_attempted = true;
                Err(std::io::Error::other("injected kill failure"))
            }

            fn try_reap_child(&mut self) -> std::io::Result<bool> {
                Ok(false)
            }
        }

        let mut child = UnkillableChild {
            kill_attempted: false,
        };
        let failure = terminate_and_report_child_with_timeout(
            &mut child,
            "publisher_timeout",
            "timed out",
            Duration::ZERO,
        );

        assert!(child.kill_attempted);
        assert_eq!(failure.code, "publisher_termination_failed");
        assert!(failure.message.contains("process state is unknown"));
    }

    #[test]
    fn command_is_desktop_main_window_only() {
        const PERMISSION: &str =
            include_str!("../permissions/autogenerated/commands/runtime-repository-commands.toml");
        const CAPABILITY: &str = include_str!("../capabilities/runtime-repository.json");
        const ANDROID: &str = include_str!("../capabilities/android.json");
        const LIB: &str = include_str!("lib.rs");
        assert!(PERMISSION.contains("runtime_repository_apply_signed_plan"));
        assert!(!ANDROID.contains("allow-runtime-repository-apply"));
        let capability: serde_json::Value = serde_json::from_str(CAPABILITY).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert_eq!(
            capability["platforms"],
            serde_json::json!(["windows", "macOS", "linux"])
        );
        assert!(
            LIB.contains("#[cfg(not(mobile))]\n            runtime_repository_apply_signed_plan")
        );
        assert!(
            !include_str!("mobile_commands.rs").contains("runtime_repository_apply_signed_plan")
        );
    }

    #[test]
    fn handoff_rereads_generation_and_cannot_restart_before_success_validation() {
        const SOURCE: &str = include_str!("runtime_repository_commands.rs");
        let reject = SOURCE
            .find("if (!process.status.success() || !machine.ok)")
            .unwrap();
        let reread = SOURCE
            .find("let published_generation = read_runtime_repository_generation(&config)")
            .unwrap();
        let python_unchanged = SOURCE
            .find("!should_restart_cpp_after_publication(")
            .unwrap();
        let cpp_restart = SOURCE.find("restart_cpp_after_publication(").unwrap();
        assert!(reject < reread);
        assert!(reread < python_unchanged);
        assert!(python_unchanged < cpp_restart);
        assert!(SOURCE.contains("if published_generation != generation"));
    }
}
