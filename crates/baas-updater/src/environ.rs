//! UV and Python environment setup.

use crate::{
    OutputSink, OutputStyle, UpdaterError, UpdaterResult,
    config::UpdaterConfig,
    constants::{CPYTHON_HEAD, UV_SRC_HEAD},
};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    process::Command,
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
    fn run<O: OutputSink + ?Sized>(&self, command: &CommandSpec, output: &O) -> UpdaterResult<()> {
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
            process
                .spawn()
                .map_err(|error| UpdaterError::Environment(error.to_string()))?;
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

/// Real asset downloader using blocking reqwest.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReqwestDownloader;

impl AssetDownloader for ReqwestDownloader {
    fn download<O: OutputSink + ?Sized>(&self, url: &str, output: &O) -> UpdaterResult<Vec<u8>> {
        output.line(OutputStyle::Info, &format!("Downloading {url}"));
        let mut response = reqwest::blocking::get(url)
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        let mut bytes = Vec::new();
        response
            .read_to_end(&mut bytes)
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        Ok(bytes)
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
        if !uses_managed_runtime(config) {
            output.line(
                OutputStyle::Info,
                "Custom Python interpreter configured; skipping managed UV setup",
            );
            return Ok(());
        }

        let uv_path = uv_executable(config);
        if !uv_path.exists() {
            install_uv_archive(config, &self.downloader, output)?;
        } else {
            output.line(OutputStyle::Success, "uv is already installed");
        }

        self.runner
            .run(&uv_python_install_command(config), output)?;
        if !venv_python(config).exists() {
            self.runner.run(&uv_venv_command(config), output)?;
        } else {
            output.line(OutputStyle::Success, "Python virtual environment exists");
        }
        Ok(())
    }

    /// Synchronizes Python dependencies with UV.
    pub fn sync_dependencies(
        &self,
        config: &UpdaterConfig,
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
        self.runner
            .run(&uv_compile_command(config, &requirements), output)?;
        self.runner.run(&uv_sync_command(config), output)?;
        self.runner.run(&uv_cache_clean_command(config), output)?;
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
    CommandSpec::new(uv_executable(config))
        .arg("python")
        .arg("install")
        .arg(&config.python.python_version)
        .env("UV_PYTHON_INSTALL_MIRROR", CPYTHON_HEAD.main)
        .env("UV_CACHE_DIR", uv_cache_dir(config).to_string_lossy())
}

/// Builds the UV virtual environment command.
pub fn uv_venv_command(config: &UpdaterConfig) -> CommandSpec {
    CommandSpec::new(uv_executable(config))
        .arg("venv")
        .arg(config.baas_root().join(".venv").to_string_lossy())
        .arg("--python")
        .arg(&config.python.python_version)
        .env("UV_CACHE_DIR", uv_cache_dir(config).to_string_lossy())
        .cwd(config.baas_root())
}

/// Builds the UV pip compile command.
pub fn uv_compile_command(config: &UpdaterConfig, requirements: &Path) -> CommandSpec {
    let lock_path = config.baas_root().join("requirements.service.lock");
    uv_pip_command(config)
        .arg("compile")
        .arg(requirements.to_string_lossy())
        .arg("-o")
        .arg(lock_path.to_string_lossy())
}

/// Builds the UV pip sync command.
pub fn uv_sync_command(config: &UpdaterConfig) -> CommandSpec {
    uv_pip_command(config).arg("sync").arg(
        config
            .baas_root()
            .join("requirements.service.lock")
            .to_string_lossy(),
    )
}

/// Builds the UV cache clean command.
pub fn uv_cache_clean_command(config: &UpdaterConfig) -> CommandSpec {
    CommandSpec::new(uv_executable(config))
        .arg("cache")
        .arg("clean")
        .env("UV_CACHE_DIR", uv_cache_dir(config).to_string_lossy())
        .cwd(config.baas_root())
}

/// Builds the backend launch command.
pub fn launch_backend_command(config: &UpdaterConfig, port: u16) -> CommandSpec {
    CommandSpec::new(runtime_python(config))
        .arg(config.baas_root().join("main.service.py").to_string_lossy())
        .arg("--port")
        .arg(port.to_string())
        .cwd(config.baas_root())
        .detached()
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

fn install_uv_archive(
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
    let bytes = downloader.download(&url, output)?;
    let uv_dir = config.toolkit_dir().join("uv");
    fs::create_dir_all(&uv_dir)?;
    if archive_name.ends_with(".zip") {
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

fn uv_pip_command(config: &UpdaterConfig) -> CommandSpec {
    let index = config
        .general
        .source_list
        .first()
        .cloned()
        .unwrap_or_else(|| "https://pypi.org/simple".to_string());
    CommandSpec::new(uv_executable(config))
        .arg("pip")
        .env("UV_INDEX", &index)
        .env("UV_DEFAULT_INDEX", index)
        .env("UV_CACHE_DIR", uv_cache_dir(config).to_string_lossy())
        .env(
            "VIRTUAL_ENV",
            config.baas_root().join(".venv").to_string_lossy(),
        )
        .cwd(config.baas_root())
}

fn uv_cache_dir(config: &UpdaterConfig) -> PathBuf {
    config.toolkit_dir().join("uv").join("cache")
}

fn display_command(command: &CommandSpec) -> String {
    let mut parts = vec![command.program.to_string_lossy().to_string()];
    parts.extend(command.args.iter().cloned());
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::UpdaterConfig;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MockRunner {
        commands: Arc<Mutex<Vec<CommandSpec>>>,
    }

    impl ProcessRunner for MockRunner {
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
        fn download<O: OutputSink + ?Sized>(
            &self,
            _url: &str,
            _output: &O,
        ) -> UpdaterResult<Vec<u8>> {
            Err(UpdaterError::Network("no network in test".to_string()))
        }
    }

    fn config(root: &Path) -> UpdaterConfig {
        let mut config = UpdaterConfig::default();
        config.paths.baas_root_path = root.to_string_lossy().to_string();
        config
    }

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

    #[test]
    fn uv_commands_include_cache_and_virtual_env() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let compile = uv_compile_command(&config, &root.path().join("requirements.txt"));
        let sync = uv_sync_command(&config);

        assert!(compile.env.iter().any(|(key, _)| key == "UV_CACHE_DIR"));
        assert!(sync.env.iter().any(|(key, _)| key == "VIRTUAL_ENV"));
        assert!(sync.args.contains(&"sync".to_string()));
    }

    #[test]
    fn launch_command_uses_custom_runtime_when_configured() {
        let root = tempfile::tempdir().unwrap();
        let mut config = config(root.path());
        config.python.runtime_path = "python-custom".to_string();

        let command = launch_backend_command(&config, 48888);

        assert_eq!(command.program, PathBuf::from("python-custom"));
        assert!(command.detached);
        assert!(command.args.contains(&"--port".to_string()));
        assert!(command.args.contains(&"48888".to_string()));
    }
}
