//! Desktop handoff shared with the legacy PyQt application.

use crate::{UpdaterError, UpdaterResult, mirrorc_credentials};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

const OFFER: &str = ".baas.legacy";
const PENDING: &str = ".baas.legacy.pending";

/// Shared user data directory used by both desktop clients.
pub fn migration_directory(local_data: &Path) -> PathBuf {
    local_data.join("BAAS").join("legacy-ui-migration")
}

/// The part of the handoff that may be returned to the desktop UI.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyAppearance {
    pub install_path: PathBuf,
    pub language: Option<String>,
    pub theme: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preferences {
    #[serde(flatten)]
    pub appearance: LegacyAppearance,
    pub mirrorc_cdk: Option<String>,
}

/// Check for a published handoff, constrained to the executable directory in portable mode.
pub fn available(directory: &Path, required_root: Option<&Path>) -> UpdaterResult<bool> {
    if !is_directory(directory)? {
        return Ok(false);
    }
    let _lock = lock(directory)?;
    let path = directory.join(OFFER);
    if !is_directory(&path)? {
        return Ok(false);
    }
    Ok(required_root.is_none_or(|root| {
        load(&path).is_ok_and(|prefs| same_installation(&prefs.appearance.install_path, root))
    }))
}

/// Filesystem location of the consumed offer during installation.
pub fn pending_path(directory: &Path) -> PathBuf {
    directory.join(PENDING)
}

/// Read an accepted handoff for an interrupted installation.
pub fn pending(
    directory: &Path,
    required_root: Option<&Path>,
) -> UpdaterResult<Option<LegacyAppearance>> {
    if !is_directory(directory)? {
        return Ok(None);
    }
    let path = pending_path(directory);
    if is_directory(&path)? {
        Ok(Some(check_migration(&path, required_root)?))
    } else {
        Ok(None)
    }
}

/// Move the offered snapshot out of the discovery path or discard it.
pub fn decide(
    directory: &Path,
    accept: bool,
    required_root: Option<&Path>,
) -> UpdaterResult<Option<LegacyAppearance>> {
    if !is_directory(directory)? {
        return Ok(None);
    }
    let _lock = lock(directory)?;
    let offer = directory.join(OFFER);
    if !is_directory(&offer)? {
        return if accept { pending(directory, required_root) } else { Ok(None) };
    }
    if !accept {
        fs::remove_dir_all(offer)?;
        return Ok(None);
    }

    let appearance = check_migration(&offer, required_root)?;
    fs::rename(offer, pending_path(directory))?;
    Ok(Some(appearance))
}

fn check_migration(snapshot: &Path, required_root: Option<&Path>) -> UpdaterResult<LegacyAppearance> {
    let prefs = load(snapshot)?;
    let root = &prefs.appearance.install_path;
    if required_root.is_some_and(|required| !same_installation(root, required)) {
        return Err(UpdaterError::Config(
            "The legacy installation is outside the portable BAAS directory.".into(),
        ));
    }
    if !root.join("window.py").is_file() {
        return Err(UpdaterError::Config(
            "The legacy BAAS installation could not be found.".into(),
        ));
    }
    fs::read_dir(snapshot.join("config"))?;
    fs::read_dir(root)?;
    if is_directory(&root.join("config"))? {
        fs::read_dir(root.join("config"))?;
    }
    tempfile::Builder::new()
        .prefix(".baas-migration-check-")
        .tempdir_in(root)?
        .close()?;
    Ok(prefs.appearance)
}

/// Compare native paths without changing the spelling used by the legacy install.
pub fn same_installation(left: &Path, right: &Path) -> bool {
    left.canonicalize()
        .is_ok_and(|left| right.canonicalize().is_ok_and(|right| left == right))
}

pub(crate) fn load(path: &Path) -> UpdaterResult<Preferences> {
    if !is_directory(path)? || !is_directory(&path.join("config"))? {
        return Err(UpdaterError::Config(
            "The legacy config snapshot is missing.".into(),
        ));
    }
    let file = path.join("baas.preference.json");
    if !is_plain(&fs::symlink_metadata(&file)?) || !file.is_file() {
        return Err(UpdaterError::Config(
            "The legacy preferences file is invalid.".into(),
        ));
    }
    let prefs: Preferences = serde_json::from_reader(File::open(file)?)
        .map_err(|_| UpdaterError::Config("The legacy preferences file is invalid.".into()))?;
    if !prefs.appearance.install_path.is_absolute() || !prefs.appearance.install_path.is_dir() {
        return Err(UpdaterError::Config(
            "The legacy install path is unavailable.".into(),
        ));
    }
    Ok(prefs)
}

pub(crate) fn finish(
    pending: &Path,
    root: &Path,
    credential: Option<(&Path, &str)>,
    cancelled: &AtomicBool,
) -> UpdaterResult<()> {
    let directory = pending
        .parent()
        .ok_or_else(|| UpdaterError::Config("The legacy handoff path is invalid.".into()))?;
    let _lock = lock(directory)?;
    let prefs = load(pending)?;
    if prefs.appearance.install_path.canonicalize()? != root.canonicalize()? {
        return Err(UpdaterError::Config(
            "The legacy install path has changed.".into(),
        ));
    }

    // Copy first so a failed copy leaves the installed config and retry snapshot intact.
    let staging = tempfile::Builder::new()
        .prefix(".baas-config-")
        .tempdir_in(root)?;
    let incoming = staging.path().join("incoming");
    copy_config(&pending.join("config"), &incoming)?;
    if cancelled.load(Ordering::Relaxed) {
        return Err(UpdaterError::Cancelled);
    }
    let retired = root.join("config");
    let previous = staging.path().join("previous");
    let had_config = is_directory(&retired)?;
    if had_config {
        fs::rename(&retired, &previous)?;
    }
    if let Err(error) = fs::rename(incoming, &retired) {
        if had_config {
            if let Err(restore_error) = fs::rename(&previous, &retired) {
                let backup = staging.keep();
                return Err(UpdaterError::Io(format!(
                    "Could not restore config: {restore_error}. Backup: {}",
                    backup.join("previous").display()
                )));
            }
        }
        return Err(error.into());
    }

    if let Some((directory, cdk)) = credential {
        let legacy_cdk = prefs.mirrorc_cdk.as_deref().unwrap_or_default().trim();
        if !cdk.is_empty()
            || (!legacy_cdk.is_empty()
                && mirrorc_credentials::load(directory).map_err(UpdaterError::Config)?
                    == legacy_cdk)
        {
            mirrorc_credentials::store(directory, cdk).map_err(UpdaterError::Config)?;
        }
    }
    remove_legacy_launchers(root)?;
    // Retire the handoff in a single rename before deleting its contents.
    let consumed = tempfile::Builder::new()
        .prefix(".baas.legacy-")
        .tempdir_in(directory)?;
    fs::rename(pending, consumed.path().join("consumed"))?;
    consumed.close()?;
    Ok(())
}

fn lock(directory: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(directory.join(".baas.legacy.lock"))?;
    lock.try_lock()?;
    Ok(lock)
}

fn is_directory(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_plain(&metadata) && metadata.is_dir() => Ok(true),
        Ok(_) => Err(io::Error::new(
            ErrorKind::InvalidData,
            format!("Expected a regular directory at {}", path.display()),
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn is_plain(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !metadata.is_symlink()
}

fn copy_config(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        let destination = target.join(entry.file_name());
        if is_plain(&metadata) && metadata.is_dir() {
            copy_config(&path, &destination)?;
        } else if is_plain(&metadata) && metadata.is_file() {
            fs::copy(path, destination)?;
        } else {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "The legacy snapshot contains an unsupported file",
            ));
        }
    }
    Ok(())
}

fn remove_legacy_launchers(root: &Path) -> io::Result<()> {
    let current_exe = std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok());
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.starts_with("bluearchiveautoscript") && name.ends_with(".exe") {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if is_plain(&metadata) && metadata.is_file() && path.canonicalize().ok() != current_exe
            {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let workspace = tempfile::tempdir().unwrap();
        let home = migration_directory(&workspace.path().join("data"));
        let root = workspace.path().join("BlueArchiveAutoScript");
        let offer = home.join(OFFER);
        fs::create_dir_all(offer.join("config/default_config")).unwrap();
        fs::create_dir_all(offer.join("config/第二个配置")).unwrap();
        fs::create_dir_all(root.join("config/extra")).unwrap();
        fs::write(root.join("window.py"), "").unwrap();
        fs::write(root.join("BlueArchiveAutoScript.exe"), "").unwrap();
        fs::write(root.join("unrelated.exe"), "").unwrap();
        fs::write(offer.join("config/default_config/config.json"), "first").unwrap();
        fs::write(offer.join("config/第二个配置/config.json"), "second").unwrap();
        fs::write(
            offer.join("baas.preference.json"),
            serde_json::json!({
                "installPath": root,
                "language": "zh",
                "theme": "dark",
                "mirrorcCdk": "fixture-only"
            })
            .to_string(),
        )
        .unwrap();
        (workspace, home, root)
    }

    #[test]
    fn accepted_handoff_can_retry_until_all_profiles_replace_the_old_config() {
        let (_workspace, home, root) = fixture();
        assert!(available(&home, Some(&root)).unwrap());
        assert!(!available(&home, Some(&home)).unwrap());
        let display = decide(&home, true, None).unwrap().unwrap();
        assert_eq!(display.install_path, root);
        assert_eq!(display.language.as_deref(), Some("zh"));
        assert_eq!(display.theme.as_deref(), Some("dark"));
        assert!(
            serde_json::to_value(display)
                .unwrap()
                .get("mirrorcCdk")
                .is_none()
        );
        assert!(!home.join(OFFER).exists());
        let staged = pending_path(&home);
        assert_eq!(
            load(&staged).unwrap().mirrorc_cdk.as_deref(),
            Some("fixture-only")
        );

        assert_eq!(
            finish(&staged, &root, None, &AtomicBool::new(true)),
            Err(UpdaterError::Cancelled)
        );
        assert!(root.join("BlueArchiveAutoScript.exe").exists());
        assert!(root.join("config/extra").is_dir());
        assert!(pending(&home, None).unwrap().is_some());

        let credentials = home.join("native-credentials");
        finish(
            &staged,
            &root,
            Some((&credentials, "fixture-only")),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            mirrorc_credentials::load(&credentials).unwrap(),
            "fixture-only"
        );
        assert!(pending(&home, None).unwrap().is_none());
        assert_eq!(
            fs::read_to_string(root.join("config/default_config/config.json")).unwrap(),
            "first"
        );
        assert_eq!(
            fs::read_to_string(root.join("config/第二个配置/config.json")).unwrap(),
            "second"
        );
        assert!(!root.join("config/extra").exists());
        assert!(!root.join("BlueArchiveAutoScript.exe").exists());
        assert!(root.join("unrelated.exe").exists());
    }

    #[test]
    fn declining_discards_only_the_handoff() {
        let (_workspace, home, root) = fixture();
        assert!(decide(&home, false, None).unwrap().is_none());
        assert!(!available(&home, None).unwrap());
        assert!(pending(&home, None).unwrap().is_none());
        assert!(root.join("config/extra").exists());
        assert!(root.join("BlueArchiveAutoScript.exe").exists());
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_installation_keeps_the_offer_and_pending_snapshot_intact() {
        use std::os::unix::fs::PermissionsExt;

        let (_workspace, directory, root) = fixture();
        let set_mode = |mode| fs::set_permissions(&root, fs::Permissions::from_mode(mode)).unwrap();
        set_mode(0o555);
        let denied_offer = decide(&directory, true, None);
        set_mode(0o755);
        assert!(matches!(denied_offer, Err(UpdaterError::Io(_))));
        assert!(directory.join(OFFER).exists());
        assert!(!pending_path(&directory).exists());

        decide(&directory, true, None).unwrap().unwrap();
        set_mode(0o555);
        let denied_pending = pending(&directory, None);
        set_mode(0o755);
        assert!(matches!(denied_pending, Err(UpdaterError::Io(_))));
        assert!(pending(&directory, None).unwrap().is_some());
        assert!(root.join("config/extra").is_dir());
        assert!(root.join("BlueArchiveAutoScript.exe").exists());
    }

    #[test]
    fn a_busy_handoff_can_be_skipped_without_waiting_for_the_writer() {
        let (_workspace, directory, _root) = fixture();
        let writer = lock(&directory).unwrap();
        assert!(available(&directory, None).is_err());
        assert!(decide(&directory, true, None).is_err());
        drop(writer);
        assert!(available(&directory, None).unwrap());
    }
}
