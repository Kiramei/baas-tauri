//! MirrorC update client and package application helpers.

use crate::{
    OutputSink, OutputStyle, RepositoryKind, UpdateChannel, UpdateStatus, UpdaterError,
    UpdaterResult,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(not(target_os = "android"))]
use std::io::Read;
use std::{
    fs,
    io::Cursor,
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
#[derive(Clone, PartialEq, Eq)]
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

impl std::fmt::Debug for MirrorLatest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MirrorLatest")
            .field("code", &self.code)
            .field("has_data", &self.has_data)
            .field("has_url", &self.has_url())
            .field("update_type", &self.update_type)
            .field("file_size", &self.file_size)
            .finish_non_exhaustive()
    }
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

#[cfg(not(target_os = "android"))]
fn mirrorc_http_client(
    timeout: Duration,
    follow_redirects: bool,
) -> UpdaterResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        // MirrorC API requests and package redirects must always use a direct connection.
        .no_proxy()
        .referer(false)
        .redirect(if follow_redirects {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        })
        .timeout(timeout)
        .build()
        .map_err(mirrorc_network_error)
}

#[cfg(not(target_os = "android"))]
fn mirrorc_network_error(error: reqwest::Error) -> UpdaterError {
    // API URLs contain the CDK, and package URLs may contain temporary credentials.
    UpdaterError::Network(error.without_url().to_string())
}

#[cfg(not(target_os = "android"))]
impl MirrorHttp for ReqwestMirrorHttp {
    /// Returns the get json result.
    fn get_json(&self, url: &str, timeout: Duration) -> UpdaterResult<serde_json::Value> {
        let client = mirrorc_http_client(timeout, false)?;
        let response = client.get(url).send().map_err(mirrorc_network_error)?;
        let status = response.status().as_u16();
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
        let client = mirrorc_http_client(timeout, true)?;
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

// Android already ships minreq with bundled TLS roots. No JVM trust-store bootstrap is needed.
#[cfg(target_os = "android")]
impl MirrorHttp for ReqwestMirrorHttp {
    fn get_json(&self, url: &str, timeout: Duration) -> UpdaterResult<serde_json::Value> {
        let response = minreq::get(url)
            .with_timeout(timeout.as_secs())
            .with_follow_redirects(false)
            .send()
            .map_err(|_| UpdaterError::Network("MirrorC API request failed".into()))?;
        let body = response
            .as_str()
            .map_err(|_| UpdaterError::Network("MirrorC returned invalid text".into()))?;
        parse_mirrorc_json_body(response.status_code, body)
    }

    fn download(
        &self,
        url: &str,
        timeout: Duration,
        _: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<Vec<u8>> {
        let response = minreq::get(url)
            .with_timeout(timeout.as_secs())
            .with_max_redirects(10)
            .send()
            .map_err(|_| UpdaterError::Network("MirrorC package download failed".into()))?;
        if !(200..300).contains(&response.status_code) {
            return Err(UpdaterError::Network(format!(
                "MirrorC package HTTP {}",
                response.status_code
            )));
        }
        Ok(response.into_bytes())
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
        let url = mirrorc_latest_url(kind, channel, current_version, cdk)?;
        let mut latest = parse_latest_response(self.http.get_json(&url, self.timeout)?)?;
        if !cdk.trim().is_empty() {
            // Both error messages and metadata can be echoed by a gateway.
            latest.message = redact_cdk(&latest.message, cdk.trim());
            if let Some(note) = latest.release_note.as_mut() {
                *note = redact_cdk(note, cdk.trim());
            }
            if latest
                .latest_version_name
                .as_deref()
                .is_some_and(|v| redact_cdk(v, cdk.trim()) != v)
            {
                return Err(UpdaterError::MirrorC(
                    "MirrorC returned an invalid version".into(),
                ));
            }
        }
        Ok(latest)
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
        if request.current_version.is_empty()
            && latest.update_type == Some(MirrorUpdateType::Incremental)
        {
            return Err(UpdaterError::MirrorC(
                "MirrorC returned an incremental package without an installed base version".into(),
            ));
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
        if !download_url.starts_with("https://") {
            return Err(UpdaterError::MirrorC(
                "MirrorC returned an insecure package URL".into(),
            ));
        }
        let expected_sha = latest
            .sha256
            .as_deref()
            .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
            .ok_or_else(|| UpdaterError::MirrorC("MirrorC package has no valid SHA-256".into()))?;
        // API calls are short. A full repository package can take several minutes.
        let download_timeout = self.timeout.max(Duration::from_secs(300));
        let package = self.http.download(download_url, download_timeout, output)?;
        if latest
            .file_size
            .is_some_and(|size| size != package.len() as u64)
        {
            return Err(UpdaterError::MirrorC(
                "MirrorC package size does not match".into(),
            ));
        }
        let actual_sha: String = Sha256::digest(&package)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if !actual_sha.eq_ignore_ascii_case(expected_sha) {
            return Err(UpdaterError::MirrorC(
                "MirrorC package SHA-256 does not match".into(),
            ));
        }
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

/// Only the upstream stable repository is published as a BAAS backend on MirrorChyan.
/// BAAS_Cpp is a separate release product, not the platform-specific OCR prebuild checkout.
pub fn supports_mirror_package(kind: RepositoryKind, channel: UpdateChannel) -> bool {
    kind == RepositoryKind::Main && channel == UpdateChannel::Stable
}

fn redact_cdk(text: &str, cdk: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(cdk.as_bytes()).collect();
    text.replace(cdk, "[redacted]")
        .replace(&encoded, "[redacted]")
}

/// Builds the official resource URL and percent-encodes each user-supplied value.
pub fn mirrorc_latest_url(
    kind: RepositoryKind,
    channel: UpdateChannel,
    current_version: &str,
    cdk: &str,
) -> UpdaterResult<String> {
    if !supports_mirror_package(kind, channel) {
        return Err(UpdaterError::MirrorC("MirrorChyan only publishes the stable BAAS backend. Use Git for development or OCR packages.".into()));
    }
    let mut url =
        url::Url::parse(&format!("{MIRRORC_BASE_URL}/BAAS_repo/latest")).expect("MirrorC base URL");
    url.query_pairs_mut()
        .append_pair("channel", "stable")
        .append_pair("current_version", current_version)
        .append_pair("user_agent", USER_AGENT);
    if !cdk.trim().is_empty() {
        url.query_pairs_mut().append_pair("cdk", cdk.trim());
    }
    Ok(url.into())
}

/// Parses a MirrorC latest JSON response.
pub fn parse_latest_response(value: serde_json::Value) -> UpdaterResult<MirrorLatest> {
    let response: RawLatestResponse = serde_json::from_value(value)
        .map_err(|_| UpdaterError::MirrorC("MirrorC returned malformed metadata".into()))?;
    let has_data = response.data.is_some();
    if response.code == 0
        && !response
            .data
            .as_ref()
            .and_then(|d| d.version_name.as_deref())
            .is_some_and(|s| !s.trim().is_empty())
    {
        return Err(UpdaterError::MirrorC(
            "MirrorC success response missing version".into(),
        ));
    }
    let data = response.data.unwrap_or_default();
    Ok(MirrorLatest {
        code: response.code,
        message: response.message,
        has_data,
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
fn parse_mirrorc_json_body(status: u16, body: &str) -> UpdaterResult<serde_json::Value> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        return Ok(value);
    }

    if (200..300).contains(&status) {
        Err(UpdaterError::Network(
            "MirrorC returned invalid JSON".into(),
        ))
    } else {
        Err(UpdaterError::Network(format!("MirrorC HTTP {status}")))
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
    let temp = package_staging_dir(target_dir)?;
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
    let temp = package_staging_dir(target_dir)?;
    with_optional_spinner(output, "Extracting MirrorC full package", || {
        extract_zip(package, temp.path())
    })?;
    let entries = fs::read_dir(temp.path())?.collect::<Result<Vec<_>, _>>()?;
    let source_root = match entries.as_slice() {
        [entry] if entry.file_type()?.is_dir() => entry.path(),
        [] => {
            return Err(UpdaterError::MirrorC(
                "MirrorC full package is empty".into(),
            ));
        }
        _ => temp.path().to_path_buf(),
    };
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
    // Preflight the whole manifest before deleting or replacing any live file.
    let mut operations = Vec::new();
    for (kind, paths) in [
        ("delete", &changes.deleted),
        ("add", &changes.added),
        ("modify", &changes.modified),
    ] {
        for path in paths {
            let source_path = checked_package_path(path)?;
            let relative = remove_first_dir(path);
            if is_local_path(&relative) {
                continue;
            }
            let target = checked_destination(target_dir, &relative)?;
            let source = if kind == "delete" {
                None
            } else {
                let file = checked_destination(source_dir, &source_path)?;
                if !file.is_file() {
                    return Err(UpdaterError::MirrorC(
                        "MirrorC manifest references a missing file".into(),
                    ));
                }
                Some(file)
            };
            operations.push((kind, target, source));
        }
    }
    let total = operations.len() as u64;
    let apply = |progress: &mut dyn FnMut(u64, &str)| -> UpdaterResult<()> {
        for (index, (kind, target, source)) in operations.iter().enumerate() {
            if let Some(source) = source {
                copy_package_file(source, target)?;
            } else if target.is_file() {
                fs::remove_file(target)?;
            }
            progress(index as u64 + 1, kind);
        }
        Ok(())
    };
    if let Some(term) = output.thread_output() {
        term.with_progress_bar(
            "mirror apply",
            total.max(1),
            30,
            "MirrorC update applied",
            |bar| {
                apply(&mut |current, kind| bar.set(current, format!("{kind} {current}/{total}")))
                    .map_err(|e| e.message())
            },
        )
        .map_err(UpdaterError::MirrorC)
    } else {
        apply(&mut |_, _| {})
    }
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

/// Returns the extract zip result.
fn extract_zip(package: &[u8], out_dir: &Path) -> UpdaterResult<()> {
    let mut archive = ZipArchive::new(Cursor::new(package))?;
    for i in 0..archive.len() {
        let entry = archive.by_index(i)?;
        checked_package_path(entry.name())?;
        if entry.is_symlink() || entry.enclosed_name().is_none() {
            return Err(UpdaterError::MirrorC(
                "MirrorC archive contains an unsafe entry".into(),
            ));
        }
    }
    archive.extract(out_dir)?;
    Ok(())
}

fn package_staging_dir(target: &Path) -> UpdaterResult<tempfile::TempDir> {
    fs::create_dir_all(target)?;
    Ok(tempfile::Builder::new()
        .prefix(".mirrorc-staging-")
        .tempdir_in(target)?)
}

fn checked_package_path(name: &str) -> UpdaterResult<PathBuf> {
    let path = Path::new(name);
    if name.is_empty()
        || name.contains(['\\', ':', '\0'])
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(UpdaterError::MirrorC(
            "MirrorC package contains an invalid path".into(),
        ));
    }
    Ok(path.into())
}

// These paths belong to the installation and its user, independently of the backend checkout.
fn is_local_path(relative: &Path) -> bool {
    let top = relative
        .components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase());
    matches!(
        top.as_deref(),
        Some(
            "setup.toml"
                | "config"
                | "output"
                | "screenshot"
                | "screenshots"
                | "data"
                | ".git"
                | ".secret"
                | ".baas-updater"
                | ".baas-cli-runtime.json"
                | ".baas-cli-install.lock"
                | ".venv"
                | "toolkit"
                | "tmp"
        )
    ) || relative.starts_with("core/ocr/baas_ocr_client/bin")
}

fn checked_destination(root: &Path, relative: &Path) -> UpdaterResult<PathBuf> {
    let mut target = root.to_path_buf();
    for component in relative.components() {
        target.push(component.as_os_str());
        if target
            .symlink_metadata()
            .is_ok_and(|meta| meta.file_type().is_symlink())
        {
            return Err(UpdaterError::MirrorC(
                "MirrorC destination contains a symbolic link".into(),
            ));
        }
    }
    Ok(target)
}

fn copy_package_file(source: &Path, target: &Path) -> UpdaterResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| UpdaterError::MirrorC("Invalid package destination".into()))?;
    fs::create_dir_all(parent)?;
    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    fs::copy(source, temporary.path())?;
    temporary.persist(target).map_err(|e| e.error)?;
    Ok(())
}

pub(crate) fn copy_dir_contents(source: &Path, target: &Path) -> UpdaterResult<()> {
    fs::create_dir_all(target)?;
    let mut dirs = vec![PathBuf::new()];
    let mut files = Vec::new();
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(source.join(&dir))? {
            let entry = entry?;
            let relative = dir.join(entry.file_name());
            if is_local_path(&relative) {
                continue;
            }
            let destination = checked_destination(target, &relative)?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                return Err(UpdaterError::MirrorC(
                    "MirrorC staging contains a symbolic link".into(),
                ));
            }
            if file_type.is_dir() {
                dirs.push(relative);
            } else if file_type.is_file() {
                files.push((entry.path(), destination));
            }
        }
    }
    for (source, destination) in files {
        copy_package_file(&source, &destination)?;
    }
    Ok(())
}

/// Handles the transfer detail workflow.
#[cfg(not(target_os = "android"))]
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
#[cfg(not(target_os = "android"))]
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

#[cfg(all(test, not(target_os = "android")))]
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
                // Winsock inherits the listener's nonblocking mode; wait for request
                // bytes within the existing read timeout instead of racing the client.
                stream.set_nonblocking(false).unwrap();
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

    #[test]
    fn only_supported_sources_receive_encoded_credentials() {
        let cdk = "fixture a+b/1&2";
        let url: url::Url =
            mirrorc_latest_url(RepositoryKind::Main, UpdateChannel::Stable, "v+1", cdk)
                .unwrap()
                .parse()
                .unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(params["cdk"], cdk);
        assert_eq!(params["current_version"], "v+1");
        assert_eq!(params["channel"], "stable");
        assert!(!redact_cdk(url.as_str(), cdk).contains("fixture"));
        assert!(mirrorc_latest_url(RepositoryKind::Main, UpdateChannel::Dev, "", cdk).is_err());
        assert!(mirrorc_latest_url(RepositoryKind::Cpp, UpdateChannel::Stable, "", cdk).is_err());
        assert!(
            !mirrorc_latest_url(RepositoryKind::Main, UpdateChannel::Stable, "", "")
                .unwrap()
                .contains("cdk=")
        );
        assert!(
            !parse_mirrorc_json_body(502, cdk)
                .unwrap_err()
                .message()
                .contains("fixture")
        );
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
            403,
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
