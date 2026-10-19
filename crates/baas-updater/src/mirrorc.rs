//! MirrorC update client and package application helpers.

use crate::{
    OutputSink, OutputStyle, RepositoryKind, UpdateChannel, UpdateStatus, UpdaterError,
    UpdaterResult,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
    time::Duration,
};
use zip::ZipArchive;

const MIRRORC_BASE_URL: &str = "https://mirrorchyan.com/api/resources";
const USER_AGENT: &str = "BAAS_GUI";

/// MirrorC CDK state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CdkState {
    /// CDK is valid.
    Valid,
    /// CDK is invalid.
    Invalid,
    /// CDK is expired.
    Expired,
    /// CDK quota is exhausted.
    Exhausted,
    /// CDK does not match the resource.
    Mismatched,
    /// CDK is blocked.
    Blocked,
}

/// MirrorC package type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MirrorUpdateType {
    /// Full repository package.
    Full,
    /// Incremental package containing `changes.json`.
    Incremental,
}

/// Parsed MirrorC latest response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorLatest {
    /// Numeric MirrorC response code.
    pub code: i32,
    /// Human-readable MirrorC response message.
    pub message: String,
    /// Whether response contains usable package data.
    pub has_data: bool,
    /// Latest version/SHA name.
    pub latest_version_name: Option<String>,
    /// Release note when present.
    pub release_note: Option<String>,
    /// Package download URL when present.
    pub download_url: Option<String>,
    /// Package SHA-256 when present.
    pub sha256: Option<String>,
    /// Package update type.
    pub update_type: Option<MirrorUpdateType>,
    /// Package size in bytes.
    pub file_size: Option<u64>,
    /// CDK expiry timestamp from MirrorC.
    pub cdk_expired_time: Option<u64>,
}

impl MirrorLatest {
    /// Returns true when MirrorC reports a successful request.
    pub fn is_success(&self) -> bool {
        self.code == 0
    }

    /// Returns true when MirrorC returned a package URL.
    pub fn has_url(&self) -> bool {
        self.download_url.is_some()
    }

    /// Maps the response code to a CDK state when applicable.
    pub fn cdk_state(&self) -> Option<CdkState> {
        match self.code {
            0 => Some(CdkState::Valid),
            7001 => Some(CdkState::Expired),
            7002 => Some(CdkState::Invalid),
            7003 => Some(CdkState::Exhausted),
            7004 => Some(CdkState::Mismatched),
            7005 => Some(CdkState::Blocked),
            _ => None,
        }
    }
}

/// Result of a MirrorC update operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorUpdateResult {
    /// Repository kind updated by MirrorC.
    pub kind: RepositoryKind,
    /// Operation status.
    pub status: UpdateStatus,
    /// Latest version/SHA after the operation.
    pub version: String,
}

/// HTTP abstraction for MirrorC tests.
pub trait MirrorHttp {
    /// Performs a JSON GET request and returns the response body.
    fn get_json(&self, url: &str, timeout: Duration) -> UpdaterResult<serde_json::Value>;
    /// Downloads a binary package.
    fn download(
        &self,
        url: &str,
        timeout: Duration,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<Vec<u8>>;
}

/// Blocking reqwest MirrorC HTTP implementation.
#[derive(Debug, Clone, Default)]
pub struct ReqwestMirrorHttp;

fn mirrorc_http_client(timeout: Duration) -> UpdaterResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        // MirrorC API requests and package redirects must always use a direct connection.
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(mirrorc_network_error)
}

fn mirrorc_network_error(error: reqwest::Error) -> UpdaterError {
    // API URLs contain the CDK, and package URLs may contain temporary credentials.
    UpdaterError::Network(error.without_url().to_string())
}

impl MirrorHttp for ReqwestMirrorHttp {
    /// Returns the get json result.
    fn get_json(&self, url: &str, timeout: Duration) -> UpdaterResult<serde_json::Value> {
        let client = mirrorc_http_client(timeout)?;
        let response = client.get(url).send().map_err(mirrorc_network_error)?;
        let status = response.status();
        let body = response.text().map_err(mirrorc_network_error)?;

        parse_mirrorc_json_body(status, &body)
    }

    /// Handles the download workflow.
    fn download(
        &self,
        url: &str,
        timeout: Duration,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<Vec<u8>> {
        let client = mirrorc_http_client(timeout)?;
        let mut response = client
            .get(url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(mirrorc_network_error)?;
        let mut bytes = Vec::new();
        let total = response.content_length().unwrap_or(0).max(1);
        let started = std::time::Instant::now();
        if let Some(term) = output.thread_output() {
            term.with_progress_bar(
                "mirror package",
                total,
                30,
                "MirrorC download complete",
                |bar| {
                    let mut buffer = [0_u8; 64 * 1024];
                    loop {
                        let read = response
                            .read(&mut buffer)
                            .map_err(|error| error.to_string())?;
                        if read == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&buffer[..read]);
                        bar.set(
                            bytes.len() as u64,
                            transfer_detail(bytes.len() as u64, total, started),
                        );
                    }
                    Ok(())
                },
            )
            .map_err(UpdaterError::Network)?;
        } else {
            response
                .read_to_end(&mut bytes)
                .map_err(|error| UpdaterError::Network(error.to_string()))?;
        }
        Ok(bytes)
    }
}

/// MirrorC API client.
pub struct MirrorCClient<H> {
    http: H,
    timeout: Duration,
}

impl<H: MirrorHttp> MirrorCClient<H> {
    /// Creates a MirrorC client.
    pub fn new(http: H) -> Self {
        Self {
            http,
            timeout: Duration::from_secs(30),
        }
    }

    /// Creates a MirrorC client with a custom timeout.
    pub fn with_timeout(http: H, timeout: Duration) -> Self {
        Self { http, timeout }
    }

    /// Queries MirrorC's latest endpoint.
    pub fn latest(
        &self,
        kind: RepositoryKind,
        channel: UpdateChannel,
        current_version: &str,
        cdk: &str,
    ) -> UpdaterResult<MirrorLatest> {
        let url = mirrorc_latest_url(kind, channel, current_version, cdk);
        parse_latest_response(self.http.get_json(&url, self.timeout)?)
    }

    /// Performs a MirrorC full or incremental update.
    pub fn update(
        &self,
        request: &MirrorUpdateRequest<'_>,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<MirrorUpdateResult> {
        let latest = self.latest(
            request.kind,
            request.channel,
            request.current_version,
            request.cdk,
        )?;
        if !latest.is_success() {
            return Err(mirrorc_error(&latest));
        }
        let version = latest
            .latest_version_name
            .clone()
            .ok_or_else(|| UpdaterError::MirrorC("MirrorC response missing version".to_string()))?;

        if version == request.current_version && !version.is_empty() {
            output.line(
                OutputStyle::Info,
                "MirrorC repository is already up to date",
            );
            return Ok(MirrorUpdateResult {
                kind: request.kind,
                status: UpdateStatus::Skipped,
                version,
            });
        }

        let download_url = latest
            .download_url
            .as_deref()
            .ok_or_else(|| mirrorc_error(&latest))?;
        let package = self.http.download(download_url, self.timeout, output)?;
        match latest.update_type.unwrap_or(MirrorUpdateType::Full) {
            MirrorUpdateType::Full => {
                output.line(OutputStyle::Info, "Applying MirrorC full package");
                apply_full_package_with_output(&package, request.target_dir, output)?;
                Ok(MirrorUpdateResult {
                    kind: request.kind,
                    status: UpdateStatus::Installed,
                    version,
                })
            }
            MirrorUpdateType::Incremental => {
                output.line(OutputStyle::Info, "Applying MirrorC incremental package");
                apply_incremental_package_with_output(&package, request.target_dir, output)?;
                Ok(MirrorUpdateResult {
                    kind: request.kind,
                    status: UpdateStatus::Updated,
                    version,
                })
            }
        }
    }
}

/// MirrorC update request.
pub struct MirrorUpdateRequest<'a> {
    /// Repository kind.
    pub kind: RepositoryKind,
    /// Update channel.
    pub channel: UpdateChannel,
    /// Current local version/SHA.
    pub current_version: &'a str,
    /// MirrorC CDK.
    pub cdk: &'a str,
    /// Target directory to install/update.
    pub target_dir: &'a Path,
}

/// Builds a MirrorC latest URL.
pub fn mirrorc_latest_url(
    kind: RepositoryKind,
    _channel: UpdateChannel,
    current_version: &str,
    cdk: &str,
) -> String {
    let app = match kind {
        RepositoryKind::Main => "BAAS_repo",
        RepositoryKind::Cpp => "BAAS_Cpp",
    };
    let mut url = format!(
        "{MIRRORC_BASE_URL}/{app}/latest?channel={}&current_version={}&user_agent={USER_AGENT}&cdk={}",
        "stable", current_version, cdk
    );
    if kind == RepositoryKind::Cpp {
        let (os, arch) = mirrorc_system_info();
        url.push_str(&format!("&os={os}&arch={arch}"));
    }
    url
}

/// Parses a MirrorC latest JSON response.
pub fn parse_latest_response(value: serde_json::Value) -> UpdaterResult<MirrorLatest> {
    let response: RawLatestResponse =
        serde_json::from_value(value).map_err(|error| UpdaterError::MirrorC(error.to_string()))?;
    let has_data_code = matches!(response.code, 0 | 7001 | 7002 | 7003 | 7004 | 7005);
    let data = response.data.unwrap_or_default();
    Ok(MirrorLatest {
        code: response.code,
        message: response.message,
        has_data: response.code >= 0 && has_data_code,
        latest_version_name: data.version_name,
        release_note: data.release_note,
        download_url: data.url,
        sha256: data.sha256,
        update_type: data.update_type,
        file_size: data.filesize,
        cdk_expired_time: data.cdk_expired_time,
    })
}

/// Returns the parse mirrorc json body result.
fn parse_mirrorc_json_body(
    status: reqwest::StatusCode,
    body: &str,
) -> UpdaterResult<serde_json::Value> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        return Ok(value);
    }

    if status.is_success() {
        Err(UpdaterError::Network(format!(
            "MirrorC returned invalid JSON: {body}"
        )))
    } else {
        Err(UpdaterError::Network(format!(
            "MirrorC HTTP {status}: {body}"
        )))
    }
}

/// Removes the first directory component from a package path.
pub fn remove_first_dir(path: &str) -> PathBuf {
    let mut components = Path::new(path)
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_os_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if components.len() > 1 {
        components.remove(0);
    }
    components.into_iter().collect()
}

/// Applies an incremental package zip to a target directory.
pub fn apply_incremental_package(package: &[u8], target_dir: &Path) -> UpdaterResult<()> {
    apply_incremental_package_with_output(package, target_dir, &crate::NoopOutput)
}

/// Applies an incremental package zip with terminal progress when available.
pub fn apply_incremental_package_with_output(
    package: &[u8],
    target_dir: &Path,
    output: &(impl OutputSink + ?Sized),
) -> UpdaterResult<()> {
    let temp = tempfile::tempdir()?;
    with_optional_spinner(output, "Extracting MirrorC incremental package", || {
        extract_zip(package, temp.path())
    })?;
    let changes_path = temp.path().join("changes.json");
    let changes: ChangeSet = serde_json::from_str(&fs::read_to_string(changes_path)?)
        .map_err(|error| UpdaterError::MirrorC(error.to_string()))?;
    apply_changes_with_output(temp.path(), &changes, target_dir, output)
}

/// Applies a MirrorC full package zip to a target directory.
pub fn apply_full_package(package: &[u8], target_dir: &Path) -> UpdaterResult<()> {
    apply_full_package_with_output(package, target_dir, &crate::NoopOutput)
}

/// Applies a MirrorC full package zip with terminal progress when available.
pub fn apply_full_package_with_output(
    package: &[u8],
    target_dir: &Path,
    output: &(impl OutputSink + ?Sized),
) -> UpdaterResult<()> {
    let temp = tempfile::tempdir()?;
    with_optional_spinner(output, "Extracting MirrorC full package", || {
        extract_zip(package, temp.path())
    })?;
    let source_root = first_child_dir(temp.path()).unwrap_or_else(|| temp.path().to_path_buf());
    with_optional_spinner(output, "Installing MirrorC full package", || {
        copy_dir_contents(&source_root, target_dir)
    })
}

/// Applies a parsed MirrorC change set.
pub fn apply_changes(
    source_dir: &Path,
    changes: &ChangeSet,
    target_dir: &Path,
) -> UpdaterResult<()> {
    apply_changes_with_output(source_dir, changes, target_dir, &crate::NoopOutput)
}

/// Applies a parsed MirrorC change set with terminal progress when available.
pub fn apply_changes_with_output(
    source_dir: &Path,
    changes: &ChangeSet,
    target_dir: &Path,
    output: &(impl OutputSink + ?Sized),
) -> UpdaterResult<()> {
    let total = (changes.deleted.len() + changes.added.len() + changes.modified.len()) as u64;
    if let Some(term) = output.thread_output() {
        return term
            .with_progress_bar(
                "mirror apply",
                total.max(1),
                30,
                "MirrorC update applied",
                |bar| {
                    let mut current = 0;
                    for deleted in &changes.deleted {
                        let target = target_dir.join(remove_first_dir(deleted));
                        if target.is_file() {
                            fs::remove_file(target).map_err(|error| error.to_string())?;
                        }
                        current += 1;
                        bar.set(current, format!("delete {current}/{total}"));
                    }
                    for added in &changes.added {
                        copy_changed_file(source_dir, target_dir, added)
                            .map_err(|error| error.message())?;
                        current += 1;
                        bar.set(current, format!("add {current}/{total}"));
                    }
                    for modified in &changes.modified {
                        copy_changed_file(source_dir, target_dir, modified)
                            .map_err(|error| error.message())?;
                        current += 1;
                        bar.set(current, format!("modify {current}/{total}"));
                    }
                    Ok(())
                },
            )
            .map_err(UpdaterError::MirrorC);
    }
    for deleted in &changes.deleted {
        let target = target_dir.join(remove_first_dir(deleted));
        if target.is_file() {
            fs::remove_file(target)?;
        }
    }
    for added in &changes.added {
        copy_changed_file(source_dir, target_dir, added)?;
    }
    for modified in &changes.modified {
        copy_changed_file(source_dir, target_dir, modified)?;
    }
    Ok(())
}

/// Handles the with optional spinner workflow.
fn with_optional_spinner<T>(
    output: &(impl OutputSink + ?Sized),
    label: &str,
    run: impl FnOnce() -> UpdaterResult<T>,
) -> UpdaterResult<T> {
    if let Some(term) = output.thread_output() {
        term.with_spinner(label, format!("{label} complete"), |_spinner| {
            run().map_err(|error| error.message())
        })
        .map_err(UpdaterError::MirrorC)
    } else {
        output.line(OutputStyle::Info, label);
        run()
    }
}

/// MirrorC incremental changes file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ChangeSet {
    /// Files removed by the update.
    #[serde(default)]
    pub deleted: Vec<String>,
    /// Files added by the update.
    #[serde(default)]
    pub added: Vec<String>,
    /// Files modified by the update.
    #[serde(default)]
    pub modified: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawLatestResponse {
    code: i32,
    #[serde(rename = "msg")]
    message: String,
    data: Option<RawLatestData>,
}

#[derive(Debug, Default, Deserialize)]
struct RawLatestData {
    url: Option<String>,
    sha256: Option<String>,
    update_type: Option<MirrorUpdateType>,
    filesize: Option<u64>,
    cdk_expired_time: Option<u64>,
    version_name: Option<String>,
    release_note: Option<String>,
}

/// Handles the mirrorc error workflow.
fn mirrorc_error(latest: &MirrorLatest) -> UpdaterError {
    let detail = if latest.message.trim().is_empty() {
        latest
            .cdk_state()
            .map(|state| format!("CDK state: {state:?}"))
            .unwrap_or_else(|| format!("MirrorC returned code {}", latest.code))
    } else {
        latest.message.clone()
    };
    UpdaterError::MirrorC(format!("MirrorC did not provide a download URL: {detail}"))
}

/// Handles the mirrorc system info workflow.
fn mirrorc_system_info() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        "linux" => "linux",
        _ => "universal",
    };
    let arch = match std::env::consts::ARCH {
        "x86" | "i386" | "i686" => "386",
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    (os, arch)
}

/// Returns the extract zip result.
fn extract_zip(package: &[u8], out_dir: &Path) -> UpdaterResult<()> {
    let mut archive = ZipArchive::new(Cursor::new(package))?;
    archive.extract(out_dir)?;
    Ok(())
}

/// Handles the first child dir workflow.
fn first_child_dir(path: &Path) -> Option<PathBuf> {
    fs::read_dir(path)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir())
}

/// Performs the copy dir contents operation.
fn copy_dir_contents(source: &Path, target: &Path) -> UpdaterResult<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_contents(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source_path, target_path)?;
        }
    }
    Ok(())
}

/// Performs the copy changed file operation.
fn copy_changed_file(source_dir: &Path, target_dir: &Path, changed: &str) -> UpdaterResult<()> {
    let source = source_dir.join(changed);
    let target = target_dir.join(remove_first_dir(changed));
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, target)?;
    Ok(())
}

/// Handles the transfer detail workflow.
fn transfer_detail(current: u64, total: u64, started: std::time::Instant) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, process::Command, thread, time::Instant};

    #[test]
    fn mirror_http_bypasses_proxy_and_omits_credentials_from_errors() {
        const CHILD_FLAG: &str = "BAAS_TEST_MIRROR_HTTP_CHILD";
        if std::env::var_os(CHILD_FLAG).is_none() {
            // Reqwest caches proxy discovery. Use a fresh process instead of racing other
            // tests by mutating this process's environment.
            let unused_port = TcpListener::bind("127.0.0.1:0").unwrap();
            let proxy = format!("http://{}", unused_port.local_addr().unwrap());
            drop(unused_port);
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args([
                "--exact",
                "mirrorc::tests::mirror_http_bypasses_proxy_and_omits_credentials_from_errors",
                "--nocapture",
            ]);
            command.env(CHILD_FLAG, "1");
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                command.env(key, &proxy);
            }
            command.env("NO_PROXY", "").env("no_proxy", "");
            let result = command.output().unwrap();
            assert!(
                result.status.success(),
                "MirrorC proxy regression subprocess failed:\n{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr),
            );
            return;
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let redirect_origin = origin.clone();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut paths = Vec::new();
            while paths.len() < 4 && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("loopback accept failed: {error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    assert_eq!(stream.read(&mut byte).unwrap(), 1);
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap();
                let path = request.split_whitespace().nth(1).unwrap().to_string();
                let response = if path.starts_with("/api?") {
                    let body = r#"{"code":0,"msg":"ok"}"#;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                } else if path.starts_with("/redirect?") {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: {redirect_origin}/package?signature=test-package-token\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                } else if path.starts_with("/package?") {
                    "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\npackage"
                        .to_string()
                } else {
                    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                };
                stream.write_all(response.as_bytes()).unwrap();
                paths.push(path);
            }
            paths
        });

        let timeout = Duration::from_secs(2);
        // Verify that the poisoned proxy environment is effective for an ordinary client.
        assert!(
            reqwest::blocking::Client::builder()
                .timeout(timeout)
                .build()
                .unwrap()
                .get(format!("{origin}/control"))
                .send()
                .is_err()
        );
        let http = ReqwestMirrorHttp;
        assert_eq!(
            http.get_json(&format!("{origin}/api?cdk=test-cdk"), timeout)
                .unwrap()["code"],
            0
        );
        assert_eq!(
            http.download(
                &format!("{origin}/redirect?signature=test-package-token"),
                timeout,
                &crate::NoopOutput
            )
            .unwrap(),
            b"package"
        );

        let download_error = http
            .download(
                &format!("{origin}/failure?signature=test-package-token"),
                timeout,
                &crate::NoopOutput,
            )
            .unwrap_err()
            .message();
        assert!(download_error.contains("503"));
        assert!(!download_error.contains("test-package-token"));
        assert!(!download_error.contains(&origin));
        let paths = server.join().unwrap();
        assert_eq!(paths.len(), 4);
        assert!(paths.iter().any(|path| path.starts_with("/api?")));
        assert!(paths.iter().any(|path| path.starts_with("/package?")));

        // The origin is now closed, producing a request error that originally included
        // the CDK query. The public error must contain neither the token nor the URL.
        let api_error = http
            .get_json(&format!("{origin}/api?cdk=test-cdk"), timeout)
            .unwrap_err()
            .message();
        assert!(!api_error.contains("test-cdk"));
        assert!(!api_error.contains(&origin));
    }

    /// Verifies the parses latest response and cdk state behavior.
    #[test]
    fn parses_latest_response_and_cdk_state() {
        let latest = parse_latest_response(serde_json::json!({
            "code": 0,
            "msg": "ok",
            "data": {
                "version_name": "abcdef",
                "url": "https://download",
                "update_type": "incremental",
                "filesize": 42
            }
        }))
        .unwrap();

        assert!(latest.has_data);
        assert!(latest.has_url());
        assert_eq!(latest.cdk_state(), Some(CdkState::Valid));
        assert_eq!(latest.update_type, Some(MirrorUpdateType::Incremental));
    }

    /// Returns the maps cdk error without url result.
    #[test]
    fn maps_cdk_error_without_url() {
        let latest = parse_latest_response(serde_json::json!({
            "code": 7002,
            "msg": "invalid",
            "data": {}
        }))
        .unwrap();

        assert_eq!(latest.cdk_state(), Some(CdkState::Invalid));
        assert!(mirrorc_error(&latest).message().contains("invalid"));
    }

    /// Handles the preserves mirrorc error message when error response has data workflow.
    #[test]
    fn preserves_mirrorc_error_message_when_error_response_has_data() {
        let latest = parse_latest_response(serde_json::json!({
            "code": 7001,
            "msg": "The cdk has expired",
            "data": {
                "version_name": "0940d8c3c1e505adabd881038f25862871585a6e",
                "version_number": 236,
                "channel": "stable",
                "os": "",
                "arch": "",
                "release_note": "2026-06-10 21:10:15 +0800 0940d8c update : JP activity"
            }
        }))
        .unwrap();

        assert_eq!(latest.cdk_state(), Some(CdkState::Expired));
        assert_eq!(latest.message, "The cdk has expired");
        assert_eq!(
            latest.latest_version_name,
            Some("0940d8c3c1e505adabd881038f25862871585a6e".to_string())
        );
        assert!(
            mirrorc_error(&latest)
                .message()
                .contains("The cdk has expired")
        );
    }

    /// Handles the accepts mirrorc json body from http error status workflow.
    #[test]
    fn accepts_mirrorc_json_body_from_http_error_status() {
        let value = parse_mirrorc_json_body(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"code":7001,"msg":"The cdk has expired","data":{"version_name":"sha"}}"#,
        )
        .unwrap();
        let latest = parse_latest_response(value).unwrap();

        assert_eq!(latest.code, 7001);
        assert_eq!(latest.message, "The cdk has expired");
        assert_eq!(latest.latest_version_name, Some("sha".to_string()));
    }

    /// Performs the removes first directory component operation.
    #[test]
    fn removes_first_directory_component() {
        assert_eq!(remove_first_dir("root/a/b.txt"), PathBuf::from("a/b.txt"));
        assert_eq!(remove_first_dir("file.txt"), PathBuf::from("file.txt"));
    }

    /// Handles the applies changes to target workflow.
    #[test]
    fn applies_changes_to_target() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let source_file = source.path().join("root/new.txt");
        fs::create_dir_all(source_file.parent().unwrap()).unwrap();
        fs::write(&source_file, "new").unwrap();
        fs::write(target.path().join("old.txt"), "old").unwrap();

        apply_changes(
            source.path(),
            &ChangeSet {
                deleted: vec!["root/old.txt".to_string()],
                added: vec!["root/new.txt".to_string()],
                modified: Vec::new(),
            },
            target.path(),
        )
        .unwrap();

        assert!(!target.path().join("old.txt").exists());
        assert_eq!(
            fs::read_to_string(target.path().join("new.txt")).unwrap(),
            "new"
        );
    }

    /// Handles the applies incremental zip package workflow.
    #[test]
    fn applies_incremental_zip_package() {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut bytes);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("changes.json", options).unwrap();
            zip.write_all(br#"{"added":["root/a.txt"],"deleted":[],"modified":[]}"#)
                .unwrap();
            zip.start_file("root/a.txt", options).unwrap();
            zip.write_all(b"hello").unwrap();
            zip.finish().unwrap();
        }
        let target = tempfile::tempdir().unwrap();

        apply_incremental_package(&bytes.into_inner(), target.path()).unwrap();

        assert_eq!(
            fs::read_to_string(target.path().join("a.txt")).unwrap(),
            "hello"
        );
    }
}
