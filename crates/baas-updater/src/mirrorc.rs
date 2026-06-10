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
    fn download(&self, url: &str, timeout: Duration) -> UpdaterResult<Vec<u8>>;
}

/// Blocking reqwest MirrorC HTTP implementation.
#[derive(Debug, Clone, Default)]
pub struct ReqwestMirrorHttp;

impl MirrorHttp for ReqwestMirrorHttp {
    fn get_json(&self, url: &str, timeout: Duration) -> UpdaterResult<serde_json::Value> {
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        client
            .get(url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .and_then(reqwest::blocking::Response::json)
            .map_err(|error| UpdaterError::Network(error.to_string()))
    }

    fn download(&self, url: &str, timeout: Duration) -> UpdaterResult<Vec<u8>> {
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        let mut response = client
            .get(url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        let mut bytes = Vec::new();
        response
            .read_to_end(&mut bytes)
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
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
        let package = self.http.download(download_url, self.timeout)?;
        match latest.update_type.unwrap_or(MirrorUpdateType::Full) {
            MirrorUpdateType::Full => {
                output.line(OutputStyle::Info, "Applying MirrorC full package");
                apply_full_package(&package, request.target_dir)?;
                Ok(MirrorUpdateResult {
                    kind: request.kind,
                    status: UpdateStatus::Installed,
                    version,
                })
            }
            MirrorUpdateType::Incremental => {
                output.line(OutputStyle::Info, "Applying MirrorC incremental package");
                apply_incremental_package(&package, request.target_dir)?;
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
    channel: UpdateChannel,
    current_version: &str,
    cdk: &str,
) -> String {
    let app = match kind {
        RepositoryKind::Main => "BAAS_repo",
        RepositoryKind::Cpp => "BAAS_Cpp",
    };
    let mut url = format!(
        "{MIRRORC_BASE_URL}/{app}/latest?channel={}&current_version={}&user_agent={USER_AGENT}&cdk={}",
        channel.as_str(),
        current_version,
        cdk
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
    let temp = tempfile::tempdir()?;
    extract_zip(package, temp.path())?;
    let changes_path = temp.path().join("changes.json");
    let changes: ChangeSet = serde_json::from_str(&fs::read_to_string(changes_path)?)
        .map_err(|error| UpdaterError::MirrorC(error.to_string()))?;
    apply_changes(temp.path(), &changes, target_dir)
}

/// Applies a MirrorC full package zip to a target directory.
pub fn apply_full_package(package: &[u8], target_dir: &Path) -> UpdaterResult<()> {
    let temp = tempfile::tempdir()?;
    extract_zip(package, temp.path())?;
    let source_root = first_child_dir(temp.path()).unwrap_or_else(|| temp.path().to_path_buf());
    copy_dir_contents(&source_root, target_dir)
}

/// Applies a parsed MirrorC change set.
pub fn apply_changes(
    source_dir: &Path,
    changes: &ChangeSet,
    target_dir: &Path,
) -> UpdaterResult<()> {
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

fn mirrorc_error(latest: &MirrorLatest) -> UpdaterError {
    let detail = latest
        .cdk_state()
        .map(|state| format!("CDK state: {state:?}"))
        .unwrap_or_else(|| latest.message.clone());
    UpdaterError::MirrorC(format!("MirrorC did not provide a download URL: {detail}"))
}

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

fn extract_zip(package: &[u8], out_dir: &Path) -> UpdaterResult<()> {
    let mut archive = ZipArchive::new(Cursor::new(package))?;
    archive.extract(out_dir)?;
    Ok(())
}

fn first_child_dir(path: &Path) -> Option<PathBuf> {
    fs::read_dir(path)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir())
}

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

fn copy_changed_file(source_dir: &Path, target_dir: &Path, changed: &str) -> UpdaterResult<()> {
    let source = source_dir.join(changed);
    let target = target_dir.join(remove_first_dir(changed));
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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

    #[test]
    fn maps_cdk_error_without_url() {
        let latest = parse_latest_response(serde_json::json!({
            "code": 7002,
            "msg": "invalid",
            "data": {}
        }))
        .unwrap();

        assert_eq!(latest.cdk_state(), Some(CdkState::Invalid));
        assert!(mirrorc_error(&latest).message().contains("Invalid"));
    }

    #[test]
    fn removes_first_directory_component() {
        assert_eq!(remove_first_dir("root/a/b.txt"), PathBuf::from("a/b.txt"));
        assert_eq!(remove_first_dir("file.txt"), PathBuf::from("file.txt"));
    }

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
