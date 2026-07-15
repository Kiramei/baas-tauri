//! UV and Python environment setup.

use crate::{
    OutputSink, OutputStyle, UpdaterError, UpdaterResult,
    config::UpdaterConfig,
    constants::{CPYTHON_HEAD, PYPI_SOURCE_LIST, UV_SRC_HEAD},
    repo::{
        SourceProbe, SourceRanking, benchmark_source_probes_with_output,
        benchmark_sources_with_output, save_ranking,
    },
};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
use tar::Archive;
use zip::ZipArchive;

/// Process command specification used by the environment module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSpec {
    /// Program executable.
    pub program: PathBuf,
    /// Program arguments.
    pub args: Vec<String>,
    /// Working directory.
    pub cwd: Option<PathBuf>,
    /// Environment overrides.
    pub env: Vec<(String, String)>,
    /// Whether the process should be spawned and detached instead of waited on.
    pub detached: bool,
    /// Optional pid file written when a detached process starts.
    pub detached_pid_file: Option<PathBuf>,
    /// Additional commands executed serially after this command succeeds.
    pub after: Vec<CommandSpec>,
}

impl CommandSpec {
    /// Creates a new command specification.
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            detached: false,
            detached_pid_file: None,
            after: Vec::new(),
        }
    }

    /// Appends one argument.
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Appends one environment variable.
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// Sets the working directory.
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Marks this command as detached.
    pub fn detached(mut self) -> Self {
        self.detached = true;
        self
    }

    /// Sets the pid file written after a detached process starts.
    pub fn detached_pid_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.detached_pid_file = Some(path.into());
        self
    }

    /// Appends a command to run after this command succeeds.
    pub fn after(mut self, command: CommandSpec) -> Self {
        self.after.push(command);
        self
    }

    /// Returns this command followed by all appended commands as a flat sequence.
    pub fn command_sequence(&self) -> Vec<CommandSpec> {
        let mut primary = self.clone();
        let after = std::mem::take(&mut primary.after);
        let mut commands = vec![primary];
        for command in after {
            commands.extend(command.command_sequence());
        }
        commands
    }
}

/// Runs process commands for environment setup.
pub trait ProcessRunner {
    /// Runs a command and returns an error when it fails.
    fn run<O: OutputSink + ?Sized>(&self, command: &CommandSpec, output: &O) -> UpdaterResult<()>;
}

/// Downloads binary assets.
pub trait AssetDownloader {
    /// Downloads bytes from a URL.
    fn download<O: OutputSink + ?Sized>(&self, url: &str, output: &O) -> UpdaterResult<Vec<u8>>;
}

/// Real process runner using `std::process::Command`.
#[derive(Debug, Clone, Copy, Default)]
pub struct RealProcessRunner;

impl ProcessRunner for RealProcessRunner {
    /// Performs the run operation.
    fn run<O: OutputSink + ?Sized>(&self, command: &CommandSpec, output: &O) -> UpdaterResult<()> {
        for command in command.command_sequence() {
            self.run_single(&command, output)?;
        }
        Ok(())
    }
}

impl RealProcessRunner {
    /// Performs the run single operation.
    fn run_single<O: OutputSink + ?Sized>(
        &self,
        command: &CommandSpec,
        output: &O,
    ) -> UpdaterResult<()> {
        output.line(
            OutputStyle::Info,
            &format!("Running {}", display_command(command)),
        );
        let mut process = Command::new(&command.program);
        process.args(&command.args);
        if let Some(cwd) = &command.cwd {
            process.current_dir(cwd);
        }
        for (key, value) in &command.env {
            process.env(key, value);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            process.creation_flags(0x08000000);
        }
        if command.detached {
            let mut child = process
                .spawn()
                .map_err(|error| UpdaterError::Environment(error.to_string()))?;
            if let Some(pid_file) = &command.detached_pid_file {
                write_detached_pid_file(pid_file, child.id())?;
            }
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }

        let status = process
            .status()
            .map_err(|error| UpdaterError::Environment(error.to_string()))?;
        if status.success() {
            Ok(())
        } else {
            Err(UpdaterError::Environment(format!(
                "command failed: {}",
                display_command(command)
            )))
        }
    }
}

/// Performs the write detached pid file operation.
fn write_detached_pid_file(path: &Path, pid: u32) -> UpdaterResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, pid.to_string())?;
    Ok(())
}

/// Real asset downloader using blocking reqwest.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReqwestDownloader;

impl AssetDownloader for ReqwestDownloader {
    /// Handles the download workflow.
    fn download<O: OutputSink + ?Sized>(&self, url: &str, output: &O) -> UpdaterResult<Vec<u8>> {
        output.line(OutputStyle::Info, &format!("Downloading {url}"));
        let mut response = reqwest::blocking::get(url)
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        let total = response.content_length().unwrap_or(0).max(1);
        let started = Instant::now();
        let mut bytes = Vec::new();
        if let Some(term) = output.thread_output() {
            let label = download_label(url);
            term.with_progress_bar(label, total, 30, "download complete", |progress| {
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    let read = response
                        .read(&mut buffer)
                        .map_err(|error| error.to_string())?;
                    if read == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..read]);
                    progress.set(
                        bytes.len() as u64,
                        download_detail(bytes.len() as u64, total, started),
                    );
                }
                Ok(())
            })
            .map_err(UpdaterError::Network)?;
        } else {
            response
                .read_to_end(&mut bytes)
                .map_err(|error| UpdaterError::Network(error.to_string()))?;
        }
        Ok(bytes)
    }
}

/// Handles the download label workflow.
fn download_label(url: &str) -> String {
    url.rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("download")
        .chars()
        .take(18)
        .collect()
}

/// Handles the download detail workflow.
fn download_detail(current: u64, total: u64, started: Instant) -> String {
    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let speed = current as f64 / elapsed;
    format!(
        "{} / {} at {}/s",
        format_bytes(current),
        format_bytes(total),
        format_bytes(speed as u64)
    )
}

/// Returns the format bytes result.
fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// Environment source list that must be ranked before use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvironmentSourceKind {
    /// UV binary download source.
    Uv,
    /// CPython mirror passed to `UV_PYTHON_INSTALL_MIRROR`.
    Cpython,
    /// Python package index passed to UV pip.
    Pypi,
}

impl EnvironmentSourceKind {
    /// Stable file-name prefix for persisted ranking.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Uv => "uv",
            Self::Cpython => "cpython",
            Self::Pypi => "pypi",
        }
    }
}

/// HTTP source probe used for UV, CPython, and PyPI source ranking.
#[derive(Debug, Clone, Copy, Default)]
pub struct HttpSourceProbe;

impl SourceProbe for HttpSourceProbe {
    /// Handles the measure workflow.
    fn measure(&self, url: &str) -> UpdaterResult<Duration> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        let start = Instant::now();
        let head = client.head(url).send();
        let ok = match head {
            Ok(response)
                if response.status().is_success() || response.status().is_redirection() =>
            {
                true
            }
            _ => client
                .get(url)
                .header(reqwest::header::RANGE, "bytes=0-0")
                .send()
                .map(|response| {
                    response.status().is_success() || response.status().is_redirection()
                })
                .unwrap_or(false),
        };
        if ok {
            Ok(start.elapsed())
        } else {
            Err(UpdaterError::Network(format!(
                "source probe failed for {url}"
            )))
        }
    }
}

/// Environment setup manager.
pub struct EnvironmentManager<R, D> {
    runner: R,
    downloader: D,
}

impl<R: ProcessRunner, D: AssetDownloader> EnvironmentManager<R, D> {
    /// Creates an environment manager.
    pub fn new(runner: R, downloader: D) -> Self {
        Self { runner, downloader }
    }

    /// Prepares UV and Python unless a custom interpreter is configured.
    pub fn prepare<O: OutputSink + ?Sized>(
        &self,
        config: &UpdaterConfig,
        output: &O,
    ) -> UpdaterResult<()> {
        self.prepare_with_ranking(config, None, output)
    }

    /// Prepares UV and Python using ranked UV and CPython sources.
    pub fn prepare_with_ranking<O: OutputSink + ?Sized>(
        &self,
        config: &UpdaterConfig,
        ranking_dir: Option<&Path>,
        output: &O,
    ) -> UpdaterResult<()> {
        if !uses_managed_runtime(config) {
            output.line(
                OutputStyle::Info,
                "Custom Python interpreter configured; skipping managed UV setup",
            );
            return Ok(());
        }

        if !uv_executable(config).exists() {
            let uv_url = ranked_environment_source_with_output(
                EnvironmentSourceKind::Uv,
                config,
                ranking_dir,
                &HttpSourceProbe,
                output,
            )?;
            ensure_uv_installed_from(config, &uv_url, &self.downloader, output)?;
        } else {
            output.line(OutputStyle::Success, "uv is already installed");
        }

        if managed_python_configured(config) {
            output.line(OutputStyle::Success, "Python virtual environment exists");
        } else {
            let cpython_mirror = ranked_environment_source_with_output(
                EnvironmentSourceKind::Cpython,
                config,
                ranking_dir,
                &HttpSourceProbe,
                output,
            )?;
            self.runner.run(
                &uv_python_install_command_with_mirror(config, &cpython_mirror),
                output,
            )?;
            self.runner.run(&uv_venv_command(config), output)?;
        }
        Ok(())
    }

    /// Synchronizes Python dependencies with UV.
    pub fn sync_dependencies(
        &self,
        config: &UpdaterConfig,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<()> {
        self.sync_dependencies_with_ranking(config, None, output)
    }

    /// Synchronizes Python dependencies using a ranked PyPI index.
    pub fn sync_dependencies_with_ranking(
        &self,
        config: &UpdaterConfig,
        ranking_dir: Option<&Path>,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<()> {
        if !uses_managed_runtime(config) {
            output.line(
                OutputStyle::Info,
                "Custom Python interpreter configured; skipping UV dependency sync",
            );
            return Ok(());
        }

        let requirements = requirements_path(config)
            .ok_or_else(|| UpdaterError::Environment("requirements file not found".to_string()))?;
        let pypi_index = ranked_environment_source_with_output(
            EnvironmentSourceKind::Pypi,
            config,
            ranking_dir,
            &HttpSourceProbe,
            output,
        )?;
        if requirements_compile_cached(config, &requirements, &pypi_index)? {
            output.line(
                OutputStyle::Success,
                "requirements unchanged; skipping uv compile, sync, and cache clean",
            );
            return Ok(());
        } else {
            self.runner.run(
                &uv_compile_command_with_index(config, &requirements, &pypi_index),
                output,
            )?;
        }
        self.runner
            .run(&uv_sync_command_with_index(config, &pypi_index), output)?;
        self.runner.run(&uv_cache_clean_command(config), output)?;
        save_requirements_cache(config, &requirements, &pypi_index)?;
        Ok(())
    }

    /// Launches the backend service script.
    pub fn launch_backend(
        &self,
        config: &UpdaterConfig,
        port: u16,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<()> {
        let command = launch_backend_command(config, port);
        self.runner.run(&command, output)
    }
}

/// Returns true when updater-managed UV/Python should be used.
pub fn uses_managed_runtime(config: &UpdaterConfig) -> bool {
    config
        .python
        .runtime_path
        .trim()
        .eq_ignore_ascii_case("default")
}

/// Returns the UV executable path.
pub fn uv_executable(config: &UpdaterConfig) -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "uv.exe"
    } else {
        "uv"
    };
    config.toolkit_dir().join("uv").join(name)
}

/// Returns the managed virtual environment Python path.
pub fn venv_python(config: &UpdaterConfig) -> PathBuf {
    if cfg!(target_os = "windows") {
        config
            .baas_root()
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
    } else {
        config.baas_root().join(".venv").join("bin").join("python")
    }
}

/// Returns true when the managed Python environment already exists.
pub fn managed_python_configured(config: &UpdaterConfig) -> bool {
    venv_python(config).exists()
}

/// Returns the runtime Python path used for launch commands.
pub fn runtime_python(config: &UpdaterConfig) -> PathBuf {
    if uses_managed_runtime(config) {
        venv_python(config)
    } else {
        PathBuf::from(&config.python.runtime_path)
    }
}

/// Returns the UV archive name for the current platform.
pub fn uv_archive_name_for(os: &str, arch: &str) -> UpdaterResult<&'static str> {
    match (os, arch) {
        ("windows", _) => Ok("uv-x86_64-pc-windows-msvc.zip"),
        ("macos", "aarch64") => Ok("uv-aarch64-apple-darwin.tar.gz"),
        ("macos", "x86_64") => Ok("uv-x86_64-apple-darwin.tar.gz"),
        ("linux", "aarch64") => Ok("uv-aarch64-unknown-linux-gnu.tar.gz"),
        ("linux", _) => Ok("uv-x86_64-unknown-linux-gnu.tar.gz"),
        _ => Err(UpdaterError::Environment(format!(
            "unsupported platform for uv: {os}/{arch}"
        ))),
    }
}

/// Builds the UV Python install command.
pub fn uv_python_install_command(config: &UpdaterConfig) -> CommandSpec {
    uv_python_install_command_with_mirror(config, CPYTHON_HEAD.main)
}

/// Builds the UV Python install command with an already-ranked CPython mirror.
pub fn uv_python_install_command_with_mirror(
    config: &UpdaterConfig,
    cpython_mirror: &str,
) -> CommandSpec {
    CommandSpec::new(uv_executable(config))
        .arg("python")
        .arg("install")
        .arg(&config.python.python_version)
        .env(
            "UV_PYTHON_INSTALL_DIR",
            uv_python_install_dir(config).to_string_lossy().as_ref(),
        )
        .env("UV_PYTHON_INSTALL_MIRROR", cpython_mirror)
        .env("UV_CACHE_DIR", uv_cache_dir(config).to_string_lossy())
}

/// Builds the UV virtual environment command.
pub fn uv_venv_command(config: &UpdaterConfig) -> CommandSpec {
    CommandSpec::new(uv_executable(config))
        .arg("venv")
        .arg(config.baas_root().join(".venv").to_string_lossy())
        .arg("--python")
        .arg(&config.python.python_version)
        .env(
            "UV_PYTHON_INSTALL_DIR",
            uv_python_install_dir(config).to_string_lossy().as_ref(),
        )
        .env("UV_CACHE_DIR", uv_cache_dir(config).to_string_lossy())
        .cwd(config.baas_root())
}

/// Builds the UV pip compile command.
pub fn uv_compile_command(config: &UpdaterConfig, requirements: &Path) -> CommandSpec {
    let index = default_pypi_index(config);
    uv_compile_command_with_index(config, requirements, &index)
}

/// Builds the UV pip compile command with an already-ranked PyPI index.
pub fn uv_compile_command_with_index(
    config: &UpdaterConfig,
    requirements: &Path,
    pypi_index: &str,
) -> CommandSpec {
    let lock_path = config.baas_root().join("requirements.service.lock");
    uv_pip_command_with_index(config, pypi_index)
        .arg("compile")
        .arg(requirements.to_string_lossy())
        .arg("-o")
        .arg(lock_path.to_string_lossy())
}

/// Builds the UV pip sync command.
pub fn uv_sync_command(config: &UpdaterConfig) -> CommandSpec {
    let index = default_pypi_index(config);
    uv_sync_command_with_index(config, &index)
}

/// Builds the UV pip sync command with an already-ranked PyPI index.
pub fn uv_sync_command_with_index(config: &UpdaterConfig, pypi_index: &str) -> CommandSpec {
    uv_pip_command_with_index(config, pypi_index)
        .arg("sync")
        .arg(
            config
                .baas_root()
                .join("requirements.service.lock")
                .to_string_lossy(),
        )
        .env(
            "UV_PYTHON_INSTALL_DIR",
            uv_python_install_dir(config).to_string_lossy().as_ref(),
        )
}

/// Builds the UV cache clean command.
pub fn uv_cache_clean_command(config: &UpdaterConfig) -> CommandSpec {
    CommandSpec::new(uv_executable(config))
        .arg("--no-progress")
        .arg("cache")
        .arg("clean")
        .env("UV_CACHE_DIR", uv_cache_dir(config).to_string_lossy())
        .env(
            "UV_PYTHON_INSTALL_DIR",
            uv_python_install_dir(config).to_string_lossy().as_ref(),
        )
        .cwd(config.baas_root())
}

/// Builds the backend launch command.
pub fn launch_backend_command(config: &UpdaterConfig, port: u16) -> CommandSpec {
    CommandSpec::new(runtime_python(config))
        .arg(config.baas_root().join("main.service.py").to_string_lossy())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--no-ocr-update-check")
        .cwd(config.baas_root())
        .detached()
        .detached_pid_file(backend_pid_path(config))
}

/// Builds the backend launch command with Windows named-pipe transport enabled.
pub fn launch_backend_pipe_command(
    config: &UpdaterConfig,
    port: u16,
    pipe_name: &str,
) -> CommandSpec {
    let mut command = launch_backend_command(config, port);
    command.args.push("--pipe-name".to_string());
    command.args.push(pipe_name.to_string());
    command
}

/// Returns the platform-native C++ service executable name.
fn cpp_service_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "BAAS_service.exe"
    } else {
        "BAAS_service"
    }
}

/// Resolves the explicit C++ backend executable.
///
/// An operator override wins even when it does not exist so launch failures
/// identify the configured path. Packaged locations fall back from `bin/` to
/// the BAAS root according to which executable is present.
pub fn cpp_service_executable(config: &UpdaterConfig) -> PathBuf {
    cpp_service_executable_with_override(config, std::env::var_os("BAAS_CPP_SERVICE_PATH"))
}

/// Resolves the C++ service path with an injectable environment override.
fn cpp_service_executable_with_override(
    config: &UpdaterConfig,
    override_path: Option<std::ffi::OsString>,
) -> PathBuf {
    if let Some(path) = override_path.filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }

    let root_candidate = config.baas_root().join(cpp_service_executable_name());
    let bin_candidate = config
        .baas_root()
        .join("bin")
        .join(cpp_service_executable_name());
    if bin_candidate.exists() {
        bin_candidate
    } else {
        root_candidate
    }
}

/// Builds the explicitly selected C++ backend launch command.
pub fn launch_cpp_backend_command(config: &UpdaterConfig, port: u16) -> CommandSpec {
    CommandSpec::new(cpp_service_executable(config))
        .arg("--project-root")
        .arg(config.baas_root().to_string_lossy())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .cwd(config.baas_root())
        .detached()
        .detached_pid_file(backend_pid_path(config))
}

/// Builds the explicit C++ backend command with local Pipe transport enabled.
pub fn launch_cpp_backend_pipe_command(
    config: &UpdaterConfig,
    port: u16,
    pipe_name: &str,
) -> CommandSpec {
    let mut command = launch_cpp_backend_command(config, port);
    command.args.push("--pipe-name".to_string());
    command.args.push(pipe_name.to_string());
    command
}

/// Returns the pid file used for the currently launched backend process.
pub fn backend_pid_path(config: &UpdaterConfig) -> PathBuf {
    config.baas_root().join(".baas-updater").join("backend.pid")
}

/// Finds the service requirements file for the current platform.
pub fn requirements_path(config: &UpdaterConfig) -> Option<PathBuf> {
    let root = config.baas_root();
    let candidates = if cfg!(target_os = "windows") {
        vec![
            root.join("requirements.service.windows.txt"),
            root.join("deploy")
                .join("service")
                .join("requirements.service.windows.txt"),
            root.join("requirements.txt"),
        ]
    } else {
        vec![
            root.join("deploy")
                .join("service")
                .join("requirements.service.linux.txt"),
            root.join("requirements-linux.txt"),
            root.join("requirements.txt"),
        ]
    };
    candidates.into_iter().find(|path| path.exists())
}

/// Performs the install uv archive from operation.
fn install_uv_archive_from(
    config: &UpdaterConfig,
    url: &str,
    downloader: &impl AssetDownloader,
    output: &(impl OutputSink + ?Sized),
) -> UpdaterResult<()> {
    let bytes = downloader.download(url, output)?;
    let uv_dir = config.toolkit_dir().join("uv");
    fs::create_dir_all(&uv_dir)?;
    if url.ends_with(".zip") {
        let mut archive = ZipArchive::new(Cursor::new(bytes))?;
        archive.extract(&uv_dir)?;
    } else {
        let tar = GzDecoder::new(Cursor::new(bytes));
        let mut archive = Archive::new(tar);
        archive.unpack(&uv_dir)?;
    }
    flatten_uv_executable(&uv_dir, &uv_executable(config))?;
    output.line(OutputStyle::Success, "uv installed");
    Ok(())
}

/// Ensures the UV executable exists, downloading and extracting it when needed.
pub fn ensure_uv_installed(
    config: &UpdaterConfig,
    downloader: &impl AssetDownloader,
    output: &(impl OutputSink + ?Sized),
) -> UpdaterResult<()> {
    let archive_name = uv_archive_name_for(std::env::consts::OS, std::env::consts::ARCH)?;
    let url = format!(
        "{}/{}",
        UV_SRC_HEAD.main.trim_end_matches('/'),
        archive_name
    );
    ensure_uv_installed_from(config, &url, downloader, output)
}

/// Ensures UV exists by downloading from an already-ranked UV archive URL.
pub fn ensure_uv_installed_from(
    config: &UpdaterConfig,
    url: &str,
    downloader: &impl AssetDownloader,
    output: &(impl OutputSink + ?Sized),
) -> UpdaterResult<()> {
    let uv_path = uv_executable(config);
    if uv_path.exists() {
        output.line(OutputStyle::Success, "uv is already installed");
        return Ok(());
    }
    install_uv_archive_from(config, url, downloader, output)
}

/// Handles the flatten uv executable workflow.
fn flatten_uv_executable(uv_dir: &Path, target: &Path) -> UpdaterResult<()> {
    if target.exists() {
        return Ok(());
    }
    let name = target
        .file_name()
        .ok_or_else(|| UpdaterError::Environment("invalid uv executable path".to_string()))?;
    if let Some(found) = find_file(uv_dir, name) {
        fs::rename(found, target)?;
    }
    Ok(())
}

/// Returns the find file result.
fn find_file(dir: &Path, filename: &std::ffi::OsStr) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, filename) {
                return Some(found);
            }
        } else if path.file_name() == Some(filename) {
            return Some(path);
        }
    }
    None
}

/// Handles the uv pip command with index workflow.
fn uv_pip_command_with_index(config: &UpdaterConfig, index: &str) -> CommandSpec {
    CommandSpec::new(uv_executable(config))
        .arg("--no-progress")
        .arg("pip")
        .env("UV_INDEX", index)
        .env("UV_DEFAULT_INDEX", index)
        .env("UV_CACHE_DIR", uv_cache_dir(config).to_string_lossy())
        .env(
            "UV_PYTHON_INSTALL_DIR",
            uv_python_install_dir(config).to_string_lossy().as_ref(),
        )
        .env(
            "VIRTUAL_ENV",
            config.baas_root().join(".venv").to_string_lossy(),
        )
        .cwd(config.baas_root())
}

/// Returns the dependency lock path generated by `uv pip compile`.
pub fn requirements_lock_path(config: &UpdaterConfig) -> PathBuf {
    config.baas_root().join("requirements.service.lock")
}

/// Returns true when cached requirements metadata matches current inputs.
pub fn requirements_compile_cached(
    config: &UpdaterConfig,
    requirements: &Path,
    pypi_index: &str,
) -> UpdaterResult<bool> {
    let cache_path = requirements_cache_path(config);
    let lock_path = requirements_lock_path(config);
    if !cache_path.exists() || !lock_path.exists() {
        return Ok(false);
    }
    let content = fs::read_to_string(cache_path)?;
    let cache: RequirementsCompileCache =
        serde_json::from_str(&content).map_err(|error| UpdaterError::Config(error.to_string()))?;
    Ok(
        cache.requirements_path == normalize_cache_path(requirements)
            && cache.requirements_sha256 == sha256_file(requirements)?
            && cache.pypi_index == pypi_index
            && cache.lock_path == normalize_cache_path(&lock_path)
            && cache.lock_sha256 == sha256_file(&lock_path)?,
    )
}

/// Persists requirements compile cache metadata.
pub fn save_requirements_cache(
    config: &UpdaterConfig,
    requirements: &Path,
    pypi_index: &str,
) -> UpdaterResult<()> {
    let lock_path = requirements_lock_path(config);
    let cache = RequirementsCompileCache {
        requirements_path: normalize_cache_path(requirements),
        requirements_sha256: sha256_file(requirements)?,
        pypi_index: pypi_index.to_string(),
        lock_path: normalize_cache_path(&lock_path),
        lock_sha256: sha256_file(&lock_path)?,
    };
    let path = requirements_cache_path(config);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        path,
        serde_json::to_string_pretty(&cache)
            .map_err(|error| UpdaterError::Config(error.to_string()))?,
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequirementsCompileCache {
    requirements_path: String,
    requirements_sha256: String,
    pypi_index: String,
    lock_path: String,
    lock_sha256: String,
}

/// Handles the requirements cache path workflow.
fn requirements_cache_path(config: &UpdaterConfig) -> PathBuf {
    config
        .baas_root()
        .join(".baas-updater")
        .join("requirements-cache.json")
}

/// Returns the normalize cache path result.
fn normalize_cache_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Handles the sha256 file workflow.
fn sha256_file(path: &Path) -> UpdaterResult<String> {
    let bytes = fs::read(path)?;
    let digest = Sha256::digest(&bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Handles the default pypi index workflow.
fn default_pypi_index(config: &UpdaterConfig) -> String {
    config
        .general
        .source_list
        .first()
        .cloned()
        .unwrap_or_else(|| "https://pypi.org/simple".to_string())
}

/// Returns the selected ranked URL for an environment source kind.
pub fn ranked_environment_source(
    kind: EnvironmentSourceKind,
    config: &UpdaterConfig,
    ranking_dir: Option<&Path>,
    probe: &impl SourceProbe,
) -> UpdaterResult<String> {
    ranked_environment_source_with_output(kind, config, ranking_dir, probe, &crate::NoopOutput)
}

/// Returns the selected ranked URL and renders source probing when possible.
pub fn ranked_environment_source_with_output(
    kind: EnvironmentSourceKind,
    config: &UpdaterConfig,
    ranking_dir: Option<&Path>,
    probe: &impl SourceProbe,
    output: &(impl OutputSink + ?Sized),
) -> UpdaterResult<String> {
    let expected_urls = environment_source_urls(kind, config)?;
    let source_probes = environment_source_probe_urls(kind, &expected_urls);
    let ranking_path = ranking_dir.map(|dir| dir.join(format!("{}.json", kind.as_str())));
    let previous = load_environment_ranking(ranking_path.as_deref(), &expected_urls)?;
    let previous_failed_cycles = previous
        .as_ref()
        .filter(|ranking| ranking.all_disabled())
        .map(|ranking| ranking.all_failed_cycles)
        .unwrap_or(0);
    let mut ranking = match previous {
        Some(ranking) if !ranking.all_disabled() => ranking,
        _ => match kind {
            EnvironmentSourceKind::Cpython => {
                benchmark_source_probes_with_output(&source_probes, probe, output)
            }
            _ => benchmark_sources_with_output(&expected_urls, probe, output),
        },
    };
    if ranking.all_disabled() {
        ranking.all_failed_cycles = previous_failed_cycles.saturating_add(1);
    } else {
        ranking.all_failed_cycles = 0;
    }
    if let Some(path) = &ranking_path {
        save_ranking(path, &ranking)?;
    }
    if ranking.all_disabled() && ranking.all_failed_cycles >= 3 {
        return Err(UpdaterError::Network(format!(
            "all {} sources failed three consecutive ranking cycles",
            kind.as_str()
        )));
    }
    first_active_source(&ranking).ok_or_else(|| {
        UpdaterError::Network(format!(
            "all {} sources failed during ranking",
            kind.as_str()
        ))
    })
}

/// Handles the environment source probe urls workflow.
fn environment_source_probe_urls(
    kind: EnvironmentSourceKind,
    source_urls: &[String],
) -> Vec<(String, String)> {
    source_urls
        .iter()
        .map(|url| {
            let probe_url = match kind {
                EnvironmentSourceKind::Cpython => cpython_probe_url(url),
                _ => url.clone(),
            };
            (url.clone(), probe_url)
        })
        .collect()
}

/// Handles the cpython probe url workflow.
fn cpython_probe_url(url: &str) -> String {
    url.trim_end_matches('/')
        .strip_suffix("/releases/download")
        .map(|base| format!("{base}/releases"))
        .unwrap_or_else(|| url.to_string())
}

/// Returns the load environment ranking result.
fn load_environment_ranking(
    path: Option<&Path>,
    expected_urls: &[String],
) -> UpdaterResult<Option<SourceRanking>> {
    let Some(path) = path else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)?;
    let ranking: SourceRanking =
        serde_json::from_str(&content).map_err(|error| UpdaterError::Config(error.to_string()))?;
    Ok(ranking.matches_urls(expected_urls).then_some(ranking))
}

/// Returns the URL set for an environment source kind.
pub fn environment_source_urls(
    kind: EnvironmentSourceKind,
    config: &UpdaterConfig,
) -> UpdaterResult<Vec<String>> {
    match kind {
        EnvironmentSourceKind::Uv => {
            let archive_name = uv_archive_name_for(std::env::consts::OS, std::env::consts::ARCH)?;
            Ok(std::iter::once(UV_SRC_HEAD.main)
                .chain(UV_SRC_HEAD.proxy.iter().copied())
                .map(|head| format!("{}/{}", head.trim_end_matches('/'), archive_name))
                .collect())
        }
        EnvironmentSourceKind::Cpython => Ok(std::iter::once(CPYTHON_HEAD.main)
            .chain(CPYTHON_HEAD.proxy.iter().copied())
            .map(ToOwned::to_owned)
            .collect()),
        EnvironmentSourceKind::Pypi => {
            let urls = if config.general.source_list.is_empty() {
                PYPI_SOURCE_LIST
                    .iter()
                    .map(|source| source.to_string())
                    .collect()
            } else {
                config.general.source_list.clone()
            };
            Ok(urls)
        }
    }
}

/// Handles the first active source workflow.
fn first_active_source(ranking: &SourceRanking) -> Option<String> {
    ranking
        .active_sources()
        .into_iter()
        .next()
        .map(|source| source.url)
}

/// Handles the uv cache dir workflow.
fn uv_cache_dir(config: &UpdaterConfig) -> PathBuf {
    config.toolkit_dir().join("uv").join("cache")
}

/// Handles the uv python install dir workflow.
fn uv_python_install_dir(config: &UpdaterConfig) -> PathBuf {
    config.toolkit_dir().join("uv").join("cpython")
}

/// Handles the display command workflow.
fn display_command(command: &CommandSpec) -> String {
    let mut parts = vec![command.program.to_string_lossy().to_string()];
    parts.extend(command.args.iter().cloned());
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::UpdaterConfig;
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    #[derive(Default)]
    struct MockRunner {
        commands: Arc<Mutex<Vec<CommandSpec>>>,
    }

    impl ProcessRunner for MockRunner {
        /// Performs the run operation.
        fn run<O: OutputSink + ?Sized>(
            &self,
            command: &CommandSpec,
            _output: &O,
        ) -> UpdaterResult<()> {
            self.commands.lock().unwrap().push(command.clone());
            Ok(())
        }
    }

    struct EmptyDownloader;

    impl AssetDownloader for EmptyDownloader {
        /// Handles the download workflow.
        fn download<O: OutputSink + ?Sized>(
            &self,
            _url: &str,
            _output: &O,
        ) -> UpdaterResult<Vec<u8>> {
            Err(UpdaterError::Network("no network in test".to_string()))
        }
    }

    struct Probe {
        ok: Vec<String>,
    }

    impl SourceProbe for Probe {
        /// Handles the measure workflow.
        fn measure(&self, url: &str) -> UpdaterResult<Duration> {
            if self.ok.iter().any(|item| item == url) {
                Ok(Duration::from_millis(if url.contains("fast") {
                    1
                } else {
                    10
                }))
            } else {
                Err(UpdaterError::Network("down".to_string()))
            }
        }
    }

    /// Handles the config workflow.
    fn config(root: &Path) -> UpdaterConfig {
        let mut config = UpdaterConfig::default();
        config.paths.baas_root_path = root.to_string_lossy().to_string();
        config
    }

    /// Returns the resolves uv archive names result.
    #[test]
    fn resolves_uv_archive_names() {
        assert_eq!(
            uv_archive_name_for("windows", "x86_64").unwrap(),
            "uv-x86_64-pc-windows-msvc.zip"
        );
        assert_eq!(
            uv_archive_name_for("linux", "aarch64").unwrap(),
            "uv-aarch64-unknown-linux-gnu.tar.gz"
        );
    }

    /// Handles the custom runtime skips prepare and sync workflow.
    #[test]
    fn custom_runtime_skips_prepare_and_sync() {
        let root = tempfile::tempdir().unwrap();
        let mut config = config(root.path());
        config.python.runtime_path = "C:/Python/python.exe".to_string();
        let runner = MockRunner::default();
        let commands = Arc::clone(&runner.commands);
        let manager = EnvironmentManager::new(runner, EmptyDownloader);

        manager.prepare(&config, &crate::NoopOutput).unwrap();
        manager
            .sync_dependencies(&config, &crate::NoopOutput)
            .unwrap();

        assert!(commands.lock().unwrap().is_empty());
    }

    /// Handles the existing uv and python skip prepare ranking and downloads workflow.
    #[test]
    fn existing_uv_and_python_skip_prepare_ranking_and_downloads() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let uv = uv_executable(&config);
        let python = venv_python(&config);
        fs::create_dir_all(uv.parent().unwrap()).unwrap();
        fs::create_dir_all(python.parent().unwrap()).unwrap();
        fs::write(&uv, "uv").unwrap();
        fs::write(&python, "python").unwrap();
        let runner = MockRunner::default();
        let commands = Arc::clone(&runner.commands);
        let manager = EnvironmentManager::new(runner, EmptyDownloader);

        manager
            .prepare_with_ranking(&config, Some(root.path()), &crate::NoopOutput)
            .unwrap();

        assert!(commands.lock().unwrap().is_empty());
    }

    /// Handles the uv commands include cache and virtual env workflow.
    #[test]
    fn uv_commands_include_cache_and_virtual_env() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let compile = uv_compile_command(&config, &root.path().join("requirements.txt"));
        let sync = uv_sync_command(&config);
        let clean = uv_cache_clean_command(&config);

        assert!(compile.env.iter().any(|(key, _)| key == "UV_CACHE_DIR"));
        assert!(compile.args.contains(&"--no-progress".to_string()));
        assert!(sync.env.iter().any(|(key, _)| key == "VIRTUAL_ENV"));
        assert!(sync.args.contains(&"--no-progress".to_string()));
        assert!(sync.args.contains(&"sync".to_string()));
        assert!(clean.args.contains(&"--no-progress".to_string()));
    }

    /// Handles the command spec appends serial commands workflow.
    #[test]
    fn command_spec_appends_serial_commands() {
        let command = CommandSpec::new("first")
            .arg("one")
            .after(CommandSpec::new("second").arg("two"))
            .after(CommandSpec::new("third").after(CommandSpec::new("fourth")));

        let sequence = command.command_sequence();

        assert_eq!(sequence.len(), 4);
        assert_eq!(sequence[0].program, PathBuf::from("first"));
        assert_eq!(sequence[0].args, ["one"]);
        assert_eq!(sequence[1].program, PathBuf::from("second"));
        assert_eq!(sequence[2].program, PathBuf::from("third"));
        assert_eq!(sequence[3].program, PathBuf::from("fourth"));
        assert!(sequence.iter().all(|command| command.after.is_empty()));
    }

    /// Handles the requirements compile cache tracks requirements index and lock workflow.
    #[test]
    fn requirements_compile_cache_tracks_requirements_index_and_lock() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        fs::create_dir_all(config.baas_root()).unwrap();
        let requirements = config.baas_root().join("requirements.txt");
        let lock = requirements_lock_path(&config);
        fs::write(&requirements, "a==1\n").unwrap();
        fs::write(&lock, "lock-a").unwrap();

        assert!(
            !requirements_compile_cached(&config, &requirements, "https://pypi.example/simple")
                .unwrap()
        );
        save_requirements_cache(&config, &requirements, "https://pypi.example/simple").unwrap();
        assert!(
            requirements_compile_cached(&config, &requirements, "https://pypi.example/simple")
                .unwrap()
        );
        fs::write(&requirements, "a==2\n").unwrap();
        assert!(
            !requirements_compile_cached(&config, &requirements, "https://pypi.example/simple")
                .unwrap()
        );
    }

    /// Handles the launch command uses custom runtime when configured workflow.
    #[test]
    fn launch_command_uses_custom_runtime_when_configured() {
        let root = tempfile::tempdir().unwrap();
        let mut config = config(root.path());
        config.python.runtime_path = "python-custom".to_string();

        let command = launch_backend_command(&config, 48888);

        assert_eq!(command.program, PathBuf::from("python-custom"));
        assert!(command.detached);
        assert_eq!(
            command.detached_pid_file.as_deref(),
            Some(backend_pid_path(&config).as_path())
        );
        assert!(command.args.contains(&"--host".to_string()));
        assert!(command.args.contains(&"127.0.0.1".to_string()));
        assert!(command.args.contains(&"--port".to_string()));
        assert!(command.args.contains(&"48888".to_string()));
    }

    /// Explicit overrides take priority over packaged C++ service locations.
    #[test]
    fn cpp_service_path_prefers_override_then_bin_then_root() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let executable_name = cpp_service_executable_name();
        let root_executable = root.path().join(executable_name);
        let bin_executable = root.path().join("bin").join(executable_name);
        fs::create_dir_all(bin_executable.parent().unwrap()).unwrap();
        fs::write(&root_executable, "root").unwrap();
        fs::write(&bin_executable, "bin").unwrap();

        assert_eq!(
            cpp_service_executable_with_override(&config, None),
            bin_executable
        );
        fs::remove_file(&bin_executable).unwrap();
        assert_eq!(
            cpp_service_executable_with_override(&config, None),
            root_executable
        );
        assert_eq!(
            cpp_service_executable_with_override(
                &config,
                Some(std::ffi::OsString::from("D:/custom/BAAS_service.exe"))
            ),
            PathBuf::from("D:/custom/BAAS_service.exe")
        );
    }

    /// The C++ command carries the project root and detached PID ownership.
    #[test]
    fn cpp_launch_command_has_explicit_service_arguments() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());

        let command = launch_cpp_backend_command(&config, 48889);
        let baas_root = config.baas_root();

        assert_eq!(command.cwd.as_deref(), Some(baas_root.as_path()));
        assert!(command.detached);
        assert_eq!(
            command.detached_pid_file.as_deref(),
            Some(backend_pid_path(&config).as_path())
        );
        assert_eq!(
            command.args,
            vec![
                "--project-root".to_string(),
                baas_root.to_string_lossy().into_owned(),
                "--host".to_string(),
                "127.0.0.1".to_string(),
                "--port".to_string(),
                "48889".to_string()
            ]
        );
    }

    /// Pipe startup appends the endpoint after the common C++ arguments.
    #[test]
    fn cpp_pipe_launch_appends_pipe_name() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());

        let command = launch_cpp_backend_pipe_command(&config, 48890, r"\\.\pipe\baas-test");

        assert!(
            command
                .args
                .ends_with(&["--pipe-name".to_string(), r"\\.\pipe\baas-test".to_string()])
        );
    }

    /// Handles the environment source urls include uv archive and pypi config workflow.
    #[test]
    fn environment_source_urls_include_uv_archive_and_pypi_config() {
        let root = tempfile::tempdir().unwrap();
        let mut config = config(root.path());
        config.general.source_list = vec!["https://fast.example/simple".to_string()];

        let uv_urls = environment_source_urls(EnvironmentSourceKind::Uv, &config).unwrap();
        let pypi_urls = environment_source_urls(EnvironmentSourceKind::Pypi, &config).unwrap();

        assert!(uv_urls.iter().all(|url| url.contains("uv-")));
        assert_eq!(pypi_urls, ["https://fast.example/simple"]);
    }

    /// Handles the cpython probe url uses releases page but keeps source url workflow.
    #[test]
    fn cpython_probe_url_uses_releases_page_but_keeps_source_url() {
        let source = "https://github.com/Kiramei/baas-tauri/releases/download/";
        let mapped =
            environment_source_probe_urls(EnvironmentSourceKind::Cpython, &[source.to_string()]);

        assert_eq!(mapped[0].0, source);
        assert_eq!(
            mapped[0].1,
            "https://github.com/Kiramei/baas-tauri/releases"
        );
    }

    /// Handles the ranked environment source persists and reuses fast source workflow.
    #[test]
    fn ranked_environment_source_persists_and_reuses_fast_source() {
        let root = tempfile::tempdir().unwrap();
        let ranking = tempfile::tempdir().unwrap();
        let mut config = config(root.path());
        config.general.source_list = vec![
            "https://slow.example/simple".to_string(),
            "https://fast.example/simple".to_string(),
        ];

        let selected = ranked_environment_source(
            EnvironmentSourceKind::Pypi,
            &config,
            Some(ranking.path()),
            &Probe {
                ok: config.general.source_list.clone(),
            },
        )
        .unwrap();

        assert_eq!(selected, "https://fast.example/simple");
        assert!(ranking.path().join("pypi.json").exists());
    }

    /// Handles the ranked environment source errors after three all failed cycles workflow.
    #[test]
    fn ranked_environment_source_errors_after_three_all_failed_cycles() {
        let root = tempfile::tempdir().unwrap();
        let ranking = tempfile::tempdir().unwrap();
        let mut config = config(root.path());
        config.general.source_list = vec!["https://down.example/simple".to_string()];

        for _ in 0..2 {
            assert!(
                ranked_environment_source(
                    EnvironmentSourceKind::Pypi,
                    &config,
                    Some(ranking.path()),
                    &Probe { ok: Vec::new() },
                )
                .is_err()
            );
        }
        let error = ranked_environment_source(
            EnvironmentSourceKind::Pypi,
            &config,
            Some(ranking.path()),
            &Probe { ok: Vec::new() },
        )
        .unwrap_err();

        assert!(error.message().contains("three consecutive"));
    }
}
