//! Read-only upstream checks and managed updates through the desktop workflow.

use super::{Inspection, Progress, inspect, install};
use baas_updater::{
    RepositoryKind, UpdateChannel, UpdaterError, UpdaterResult,
    config::ConfigManager,
    repo::{GitExecutor, RealGitExecutor, repository_branch, repository_urls},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryUpdate {
    pub name: String,
    pub local_version: String,
    pub remote_version: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub root: std::path::PathBuf,
    pub channel: UpdateChannel,
    pub available: bool,
    pub repositories: Vec<RepositoryUpdate>,
}

fn require_managed(root: &Path) -> UpdaterResult<Inspection> {
    let state = inspect(root)?;
    if !state.installed || !state.managed || state.channel != UpdateChannel::Dev {
        return Err(UpdaterError::Environment(
            "updates require a complete CLI-managed dev runtime".into(),
        ));
    }
    Ok(state)
}

fn valid_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// This is only an advisory check. Applying an update still uses the shared
/// source validation, mirror failover and guarded forward-update workflow.
pub fn check_update(
    root: &Path,
    cancelled: &AtomicBool,
    emit: &mut impl FnMut(Progress),
) -> UpdaterResult<UpdateCheck> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("BAAS-CLI-runtime")
        .build()
        .map_err(|error| UpdaterError::Network(error.to_string()))?;
    check_with(root, cancelled, emit, |url, branch| {
        let repository = url
            .strip_prefix("https://github.com/")
            .and_then(|value| value.strip_suffix(".git"))
            .ok_or_else(|| {
                UpdaterError::Config("update check requires an official GitHub repository".into())
            })?;
        let response = client
            .get(format!(
                "https://api.github.com/repos/{repository}/git/ref/heads/{branch}"
            ))
            .header("Accept", "application/vnd.github+json")
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        let mut bytes = Vec::new();
        response.take(65_537).read_to_end(&mut bytes)?;
        if bytes.len() > 65_536 {
            return Err(UpdaterError::Network(
                "upstream version response exceeded its limit".into(),
            ));
        }
        let response: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        response
            .get("object")
            .and_then(|object| object.get("sha"))
            .and_then(serde_json::Value::as_str)
            .filter(|value| valid_sha(value))
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| {
                UpdaterError::Network("upstream did not return a valid commit SHA".into())
            })
    })
}

fn check_with(
    root: &Path,
    cancelled: &AtomicBool,
    emit: &mut impl FnMut(Progress),
    mut remote: impl FnMut(&str, &str) -> UpdaterResult<String>,
) -> UpdaterResult<UpdateCheck> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(UpdaterError::Cancelled);
    }
    let state = require_managed(root)?;
    let manager = ConfigManager::load_from(state.root.join("setup.toml"))?;
    let mut repositories = Vec::new();
    for (kind, name, path, recorded) in [
        (
            RepositoryKind::Main,
            "backend",
            state.root.clone(),
            &manager.config.general.current_baas_sha,
        ),
        (
            RepositoryKind::Cpp,
            "ocr",
            state.cpp_path.clone(),
            &manager.config.general.current_baas_cpp_sha,
        ),
    ] {
        if cancelled.load(Ordering::Relaxed) {
            return Err(UpdaterError::Cancelled);
        }
        emit(Progress::status(
            &format!("check-{name}"),
            format!("Checking {name} upstream version"),
            "running",
        ));
        let local = RealGitExecutor
            .local_sha_git2(&path)
            .ok()
            .filter(|value| valid_sha(value))
            .or_else(|| valid_sha(recorded).then(|| recorded.clone()))
            .unwrap_or_else(|| "unknown".into())
            .to_ascii_lowercase();
        let urls = repository_urls(kind, state.channel);
        let remote_version = remote(&urls[0], &repository_branch(kind)?)?;
        if cancelled.load(Ordering::Relaxed) {
            return Err(UpdaterError::Cancelled);
        }
        if !valid_sha(&remote_version) {
            return Err(UpdaterError::Network("invalid upstream version".into()));
        }
        let remote_version = remote_version.to_ascii_lowercase();
        let available = local != remote_version;
        repositories.push(RepositoryUpdate {
            name: name.into(),
            local_version: local,
            remote_version,
            available,
        });
        emit(Progress::status(
            &format!("check-{name}"),
            if available {
                "Update available"
            } else {
                "Already current"
            },
            "complete",
        ));
    }
    Ok(UpdateCheck {
        root: state.root,
        channel: state.channel,
        available: repositories.iter().any(|repository| repository.available),
        repositories,
    })
}

/// The caller must first release its backend lease. Other CLI processes hold
/// shared leases, so the existing workflow's exclusive install lock rejects
/// updates while any of their managed backends are still alive.
pub fn update(
    root: &Path,
    cancelled: &AtomicBool,
    emit: &mut impl FnMut(Progress),
) -> UpdaterResult<Inspection> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(UpdaterError::Cancelled);
    }
    let state = require_managed(root)?;
    install(&state.root, state.channel, cancelled, emit)
}

/// Hold this file for the backend's entire lifetime. Process exit releases the
/// OS lock, including crashes; no stale PID file can block a future launch.
pub fn acquire_lease(root: &Path) -> UpdaterResult<File> {
    let state = require_managed(root)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(state.root.join(".baas-cli-install.lock"))?;
    lock.try_lock_shared()
        .map_err(|_| UpdaterError::Workflow("this runtime is being installed or updated".into()))?;
    require_managed(&state.root)?;
    Ok(lock)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_do_not_create_an_uninstalled_root_or_contact_upstream() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("missing");
        assert!(
            check_with(&root, &AtomicBool::new(false), &mut |_| {}, |_, _| panic!(
                "network must not run"
            ))
            .is_err()
        );
        assert!(!root.exists());
        assert!(update(&root, &AtomicBool::new(false), &mut |_| {}).is_err());
        assert!(!root.exists());
    }

    #[test]
    fn version_check_reads_actual_installation_and_does_not_modify_it() {
        let temp = tempfile::tempdir().unwrap();
        let state = super::super::install_with(
            temp.path(),
            UpdateChannel::Dev,
            &AtomicBool::new(false),
            &mut |_| {},
            |root, _| {
                super::super::tests::fixture(root);
                Ok(())
            },
        )
        .unwrap();
        let config_path = state.root.join("setup.toml");
        let mut manager = ConfigManager::load_from(&config_path).unwrap();
        manager.config.general.current_baas_sha = "a".repeat(40);
        manager.config.general.current_baas_cpp_sha = "b".repeat(40);
        manager.save().unwrap();
        let before = std::fs::read(&config_path).unwrap();
        let mut sources = Vec::new();
        let checked = check_with(
            &state.root,
            &AtomicBool::new(false),
            &mut |_| {},
            |url, branch| {
                sources.push((url.to_owned(), branch.to_owned()));
                Ok(if branch == "master" {
                    "a".repeat(40)
                } else {
                    "c".repeat(40)
                })
            },
        )
        .unwrap();
        assert!(checked.available);
        assert!(!checked.repositories[0].available);
        assert!(checked.repositories[1].available);
        assert_eq!(
            sources[0],
            (
                "https://github.com/Kiramei/baas-dev.git".into(),
                "master".into()
            )
        );
        assert_eq!(std::fs::read(&config_path).unwrap(), before);
        let lease = acquire_lease(&state.root).unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(state.root.join(".baas-cli-install.lock"))
            .unwrap();
        assert!(lock.try_lock().is_err());
        assert!(
            update(&state.root, &AtomicBool::new(false), &mut |_| {})
                .unwrap_err()
                .message()
                .contains("another installer")
        );
        drop(lease);
        assert!(lock.try_lock().is_ok());
    }
}
