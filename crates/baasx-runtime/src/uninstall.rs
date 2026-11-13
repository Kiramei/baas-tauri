//! Conservative removal and restoration of CLI-owned backend program files.
//!
//! The backend shares its checkout with user data. Never recursively remove
//! directories or use a Git reset/clean: only remove verified, unchanged
//! program blobs, and keep enough information to restore them without touching
//! a user-created replacement.

use super::{Inspection, InstallationMarker, Progress, inspect, normalize_root, validate_anchors};
use baas_updater::{
    UpdaterError, UpdaterResult, config::ConfigManager, constants::MAIN_REPO_SRC_DEV,
};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, DirBuilder, OpenOptions as CapOpenOptions},
};
use git2::{ObjectType, Oid, Repository, Status};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct RemovedFile {
    path: String,
    oid: String,
    mode: u32,
    crlf: bool,
}

fn git(error: git2::Error) -> UpdaterError {
    UpdaterError::Git(error.to_string())
}

fn protected_component(part: &str) -> bool {
    matches!(
        part.to_ascii_lowercase().as_str(),
        ".git"
            | ".venv"
            | ".baas-updater"
            | "toolkit"
            | "config"
            | "configs"
            | "data"
            | "user"
            | "users"
            | "log"
            | "logs"
            | "cache"
            | "tmp"
    )
}

fn program_path(path: &Path) -> bool {
    let mut components = path.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(part) = component else {
            return false;
        };
        let Some(part) = part.to_str() else {
            return false;
        };
        if protected_component(part) {
            return false;
        }
        if components.peek().is_none() {
            let name = part.to_ascii_lowercase();
            if name.starts_with('.') || name.contains("config") || name.contains("setting") {
                return false;
            }
            return [
                ".py", ".pyc", ".pyo", ".so", ".pyd", ".dll", ".dylib", ".exe", ".sh",
            ]
            .iter()
            .any(|extension| name.ends_with(extension));
        }
    }
    false
}

fn reject_symlink_ancestors(root: &Path, path: &Path) -> UpdaterResult<()> {
    let mut current = root.to_path_buf();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err(UpdaterError::Config("invalid backend program path".into()));
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(UpdaterError::Config(
                    "backend program path contains a symbolic link".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn root_dir(root: &Path) -> UpdaterResult<Dir> {
    let parent = root
        .parent()
        .ok_or_else(|| UpdaterError::Config("invalid runtime root".into()))?;
    let name = root
        .file_name()
        .ok_or_else(|| UpdaterError::Config("invalid runtime root".into()))?;
    Ok(Dir::open_ambient_dir(parent, ambient_authority())?.open_dir_nofollow(name)?)
}

fn parent_dir(root: &Dir, path: &Path) -> UpdaterResult<Dir> {
    let mut dir = root.try_clone()?;
    for component in path.parent().unwrap_or_else(|| Path::new("")).components() {
        let Component::Normal(part) = component else {
            return Err(UpdaterError::Config("invalid backend program path".into()));
        };
        dir = dir.open_dir_nofollow(part)?;
    }
    Ok(dir)
}

fn read_nofollow_with_identity(
    dir: &Dir,
    name: &std::ffi::OsStr,
) -> std::io::Result<(Vec<u8>, (u64, u64))> {
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = dir.open_with(name, &options)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok((bytes, (metadata.dev(), metadata.ino())))
}

fn read_nofollow(dir: &Dir, name: &std::ffi::OsStr) -> std::io::Result<Vec<u8>> {
    read_nofollow_with_identity(dir, name).map(|(bytes, _)| bytes)
}

fn read_marker_cap(dir: &Dir, root: &Path) -> UpdaterResult<InstallationMarker> {
    let bytes = read_nofollow(dir, std::ffi::OsStr::new(super::MARKER_FILE))?;
    let marker: InstallationMarker = serde_json::from_slice(&bytes)
        .map_err(|error| UpdaterError::Config(format!("invalid CLI runtime marker: {error}")))?;
    if marker.owner != super::OWNER
        || marker.schema_version != super::SCHEMA_VERSION
        || marker.root != root
    {
        return Err(UpdaterError::Config(
            "the directory is not owned by this CLI runtime".into(),
        ));
    }
    Ok(marker)
}

fn write_marker_cap(dir: &Dir, marker: &InstallationMarker) -> UpdaterResult<()> {
    let temporary = format!(".baas-cli-marker-{}.tmp", uuid::Uuid::new_v4());
    let mut options = CapOpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut output = dir.open_with(&temporary, &options)?;
    serde_json::to_writer_pretty(&mut output, marker)
        .map_err(|error| UpdaterError::Config(error.to_string()))?;
    output.write_all(b"\n")?;
    output.sync_all()?;
    drop(output);
    dir.rename(&temporary, dir, super::MARKER_FILE)?;
    Ok(())
}

fn quarantine_name(marker: &InstallationMarker) -> UpdaterResult<&str> {
    let name = marker
        .uninstall_quarantine
        .as_deref()
        .ok_or_else(|| UpdaterError::Config("missing uninstall quarantine record".into()))?;
    let suffix = name
        .strip_prefix(".baas-cli-uninstall-")
        .ok_or_else(|| UpdaterError::Config("invalid uninstall quarantine".into()))?;
    uuid::Uuid::parse_str(suffix)
        .map_err(|_| UpdaterError::Config("invalid uninstall quarantine".into()))?;
    Ok(name)
}

fn new_quarantine(root: &Dir) -> UpdaterResult<String> {
    let name = format!(".baas-cli-uninstall-{}", uuid::Uuid::new_v4());
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    {
        use cap_std::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    root.create_dir_with(&name, &builder)?;
    Ok(name)
}

fn write_restore_slot(dir: &Dir, slot: &str, expected: &[u8], mode: u32) -> UpdaterResult<()> {
    let staging = format!("stage-{}", uuid::Uuid::new_v4());
    let mut options = CapOpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut output = dir.open_with(&staging, &options)?;
    output.write_all(expected)?;
    output.sync_all()?;
    #[cfg(unix)]
    if mode == 0o100755 {
        use cap_std::fs::PermissionsExt;
        output.set_permissions(cap_std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    drop(output);
    // A crash before this hard link leaves only a private staging file.
    // hard_link never overwrites an existing destination.
    dir.hard_link(&staging, dir, slot)?;
    dir.remove_file(&staging)?;
    Ok(())
}

fn repository(root: &Path) -> UpdaterResult<Repository> {
    super::reject_symlink(&root.join(".git"))?;
    let repo = Repository::open(root).map_err(|_| {
        UpdaterError::Config("cannot safely identify the managed backend Git repository".into())
    })?;
    if repo.workdir() != Some(root) {
        // libgit2 often represents workdirs with a trailing separator.
        if repo.workdir().map(Path::canonicalize).transpose()? != Some(root.canonicalize()?) {
            return Err(UpdaterError::Config(
                "backend Git repository does not match the managed root".into(),
            ));
        }
    }
    let head = repo.head().map_err(git)?;
    let branch = head.shorthand().map_err(git)?;
    if branch.is_empty() {
        return Err(UpdaterError::Config(
            "backend repository has no tracked branch".into(),
        ));
    }
    let actual = head.peel_to_commit().map_err(git)?.id();
    let origin = repo
        .find_remote("origin")
        .map_err(|_| UpdaterError::Config("backend repository has no trusted origin".into()))?;
    let origin_url = origin
        .url()
        .map_err(|_| UpdaterError::Config("backend origin URL is invalid".into()))?;
    if !std::iter::once(MAIN_REPO_SRC_DEV.main)
        .chain(MAIN_REPO_SRC_DEV.proxy.iter().copied())
        .any(|trusted| trusted == origin_url)
    {
        return Err(UpdaterError::Config(
            "backend origin is not a trusted BAAS source".into(),
        ));
    }
    let config = ConfigManager::load_from(root.join("setup.toml"))?;
    if config.config.general.current_baas_sha != actual.to_string() {
        return Err(UpdaterError::Config(
            "backend version differs from the installed baseline; refusing to remove user content"
                .into(),
        ));
    }
    let reference = repo
        .find_reference(&format!("refs/remotes/origin/{branch}"))
        .and_then(|reference| reference.peel_to_commit())
        .map_err(|_| {
            UpdaterError::Config("backend repository has no matching upstream reference".into())
        })?;
    if actual != reference.id() {
        return Err(UpdaterError::Config(
            "backend repository contains local commits; refusing to remove user content".into(),
        ));
    }
    drop(reference);
    drop(origin);
    drop(head);
    Ok(repo)
}

fn expected_bytes(blob: &[u8], crlf: bool) -> Vec<u8> {
    if !crlf {
        return blob.to_vec();
    }
    let mut result = Vec::with_capacity(blob.len());
    for &byte in blob {
        if byte == b'\n' {
            result.push(b'\r');
        }
        result.push(byte);
    }
    result
}

fn plan(root: &Path, repo: &Repository) -> UpdaterResult<Vec<RemovedFile>> {
    let tree = repo
        .head()
        .and_then(|head| head.peel_to_tree())
        .map_err(git)?;
    let index = repo.index().map_err(git)?;
    let mut files = Vec::new();
    for entry in index.iter() {
        if entry.mode != 0o100644 && entry.mode != 0o100755 {
            continue;
        }
        let Ok(name) = std::str::from_utf8(&entry.path) else {
            continue;
        };
        let path = Path::new(name);
        if !program_path(path) {
            continue;
        }
        let Ok(tracked) = tree.get_path(path) else {
            continue;
        };
        if tracked.kind() != Some(ObjectType::Blob)
            || tracked.id() != entry.id
            || tracked.filemode() as u32 != entry.mode
        {
            continue;
        }
        if repo.status_file(path).map_err(git)? != Status::CURRENT {
            continue;
        }
        reject_symlink_ancestors(root, path)?;
        let full = root.join(path);
        if !full.is_file() {
            continue;
        }
        let bytes = fs::read(&full)?;
        let blob = repo.find_blob(entry.id).map_err(git)?;
        let crlf = if bytes == blob.content() {
            false
        } else if bytes == expected_bytes(blob.content(), true) {
            true
        } else {
            continue;
        };
        files.push(RemovedFile {
            path: name.to_owned(),
            oid: entry.id.to_string(),
            mode: entry.mode,
            crlf,
        });
    }
    if !files.iter().any(|file| file.path == "main.service.py") {
        return Err(UpdaterError::Config(
            "the backend entry point is modified or cannot be safely identified".into(),
        ));
    }
    Ok(files)
}

fn validated_blob<'repo>(
    repo: &'repo Repository,
    file: &RemovedFile,
) -> UpdaterResult<git2::Blob<'repo>> {
    let path = Path::new(&file.path);
    if !program_path(path) || (file.mode != 0o100644 && file.mode != 0o100755) {
        return Err(UpdaterError::Config(
            "invalid recorded backend program path".into(),
        ));
    }
    let oid = Oid::from_str(&file.oid).map_err(git)?;
    let tree = repo
        .head()
        .and_then(|head| head.peel_to_tree())
        .map_err(git)?;
    let tracked = tree.get_path(path).map_err(git)?;
    if tracked.id() != oid
        || tracked.kind() != Some(ObjectType::Blob)
        || tracked.filemode() as u32 != file.mode
    {
        return Err(UpdaterError::Config(
            "recorded backend file no longer matches its repository".into(),
        ));
    }
    repo.find_blob(oid).map_err(git)
}

/// Remove unchanged backend program files while preserving configuration, user
/// data, the repository history, the private Python environment and toolkit.
pub fn uninstall(
    root: &Path,
    expected_identity: (u64, u64),
    cancelled: &AtomicBool,
    emit: &mut impl FnMut(Progress),
) -> UpdaterResult<Inspection> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(UpdaterError::Cancelled);
    }
    let root = normalize_root(root)?;
    validate_anchors(&root)?;
    let root_cap = root_dir(&root)?;
    let info = root_cap.dir_metadata()?;
    if (info.dev(), info.ino()) != expected_identity {
        return Err(UpdaterError::Config(
            "runtime directory identity changed; confirmation is no longer valid".into(),
        ));
    }
    read_marker_cap(&root_cap, &root)?;
    let mut lock_options = CapOpenOptions::new();
    lock_options
        .read(true)
        .write(true)
        .create(true)
        .follow(FollowSymlinks::No);
    let lock = root_cap
        .open_with(".baas-cli-install.lock", &lock_options)?
        .into_std();
    lock.try_lock()
        .map_err(|_| UpdaterError::Workflow("this runtime is in use or being updated".into()))?;
    let mut marker = read_marker_cap(&root_cap, &root)?;
    let repo = repository(&root)?;
    let check = root_dir(&root)?.dir_metadata()?;
    if (check.dev(), check.ino()) != expected_identity {
        return Err(UpdaterError::Config(
            "runtime directory identity changed; confirmation is no longer valid".into(),
        ));
    }
    if marker.removed_files.is_none() {
        let files = plan(&root, &repo)?;
        let quarantine = new_quarantine(&root_cap)?;
        marker.complete = false;
        marker.removed_files = Some(files);
        marker.uninstall_quarantine = Some(quarantine);
        write_marker_cap(&root_cap, &marker)?;
    }
    let quarantine = quarantine_name(&marker)?;
    let quarantine_dir = root_cap.open_dir_nofollow(quarantine)?;
    emit(Progress::status(
        "uninstall",
        "Removing managed backend program files",
        "running",
    ));
    for (index, file) in marker.removed_files.as_ref().unwrap().iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(UpdaterError::Cancelled);
        }
        let path = Path::new(&file.path);
        let blob = validated_blob(&repo, file)?;
        let expected = expected_bytes(blob.content(), file.crlf);
        let source = parent_dir(&root_cap, path)?;
        let name = path
            .file_name()
            .ok_or_else(|| UpdaterError::Config("invalid backend program path".into()))?;
        let slot = format!("{index:08}");
        let slot_name = std::ffi::OsStr::new(&slot);
        let reservation = format!("BAASX-RESERVATION:{quarantine}:{slot}").into_bytes();
        let pending = match read_nofollow_with_identity(&quarantine_dir, slot_name) {
            Ok((bytes, _)) if bytes == reservation => true,
            Ok((bytes, slot_identity)) if bytes == expected => {
                // Restore may have linked the slot back to its source before
                // being interrupted. Only remove that link if it is the same
                // inode; a separately created file is user data, even when its
                // bytes happen to match the original program.
                match read_nofollow_with_identity(&source, name) {
                    Ok((source_bytes, source_identity))
                        if source_bytes == expected && source_identity == slot_identity =>
                    {
                        quarantine_dir.remove_file(&slot)?;
                        write_restore_slot(&quarantine_dir, &slot, &reservation, 0o100644)?;
                        true
                    }
                    Ok(_) => {
                        return Err(UpdaterError::Config(
                            "a user file appeared at a backend program path; it was preserved"
                                .into(),
                        ));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(_) => {
                return Err(UpdaterError::Config(format!(
                    "a file changed during uninstall and was preserved at {}",
                    root.join(quarantine).join(&slot).display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Never publish a partially written reservation: a crash while
                // writing leaves only a private, unreferenced staging file.
                write_restore_slot(&quarantine_dir, &slot, &reservation, 0o100644)?;
                true
            }
            Err(error) => return Err(error.into()),
        };
        if pending {
            match read_nofollow(&source, name) {
                Ok(bytes) if bytes == expected => {}
                Ok(_) => {
                    return Err(UpdaterError::Config(
                        "a backend program file changed during uninstall; it was preserved".into(),
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // The reservation was never replaced, so no source was moved.
                    quarantine_dir.remove_file(&slot)?;
                    continue;
                }
                Err(error) => return Err(error.into()),
            }
            // The existing file placeholder prevents a swapped directory from
            // being moved. An editor's file replacement goes to quarantine.
            source.rename(name, &quarantine_dir, &slot)?;
        }
        match read_nofollow(&quarantine_dir, slot_name) {
            Ok(bytes) if bytes == expected => quarantine_dir.remove_file(&slot)?,
            _ => {
                return Err(UpdaterError::Config(format!(
                    "a file changed during uninstall and was preserved at {}",
                    root.join(quarantine).join(&slot).display()
                )));
            }
        }
    }
    emit(Progress::status(
        "uninstall",
        "Backend program files removed; user data preserved",
        "complete",
    ));
    let check = root_dir(&root)?.dir_metadata()?;
    if (check.dev(), check.ino()) != expected_identity {
        return Err(UpdaterError::Config(
            "runtime directory identity changed during uninstall".into(),
        ));
    }
    inspect(&root)
}

/// Restore only previously removed files. Never enter the updater's Git reset
/// path when reinstalling an uninstalled checkout containing user data.
pub(super) fn restore(
    root: &Path,
    marker: &InstallationMarker,
    cancelled: &AtomicBool,
    emit: &mut impl FnMut(Progress),
) -> UpdaterResult<Inspection> {
    let repo = repository(root)?;
    let root_cap = root_dir(root)?;
    let opened_marker = read_marker_cap(&root_cap, root)?;
    if serde_json::to_vec(&opened_marker).ok() != serde_json::to_vec(marker).ok() {
        return Err(UpdaterError::Config(
            "runtime ownership changed during restore".into(),
        ));
    }
    let quarantine = quarantine_name(marker)?;
    let quarantine_dir = root_cap.open_dir_nofollow(quarantine)?;
    let files = marker
        .removed_files
        .as_ref()
        .ok_or_else(|| UpdaterError::Config("missing uninstall record".into()))?;
    for (index, file) in files.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(UpdaterError::Cancelled);
        }
        let path = Path::new(&file.path);
        let blob = validated_blob(&repo, file)?;
        let expected = expected_bytes(blob.content(), file.crlf);
        let source = parent_dir(&root_cap, path)?;
        let name = path
            .file_name()
            .ok_or_else(|| UpdaterError::Config("invalid backend program path".into()))?;
        let slot = format!("{index:08}");
        let reservation = format!("BAASX-RESERVATION:{quarantine}:{slot}").into_bytes();
        match read_nofollow(&quarantine_dir, std::ffi::OsStr::new(&slot)) {
            Ok(bytes) if bytes == expected => {}
            Ok(bytes) if bytes == reservation => {}
            Ok(_) => {
                return Err(UpdaterError::Config(format!(
                    "a changed file remains preserved at {}",
                    root.join(quarantine).join(&slot).display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        match read_nofollow(&source, name) {
            Ok(bytes) if bytes == expected_bytes(blob.content(), file.crlf) => {}
            Ok(_) => {
                return Err(UpdaterError::Config(
                    "a user file conflicts with a backend program path; it was preserved".into(),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    emit(Progress::status(
        "restore",
        "Restoring backend program files",
        "running",
    ));
    for (index, file) in files.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(UpdaterError::Cancelled);
        }
        let path = Path::new(&file.path);
        let blob = validated_blob(&repo, file)?;
        let expected = expected_bytes(blob.content(), file.crlf);
        let source = parent_dir(&root_cap, path)?;
        let name = path
            .file_name()
            .ok_or_else(|| UpdaterError::Config("invalid backend program path".into()))?;
        let slot = format!("{index:08}");
        let slot_name = std::ffi::OsStr::new(&slot);
        let reservation = format!("BAASX-RESERVATION:{quarantine}:{slot}").into_bytes();
        match read_nofollow(&source, name) {
            Ok(bytes) if bytes == expected => {
                // A quarantined duplicate can be removed only after verification.
                match read_nofollow(&quarantine_dir, slot_name) {
                    Ok(bytes) if bytes == expected => quarantine_dir.remove_file(&slot)?,
                    Ok(bytes) if bytes == reservation => quarantine_dir.remove_file(&slot)?,
                    Ok(_) => {
                        return Err(UpdaterError::Config(format!(
                            "a changed file remains preserved at {}",
                            root.join(quarantine).join(&slot).display()
                        )));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                continue;
            }
            Ok(_) => {
                return Err(UpdaterError::Config(
                    "a user file conflicts with a backend program path; it was preserved".into(),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        match read_nofollow(&quarantine_dir, slot_name) {
            Ok(bytes) if bytes == expected => {}
            Ok(bytes) if bytes == reservation => {
                quarantine_dir.remove_file(&slot)?;
                write_restore_slot(&quarantine_dir, &slot, &expected, file.mode)?;
            }
            Ok(_) => {
                return Err(UpdaterError::Config(format!(
                    "a changed file remains preserved at {}",
                    root.join(quarantine).join(&slot).display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                write_restore_slot(&quarantine_dir, &slot, &expected, file.mode)?;
            }
            Err(error) => return Err(error.into()),
        }
        // hard_link is atomic and fails if a user creates the destination.
        quarantine_dir.hard_link(&slot, &source, name)?;
        quarantine_dir.remove_file(&slot)?;
    }
    let state = inspect(root)?;
    let missing: Vec<_> = state
        .missing
        .iter()
        .filter(|item| item.as_str() != "installation-not-complete")
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(UpdaterError::Environment(format!(
            "restored backend is missing required components: {}",
            missing.join(", ")
        )));
    }
    let mut completed = marker.clone();
    completed.complete = true;
    completed.removed_files = None;
    completed.uninstall_quarantine = None;
    write_marker_cap(&root_cap, &completed)?;
    // Only remove the private quarantine if it is empty; never recurse.
    drop(quarantine_dir);
    let _ = root_cap.remove_dir(quarantine);
    emit(Progress::status(
        "restore",
        "Backend program files restored",
        "complete",
    ));
    inspect(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cpp_program, install_with, private_config};
    use baas_updater::{
        UpdateChannel,
        environ::{requirements_lock_path, runtime_python, uv_executable},
    };

    fn uninstall(
        root: &Path,
        cancelled: &AtomicBool,
        emit: &mut impl FnMut(Progress),
    ) -> UpdaterResult<Inspection> {
        let cap = root_dir(root)?;
        let metadata = cap.dir_metadata()?;
        super::uninstall(root, (metadata.dev(), metadata.ino()), cancelled, emit)
    }

    fn initialized(root: &Path) {
        install_with(
            root,
            UpdateChannel::Dev,
            &AtomicBool::new(false),
            &mut |_| {},
            |root, _| {
                let config = private_config(root, UpdateChannel::Dev);
                for path in [
                    root.join("main.service.py"),
                    root.join("service/runner.py"),
                    root.join("service/custom.py"),
                    root.join("config/user.json"),
                    runtime_python(&config),
                    uv_executable(&config),
                    cpp_program(root),
                    requirements_lock_path(&config),
                ] {
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(path, b"original backend fixture\n").unwrap();
                }
                let repo = Repository::init_opts(
                    root,
                    git2::RepositoryInitOptions::new().initial_head("master"),
                )
                .unwrap();
                let mut index = repo.index().unwrap();
                for path in [
                    "main.service.py",
                    "service/runner.py",
                    "service/custom.py",
                    "config/user.json",
                ] {
                    index.add_path(Path::new(path)).unwrap();
                }
                index.write().unwrap();
                let tree_id = index.write_tree().unwrap();
                let tree = repo.find_tree(tree_id).unwrap();
                let signature = git2::Signature::now("fixture", "fixture@example.invalid").unwrap();
                let commit = repo
                    .commit(Some("HEAD"), &signature, &signature, "fixture", &tree, &[])
                    .unwrap();
                repo.reference("refs/remotes/origin/master", commit, true, "fixture")
                    .unwrap();
                repo.remote("origin", MAIN_REPO_SRC_DEV.main).unwrap();
                let mut manager = ConfigManager::load_from(root.join("setup.toml")).unwrap();
                manager.config.general.current_baas_sha = commit.to_string();
                manager.save().unwrap();
                Ok(())
            },
        )
        .unwrap();
    }

    #[test]
    fn uninstall_preserves_user_data_and_safe_reinstall_restores_only_removed_programs() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        initialized(&root);
        fs::write(root.join("service/custom.py"), b"user modified code\n").unwrap();
        fs::write(root.join("service/user-data.db"), b"user data").unwrap();
        let setup = fs::read(root.join("setup.toml")).unwrap();
        let uv = fs::read(uv_executable(&private_config(&root, UpdateChannel::Dev))).unwrap();
        let state = uninstall(&root, &AtomicBool::new(false), &mut |_| {}).unwrap();
        assert!(state.managed && !state.installed);
        assert!(!root.join("main.service.py").exists());
        assert!(!root.join("service/runner.py").exists());
        assert_eq!(
            fs::read(root.join("service/custom.py")).unwrap(),
            b"user modified code\n"
        );
        assert_eq!(
            fs::read(root.join("service/user-data.db")).unwrap(),
            b"user data"
        );
        assert!(root.join(".git").is_dir());
        assert_eq!(
            fs::read(root.join("config/user.json")).unwrap(),
            b"original backend fixture\n"
        );
        assert_eq!(fs::read(root.join("setup.toml")).unwrap(), setup);
        assert_eq!(
            fs::read(uv_executable(&private_config(&root, UpdateChannel::Dev))).unwrap(),
            uv
        );

        // Never overwrite a file that appeared after uninstall, or reset the repository.
        fs::write(root.join("service/runner.py"), b"new user file").unwrap();
        let conflict = install_with(
            &root,
            UpdateChannel::Dev,
            &AtomicBool::new(false),
            &mut |_| {},
            |_, _| panic!("must not run updater"),
        );
        assert!(conflict.unwrap_err().message().contains("conflicts"));
        assert_eq!(
            fs::read(root.join("service/runner.py")).unwrap(),
            b"new user file"
        );
        assert!(!root.join("main.service.py").exists());
        fs::remove_file(root.join("service/runner.py")).unwrap();
        let restored = install_with(
            &root,
            UpdateChannel::Dev,
            &AtomicBool::new(false),
            &mut |_| {},
            |_, _| panic!("must not run updater"),
        )
        .unwrap();
        assert!(restored.installed && restored.managed);
        assert_eq!(
            fs::read(root.join("main.service.py")).unwrap(),
            b"original backend fixture\n"
        );
        assert_eq!(
            fs::read(root.join("service/runner.py")).unwrap(),
            b"original backend fixture\n"
        );
        assert_eq!(
            fs::read(root.join("service/custom.py")).unwrap(),
            b"user modified code\n"
        );
        assert_eq!(fs::read(root.join("setup.toml")).unwrap(), setup);
    }

    #[test]
    fn unmanaged_changed_repository_and_live_lease_are_not_modified() {
        let parent = tempfile::tempdir().unwrap();
        let unmanaged = parent.path().join("unmanaged");
        fs::create_dir(&unmanaged).unwrap();
        fs::write(unmanaged.join("main.service.py"), b"user file").unwrap();
        assert!(uninstall(&unmanaged, &AtomicBool::new(false), &mut |_| {}).is_err());
        assert_eq!(
            fs::read(unmanaged.join("main.service.py")).unwrap(),
            b"user file"
        );

        let root = parent.path().join("runtime");
        initialized(&root);
        let repo = Repository::open(&root).unwrap();
        repo.find_reference("refs/remotes/origin/master")
            .unwrap()
            .delete()
            .unwrap();
        assert!(uninstall(&root, &AtomicBool::new(false), &mut |_| {}).is_err());
        assert!(root.join("main.service.py").exists());
        let commit = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.reference("refs/remotes/origin/master", commit, true, "fixture")
            .unwrap();
        let lease = crate::acquire_lease(&root).unwrap();
        assert!(uninstall(&root, &AtomicBool::new(false), &mut |_| {}).is_err());
        assert!(root.join("main.service.py").exists());
        drop(lease);
    }

    #[test]
    fn modified_entrypoint_and_pre_cancelled_request_preserve_everything() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        initialized(&root);
        let marker = fs::read(root.join(super::super::MARKER_FILE)).unwrap();
        assert!(matches!(
            uninstall(&root, &AtomicBool::new(true), &mut |_| {}),
            Err(UpdaterError::Cancelled)
        ));
        assert_eq!(
            fs::read(root.join(super::super::MARKER_FILE)).unwrap(),
            marker
        );
        fs::write(root.join("main.service.py"), b"custom entrypoint").unwrap();
        assert!(uninstall(&root, &AtomicBool::new(false), &mut |_| {}).is_err());
        assert_eq!(
            fs::read(root.join("main.service.py")).unwrap(),
            b"custom entrypoint"
        );
        assert_eq!(
            fs::read(root.join(super::super::MARKER_FILE)).unwrap(),
            marker
        );
    }

    #[test]
    fn rejects_changed_origin_baseline_and_directory_identity() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        initialized(&root);
        let cap = root_dir(&root).unwrap();
        let info = cap.dir_metadata().unwrap();
        let marker = fs::read(root.join(crate::MARKER_FILE)).unwrap();
        assert!(
            super::uninstall(
                &root,
                (info.dev(), info.ino().wrapping_add(1)),
                &AtomicBool::new(false),
                &mut |_| {}
            )
            .is_err()
        );
        assert_eq!(fs::read(root.join(crate::MARKER_FILE)).unwrap(), marker);
        let repo = Repository::open(&root).unwrap();
        repo.remote_set_url("origin", "https://example.invalid/user/fork.git")
            .unwrap();
        assert!(uninstall(&root, &AtomicBool::new(false), &mut |_| {}).is_err());
        assert_eq!(fs::read(root.join(crate::MARKER_FILE)).unwrap(), marker);
        repo.remote_set_url("origin", MAIN_REPO_SRC_DEV.main)
            .unwrap();
        let mut manager = ConfigManager::load_from(root.join("setup.toml")).unwrap();
        manager.config.general.current_baas_sha = "0000000000000000000000000000000000000000".into();
        manager.save().unwrap();
        assert!(uninstall(&root, &AtomicBool::new(false), &mut |_| {}).is_err());
        assert_eq!(fs::read(root.join(crate::MARKER_FILE)).unwrap(), marker);
        assert!(root.join("main.service.py").exists());
    }

    #[test]
    fn interrupted_quarantine_and_partial_restore_are_recoverable() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        initialized(&root);
        let repo = repository(&root).unwrap();
        let files = plan(&root, &repo).unwrap();
        let cap = root_dir(&root).unwrap();
        let quarantine = new_quarantine(&cap).unwrap();
        let qdir = cap.open_dir_nofollow(&quarantine).unwrap();
        let mut marker = read_marker_cap(&cap, &root).unwrap();
        marker.complete = false;
        marker.removed_files = Some(files.clone());
        marker.uninstall_quarantine = Some(quarantine.clone());
        write_marker_cap(&cap, &marker).unwrap();
        // A crash while preparing a reservation must not publish a partial
        // slot or prevent retry. The private partial staging file is retained.
        qdir.write("stage-interrupted-reservation", b"partial reservation")
            .unwrap();
        let first = &files[0];
        let first_path = Path::new(&first.path);
        let first_parent = parent_dir(&cap, first_path).unwrap();
        first_parent
            .rename(first_path.file_name().unwrap(), &qdir, "00000000")
            .unwrap();
        // Simulate a crash after moving a verified file but before deleting it.
        uninstall(&root, &AtomicBool::new(false), &mut |_| {}).unwrap();
        assert!(!root.join("main.service.py").exists());
        // Simulate a crash while writing a private staging file for restore.
        qdir.write("stage-interrupted", b"partial private file")
            .unwrap();
        let restored = install_with(
            &root,
            UpdateChannel::Dev,
            &AtomicBool::new(false),
            &mut |_| {},
            |_, _| panic!("must not run updater"),
        )
        .unwrap();
        assert!(restored.installed);
        assert_eq!(
            fs::read(root.join(&quarantine).join("stage-interrupted")).unwrap(),
            b"partial private file"
        );
        assert_eq!(
            fs::read(root.join(&quarantine).join("stage-interrupted-reservation")).unwrap(),
            b"partial reservation"
        );
    }

    #[test]
    fn interrupted_restore_hardlink_is_removed_on_uninstall_retry() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        initialized(&root);
        uninstall(&root, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let cap = root_dir(&root).unwrap();
        let marker = read_marker_cap(&cap, &root).unwrap();
        let (index, file) = marker
            .removed_files
            .as_ref()
            .unwrap()
            .iter()
            .enumerate()
            .find(|(_, file)| file.path == "main.service.py")
            .unwrap();
        let qdir = cap
            .open_dir_nofollow(quarantine_name(&marker).unwrap())
            .unwrap();
        let slot = format!("{index:08}");
        let original = b"original backend fixture\n";
        write_restore_slot(&qdir, &slot, original, file.mode).unwrap();
        // Simulate interruption after restore linked the file to its original
        // path but before removing the quarantine link.
        qdir.hard_link(&slot, &cap, "main.service.py").unwrap();
        assert!(root.join("main.service.py").exists());
        uninstall(&root, &AtomicBool::new(false), &mut |_| {}).unwrap();
        assert!(!root.join("main.service.py").exists());
        assert!(
            !root
                .join(quarantine_name(&marker).unwrap())
                .join(slot)
                .exists()
        );
    }

    #[test]
    fn uninstall_retry_preserves_separate_user_file_even_if_bytes_match() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        initialized(&root);
        uninstall(&root, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let cap = root_dir(&root).unwrap();
        let marker = read_marker_cap(&cap, &root).unwrap();
        let (index, file) = marker
            .removed_files
            .as_ref()
            .unwrap()
            .iter()
            .enumerate()
            .find(|(_, file)| file.path == "main.service.py")
            .unwrap();
        let qdir = cap
            .open_dir_nofollow(quarantine_name(&marker).unwrap())
            .unwrap();
        let slot = format!("{index:08}");
        let original = b"original backend fixture\n";
        write_restore_slot(&qdir, &slot, original, file.mode).unwrap();
        // This is a separately created user file, not the interrupted hard link.
        fs::write(root.join("main.service.py"), original).unwrap();
        let result = uninstall(&root, &AtomicBool::new(false), &mut |_| {});
        assert!(result.unwrap_err().message().contains("user file"));
        assert_eq!(fs::read(root.join("main.service.py")).unwrap(), original);
        assert_eq!(
            fs::read(root.join(quarantine_name(&marker).unwrap()).join(slot)).unwrap(),
            original
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_directory_swap_does_not_escape_the_managed_root() {
        use std::os::unix::fs::symlink;
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("runtime");
        initialized(&root);
        let external = parent.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("runner.py"), b"external user file").unwrap();
        let repo = repository(&root).unwrap();
        let files = plan(&root, &repo).unwrap();
        let cap = root_dir(&root).unwrap();
        let quarantine = new_quarantine(&cap).unwrap();
        let mut marker = read_marker_cap(&cap, &root).unwrap();
        marker.complete = false;
        marker.removed_files = Some(files);
        marker.uninstall_quarantine = Some(quarantine);
        write_marker_cap(&cap, &marker).unwrap();
        fs::rename(root.join("service"), root.join("service-original")).unwrap();
        symlink(&external, root.join("service")).unwrap();
        assert!(uninstall(&root, &AtomicBool::new(false), &mut |_| {}).is_err());
        assert_eq!(
            fs::read(external.join("runner.py")).unwrap(),
            b"external user file"
        );
    }

    #[test]
    #[ignore = "read-only preflight of an explicitly supplied local installation"]
    fn local_installation_read_only_preflight() {
        let root =
            std::env::var_os("BAASX_UNINSTALL_TEST_ROOT").expect("set BAASX_UNINSTALL_TEST_ROOT");
        let root = normalize_root(Path::new(&root)).unwrap();
        validate_anchors(&root).unwrap();
        let cap = root_dir(&root).unwrap();
        let marker = read_marker_cap(&cap, &root).unwrap();
        assert!(marker.complete);
        let repo = repository(&root).unwrap();
        let files = plan(&root, &repo).unwrap();
        assert!(files.iter().any(|file| file.path == "main.service.py"));
        eprintln!(
            "Verified {} backend program candidates without modifying files",
            files.len()
        );
    }
}
