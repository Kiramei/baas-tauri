//! Immutable activation storage for externally managed runtime repositories.
//!
//! This module deliberately does not participate in the legacy Python/Cpp
//! updater workflow. A downloader prepares candidates below `staging`; this
//! store validates and moves them into immutable commit-addressed objects, then
//! publishes exactly one atomic pointer for the resources/scripts pair.

use crate::{UpdaterError, UpdaterResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

pub const RUNTIME_REPOSITORY_CURRENT_SCHEMA: &str = "baas.runtime-repositories.current/v1";
pub const RUNTIME_REPOSITORY_SNAPSHOT_SCHEMA: &str = "baas.runtime-repositories.snapshot/v1";
pub const RUNTIME_REPOSITORY_GENERATION_DOMAIN: &str = RUNTIME_REPOSITORY_SNAPSHOT_SCHEMA;
const MAX_ACTIVATION_JSON_BYTES: u64 = 64 * 1024;

/// The two repository identities that form one runtime activation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeRepositoryId {
    Resources,
    Scripts,
}

impl RuntimeRepositoryId {
    pub const ORDERED: [Self; 2] = [Self::Resources, Self::Scripts];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Resources => "resources",
            Self::Scripts => "scripts",
        }
    }
}

/// Metadata returned by a future Rust-git2 downloader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRepositoryFetchMetadata {
    pub commit: String,
    pub manifest_sha256: String,
}

/// Input passed to an injected downloader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRepositoryFetchRequest {
    pub id: RuntimeRepositoryId,
    pub url: String,
    pub reference: String,
    pub manifest: String,
}

/// Download boundary. Production git2 transport will implement this later;
/// tests can provide a network-free mock without weakening activation checks.
pub trait RuntimeRepositoryDownloader: Send + Sync {
    fn download(
        &self,
        request: &RuntimeRepositoryFetchRequest,
        staging_root: &Path,
    ) -> UpdaterResult<RuntimeRepositoryFetchMetadata>;
}

/// One fully downloaded candidate below this store's staging directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRepositoryCandidate {
    pub id: RuntimeRepositoryId,
    pub commit: String,
    pub staging_root: PathBuf,
    pub manifest: String,
    pub manifest_sha256: String,
}

/// Repository entry embedded in the immutable snapshot protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRepositorySnapshotEntry {
    pub id: String,
    pub commit: String,
    pub root: String,
    pub manifest: String,
    pub manifest_sha256: String,
}

/// Immutable pair consumed by the C++ runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRepositorySnapshot {
    pub schema: String,
    pub generation: String,
    pub repositories: [RuntimeRepositorySnapshotEntry; 2],
}

/// Atomically replaced reader entry point.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRepositoryPointer {
    pub schema: String,
    pub generation: String,
    pub snapshot: String,
}

/// A pointer and its validated immutable snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRepositoryActivation {
    pub pointer: RuntimeRepositoryPointer,
    pub snapshot: RuntimeRepositorySnapshot,
}

/// Deterministic fault-injection boundaries around publication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeRepositoryPublishCheckpoint {
    CandidatesValidated,
    ObjectsCommitted,
    SnapshotWritten,
    BeforeCurrentReplace,
    CurrentReplaced,
}

/// Hook used only for diagnostics and deterministic failure tests.
pub trait RuntimeRepositoryStoreHooks: Send + Sync {
    fn checkpoint(&self, checkpoint: RuntimeRepositoryPublishCheckpoint) -> UpdaterResult<()>;
}

#[derive(Debug, Default)]
struct NoopRuntimeRepositoryStoreHooks;

impl RuntimeRepositoryStoreHooks for NoopRuntimeRepositoryStoreHooks {
    fn checkpoint(&self, _checkpoint: RuntimeRepositoryPublishCheckpoint) -> UpdaterResult<()> {
        Ok(())
    }
}

/// Filesystem-backed publisher for one BAAS installation root.
#[derive(Clone)]
pub struct RuntimeRepositoryStore {
    root: PathBuf,
    writer: Arc<Mutex<()>>,
    hooks: Arc<dyn RuntimeRepositoryStoreHooks>,
}

impl std::fmt::Debug for RuntimeRepositoryStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeRepositoryStore")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl RuntimeRepositoryStore {
    /// Opens or creates `<BAAS_ROOT>/.baas-updater/runtime-repositories`.
    pub fn open(baas_root: impl AsRef<Path>) -> UpdaterResult<Self> {
        Self::open_with_hooks(baas_root, Arc::new(NoopRuntimeRepositoryStoreHooks))
    }

    /// Opens a store with deterministic publication hooks.
    pub fn open_with_hooks(
        baas_root: impl AsRef<Path>,
        hooks: Arc<dyn RuntimeRepositoryStoreHooks>,
    ) -> UpdaterResult<Self> {
        let baas_root = baas_root.as_ref();
        fs::create_dir_all(baas_root)?;
        reject_link_or_reparse(baas_root)?;
        let canonical_baas_root = baas_root.canonicalize()?;
        let updater = canonical_baas_root.join(".baas-updater");
        ensure_plain_directory(&updater)?;
        let root = updater.join("runtime-repositories");
        ensure_plain_directory(&root)?;
        for name in ["staging", "objects", "snapshots"] {
            ensure_plain_directory(&root.join(name))?;
        }
        let root = root.canonicalize()?;
        if !root.starts_with(&canonical_baas_root) {
            return Err(config_error("runtime repository root escapes BAAS root"));
        }
        Ok(Self {
            root,
            writer: Arc::new(Mutex::new(())),
            hooks,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Reserves a unique immediate child of `staging`.
    pub fn create_staging_dir(&self, id: RuntimeRepositoryId) -> UpdaterResult<PathBuf> {
        let staging = self.managed_dir("staging")?;
        for _ in 0..16 {
            let path = staging.join(format!("{}-{}", id.as_str(), Uuid::new_v4()));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(UpdaterError::Io(
            "failed to reserve runtime repository staging directory".to_string(),
        ))
    }

    /// Invokes an injected downloader and returns a validated candidate.
    pub fn download_candidate(
        &self,
        downloader: &dyn RuntimeRepositoryDownloader,
        request: &RuntimeRepositoryFetchRequest,
    ) -> UpdaterResult<RuntimeRepositoryCandidate> {
        validate_manifest_name(&request.manifest)?;
        let staging_root = self.create_staging_dir(request.id)?;
        let result = downloader.download(request, &staging_root);
        let metadata = match result {
            Ok(metadata) => metadata,
            Err(error) => {
                let _ = remove_plain_tree(&staging_root);
                return Err(error);
            }
        };
        let candidate = RuntimeRepositoryCandidate {
            id: request.id,
            commit: metadata.commit,
            staging_root,
            manifest: request.manifest.clone(),
            manifest_sha256: metadata.manifest_sha256,
        };
        if let Err(error) = self.validate_candidate(&candidate) {
            let _ = remove_plain_tree(&candidate.staging_root);
            return Err(error);
        }
        Ok(candidate)
    }

    /// Publishes only after both resources and scripts candidates validate.
    pub fn publish(
        &self,
        candidates: &[RuntimeRepositoryCandidate],
    ) -> UpdaterResult<RuntimeRepositoryActivation> {
        let _writer = self.writer.lock().map_err(|_| {
            UpdaterError::Workflow("runtime repository writer lock poisoned".into())
        })?;
        let candidates = self.index_and_validate_candidates(candidates)?;
        self.hooks
            .checkpoint(RuntimeRepositoryPublishCheckpoint::CandidatesValidated)?;

        let resources = self.commit_candidate(candidates[&RuntimeRepositoryId::Resources])?;
        let scripts = self.commit_candidate(candidates[&RuntimeRepositoryId::Scripts])?;
        self.hooks
            .checkpoint(RuntimeRepositoryPublishCheckpoint::ObjectsCommitted)?;

        let generation = compute_runtime_repository_generation(&resources, &scripts);
        let snapshot = RuntimeRepositorySnapshot {
            schema: RUNTIME_REPOSITORY_SNAPSHOT_SCHEMA.to_string(),
            generation: generation.clone(),
            repositories: [resources, scripts],
        };
        validate_snapshot(&snapshot)?;
        let pointer = RuntimeRepositoryPointer {
            schema: RUNTIME_REPOSITORY_CURRENT_SCHEMA.to_string(),
            generation: generation.clone(),
            snapshot: format!("snapshots/{generation}.json"),
        };
        let snapshot_path = self.root.join(&pointer.snapshot);
        write_immutable_json(&snapshot_path, &snapshot)?;
        self.hooks
            .checkpoint(RuntimeRepositoryPublishCheckpoint::SnapshotWritten)?;

        let old_current = self.read_pointer_file(&self.current_path())?;
        if let Some(old_current) = &old_current {
            self.write_pointer_atomically(&self.previous_path(), old_current)?;
        }
        self.hooks
            .checkpoint(RuntimeRepositoryPublishCheckpoint::BeforeCurrentReplace)?;
        self.write_pointer_atomically(&self.current_path(), &pointer)?;
        self.hooks
            .checkpoint(RuntimeRepositoryPublishCheckpoint::CurrentReplaced)?;
        Ok(RuntimeRepositoryActivation { pointer, snapshot })
    }

    /// Reads one complete current generation. Snapshot files are immutable, so
    /// a concurrent pointer replacement cannot mix generations.
    pub fn read_current(&self) -> UpdaterResult<Option<RuntimeRepositoryActivation>> {
        let Some(pointer) = self.read_pointer_file(&self.current_path())? else {
            return Ok(None);
        };
        self.read_activation(pointer).map(Some)
    }

    /// Atomically switches current back to previous, retaining the displaced
    /// pointer as a best-effort redo target.
    pub fn rollback(&self) -> UpdaterResult<RuntimeRepositoryActivation> {
        let _writer = self.writer.lock().map_err(|_| {
            UpdaterError::Workflow("runtime repository writer lock poisoned".into())
        })?;
        let previous = self
            .read_pointer_file(&self.previous_path())?
            .ok_or_else(|| config_error("runtime repository previous.json is unavailable"))?;
        let activation = self.read_activation(previous.clone())?;
        let displaced = self.read_pointer_file(&self.current_path())?;
        self.write_pointer_atomically(&self.current_path(), &previous)?;
        if let Some(displaced) = displaced {
            let _ = self.write_pointer_atomically(&self.previous_path(), &displaced);
        }
        Ok(activation)
    }

    fn current_path(&self) -> PathBuf {
        self.root.join("current.json")
    }

    fn previous_path(&self) -> PathBuf {
        self.root.join("previous.json")
    }

    fn managed_dir(&self, name: &str) -> UpdaterResult<PathBuf> {
        let path = self.root.join(name);
        ensure_plain_directory(&path)?;
        let canonical = path.canonicalize()?;
        if canonical.parent() != Some(self.root.as_path()) {
            return Err(config_error(format!(
                "managed directory escapes store: {name}"
            )));
        }
        Ok(canonical)
    }

    fn index_and_validate_candidates<'a>(
        &self,
        candidates: &'a [RuntimeRepositoryCandidate],
    ) -> UpdaterResult<BTreeMap<RuntimeRepositoryId, &'a RuntimeRepositoryCandidate>> {
        if candidates.len() != RuntimeRepositoryId::ORDERED.len() {
            return Err(config_error(
                "runtime activation requires exactly resources and scripts candidates",
            ));
        }
        let mut indexed = BTreeMap::new();
        for candidate in candidates {
            self.validate_candidate(candidate)?;
            if indexed.insert(candidate.id, candidate).is_some() {
                return Err(config_error(format!(
                    "duplicate runtime repository candidate: {}",
                    candidate.id.as_str()
                )));
            }
        }
        for id in RuntimeRepositoryId::ORDERED {
            if !indexed.contains_key(&id) {
                return Err(config_error(format!(
                    "missing runtime repository candidate: {}",
                    id.as_str()
                )));
            }
        }
        Ok(indexed)
    }

    fn validate_candidate(&self, candidate: &RuntimeRepositoryCandidate) -> UpdaterResult<()> {
        validate_commit(&candidate.commit)?;
        validate_manifest_name(&candidate.manifest)?;
        validate_sha256(&candidate.manifest_sha256, "manifest_sha256")?;
        let staging = self.managed_dir("staging")?;
        let metadata = fs::symlink_metadata(&candidate.staging_root)?;
        if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() {
            return Err(config_error(
                "candidate staging root is not a plain directory",
            ));
        }
        let canonical = candidate.staging_root.canonicalize()?;
        if canonical.parent() != Some(staging.as_path()) {
            return Err(config_error(
                "candidate staging root is not an immediate store child",
            ));
        }
        validate_plain_tree(&canonical, &canonical)?;
        validate_manifest_file(&canonical, &candidate.manifest, &candidate.manifest_sha256)
    }

    fn commit_candidate(
        &self,
        candidate: &RuntimeRepositoryCandidate,
    ) -> UpdaterResult<RuntimeRepositorySnapshotEntry> {
        let objects = self.managed_dir("objects")?;
        let id_dir = objects.join(candidate.id.as_str());
        ensure_plain_directory(&id_dir)?;
        ensure_direct_child_of(&id_dir, &objects)?;
        sync_directory(&objects)?;
        let object = id_dir.join(&candidate.commit);
        if symlink_metadata_if_exists(&object)?.is_some() {
            reject_link_or_reparse(&object)?;
            validate_plain_tree(&object, &object)?;
            validate_manifest_file(&object, &candidate.manifest, &candidate.manifest_sha256)?;
            remove_plain_tree(&candidate.staging_root)?;
        } else {
            let staging = candidate
                .staging_root
                .parent()
                .ok_or_else(|| config_error("candidate staging root has no parent"))?
                .to_path_buf();
            sync_plain_tree(&candidate.staging_root)?;
            fs::rename(&candidate.staging_root, &object).map_err(|error| {
                UpdaterError::Io(format!(
                    "failed to move staging repository into immutable object {}: {error}",
                    object.display()
                ))
            })?;
            sync_directory(&id_dir)?;
            sync_directory(&staging)?;
            validate_plain_tree(&object, &object)?;
        }
        Ok(RuntimeRepositorySnapshotEntry {
            id: candidate.id.as_str().to_string(),
            commit: candidate.commit.clone(),
            root: format!("objects/{}/{}", candidate.id.as_str(), candidate.commit),
            manifest: candidate.manifest.clone(),
            manifest_sha256: candidate.manifest_sha256.clone(),
        })
    }

    fn read_activation(
        &self,
        pointer: RuntimeRepositoryPointer,
    ) -> UpdaterResult<RuntimeRepositoryActivation> {
        validate_pointer(&pointer)?;
        let snapshot_path = self.root.join(&pointer.snapshot);
        ensure_direct_child_of(&snapshot_path, &self.managed_dir("snapshots")?)?;
        let snapshot: RuntimeRepositorySnapshot = read_bounded_json(&snapshot_path)?;
        validate_snapshot(&snapshot)?;
        if snapshot.generation != pointer.generation {
            return Err(config_error("pointer and snapshot generations differ"));
        }
        self.validate_snapshot_object(&snapshot.repositories[0], RuntimeRepositoryId::Resources)?;
        self.validate_snapshot_object(&snapshot.repositories[1], RuntimeRepositoryId::Scripts)?;
        Ok(RuntimeRepositoryActivation { pointer, snapshot })
    }

    fn validate_snapshot_object(
        &self,
        entry: &RuntimeRepositorySnapshotEntry,
        id: RuntimeRepositoryId,
    ) -> UpdaterResult<()> {
        if entry.id != id.as_str() {
            return Err(config_error("snapshot repository id mismatch"));
        }
        let expected_root = format!("objects/{}/{}", id.as_str(), entry.commit);
        if entry.root != expected_root {
            return Err(config_error("snapshot repository root mismatch"));
        }
        let object = self.root.join(&entry.root);
        let objects = self.managed_dir("objects")?;
        let id_dir = objects.join(id.as_str()).canonicalize()?;
        ensure_direct_child_of(&object, &id_dir)?;
        validate_plain_tree(&object, &object)?;
        validate_manifest_file(&object, &entry.manifest, &entry.manifest_sha256)
    }

    fn read_pointer_file(&self, path: &Path) -> UpdaterResult<Option<RuntimeRepositoryPointer>> {
        #[cfg(target_os = "windows")]
        {
            for attempt in 0..32 {
                match self.read_pointer_file_once(path) {
                    Err(UpdaterError::Io(_)) if attempt < 31 => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    result => return result,
                }
            }
            unreachable!("bounded pointer read loop always returns")
        }
        #[cfg(not(target_os = "windows"))]
        self.read_pointer_file_once(path)
    }

    fn read_pointer_file_once(
        &self,
        path: &Path,
    ) -> UpdaterResult<Option<RuntimeRepositoryPointer>> {
        if symlink_metadata_if_exists(path)?.is_none() {
            return Ok(None);
        }
        ensure_direct_child_of(path, &self.root)?;
        let pointer: RuntimeRepositoryPointer = read_bounded_json(path)?;
        validate_pointer(&pointer)?;
        Ok(Some(pointer))
    }

    fn write_pointer_atomically(
        &self,
        target: &Path,
        pointer: &RuntimeRepositoryPointer,
    ) -> UpdaterResult<()> {
        validate_pointer(pointer)?;
        ensure_direct_child_of(target, &self.root)?;
        if let Some(metadata) = symlink_metadata_if_exists(target)?
            && !metadata.is_file()
        {
            return Err(config_error("atomic pointer target is not a regular file"));
        }
        let temporary = self.root.join(format!(
            ".{}.{}.tmp",
            target.file_name().unwrap().to_string_lossy(),
            Uuid::new_v4()
        ));
        let result = (|| {
            write_new_json(&temporary, pointer)?;
            atomic_replace_file(&temporary, target)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

/// Computes the cross-language generation using 8-byte big-endian length
/// prefixes for the domain and every field in resources/scripts order.
pub fn compute_runtime_repository_generation(
    resources: &RuntimeRepositorySnapshotEntry,
    scripts: &RuntimeRepositorySnapshotEntry,
) -> String {
    let mut digest = Sha256::new();
    hash_length_prefixed(&mut digest, RUNTIME_REPOSITORY_GENERATION_DOMAIN);
    for entry in [resources, scripts] {
        for value in [
            &entry.id,
            &entry.commit,
            &entry.root,
            &entry.manifest,
            &entry.manifest_sha256,
        ] {
            hash_length_prefixed(&mut digest, value);
        }
    }
    lowercase_hex(&digest.finalize())
}

fn hash_length_prefixed(digest: &mut Sha256, value: &str) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value.as_bytes());
}

fn validate_pointer(pointer: &RuntimeRepositoryPointer) -> UpdaterResult<()> {
    if pointer.schema != RUNTIME_REPOSITORY_CURRENT_SCHEMA {
        return Err(config_error(
            "unsupported runtime repository pointer schema",
        ));
    }
    validate_sha256(&pointer.generation, "generation")?;
    if pointer.snapshot != format!("snapshots/{}.json", pointer.generation) {
        return Err(config_error(
            "runtime repository snapshot path is not canonical",
        ));
    }
    Ok(())
}

fn validate_snapshot(snapshot: &RuntimeRepositorySnapshot) -> UpdaterResult<()> {
    if snapshot.schema != RUNTIME_REPOSITORY_SNAPSHOT_SCHEMA {
        return Err(config_error(
            "unsupported runtime repository snapshot schema",
        ));
    }
    validate_snapshot_entry(&snapshot.repositories[0], RuntimeRepositoryId::Resources)?;
    validate_snapshot_entry(&snapshot.repositories[1], RuntimeRepositoryId::Scripts)?;
    let expected =
        compute_runtime_repository_generation(&snapshot.repositories[0], &snapshot.repositories[1]);
    if snapshot.generation != expected {
        return Err(config_error(
            "runtime repository snapshot generation mismatch",
        ));
    }
    Ok(())
}

fn validate_snapshot_entry(
    entry: &RuntimeRepositorySnapshotEntry,
    id: RuntimeRepositoryId,
) -> UpdaterResult<()> {
    validate_commit(&entry.commit)?;
    validate_manifest_name(&entry.manifest)?;
    validate_sha256(&entry.manifest_sha256, "manifest_sha256")?;
    if entry.id != id.as_str() || entry.root != format!("objects/{}/{}", id.as_str(), entry.commit)
    {
        return Err(config_error(
            "non-canonical runtime repository snapshot entry",
        ));
    }
    Ok(())
}

fn validate_commit(value: &str) -> UpdaterResult<()> {
    if !matches!(value.len(), 40 | 64) || !is_lower_hex(value) {
        return Err(config_error(
            "commit must be 40 or 64 lowercase hexadecimal characters",
        ));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> UpdaterResult<()> {
    if value.len() != 64 || !is_lower_hex(value) {
        return Err(config_error(format!(
            "{label} must be 64 lowercase hexadecimal characters"
        )));
    }
    Ok(())
}

fn is_lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_manifest_name(value: &str) -> UpdaterResult<()> {
    if value.is_empty()
        || matches!(value, "." | "..")
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-')
        })
        || Path::new(value).components().count() != 1
    {
        return Err(config_error(
            "manifest must be one lowercase [a-z0-9_.-] path segment",
        ));
    }
    Ok(())
}

fn validate_manifest_file(root: &Path, manifest: &str, expected_sha256: &str) -> UpdaterResult<()> {
    validate_manifest_name(manifest)?;
    let path = root.join(manifest);
    ensure_direct_child_of(&path, root)?;
    let metadata = fs::symlink_metadata(&path)?;
    if metadata_is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(config_error("manifest is not a plain regular file"));
    }
    let actual = sha256_file(&path)?;
    if actual != expected_sha256 {
        return Err(config_error(
            "manifest_sha256 does not match manifest bytes",
        ));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> UpdaterResult<String> {
    let mut input = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(lowercase_hex(&digest.finalize()))
}

fn lowercase_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn ensure_plain_directory(path: &Path) -> UpdaterResult<()> {
    let mut created = false;
    if symlink_metadata_if_exists(path)?.is_none() {
        match fs::create_dir(path) {
            Ok(()) => created = true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(config_error(format!(
            "managed path is not a plain directory: {}",
            path.display()
        )));
    }
    if created && let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn metadata_is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn symlink_metadata_if_exists(path: &Path) -> UpdaterResult<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "windows")]
fn metadata_is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn reject_link_or_reparse(path: &Path) -> UpdaterResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata_is_link_or_reparse(&metadata) {
        return Err(config_error(format!(
            "managed path is a symlink or reparse point: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_plain_tree(path: &Path, root: &Path) -> UpdaterResult<()> {
    let canonical_root = root.canonicalize()?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata_is_link_or_reparse(&metadata) {
        return Err(config_error(format!(
            "runtime repository contains a symlink or reparse point: {}",
            path.display()
        )));
    }
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(&canonical_root) {
        return Err(config_error("runtime repository path escapes its root"));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            validate_plain_tree(&entry?.path(), &canonical_root)?;
        }
    } else if !metadata.is_file() {
        return Err(config_error("runtime repository contains a special file"));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_plain_tree(path: &Path) -> UpdaterResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata_is_link_or_reparse(&metadata) {
        return Err(config_error(
            "cannot synchronize a symlink or reparse point",
        ));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            sync_plain_tree(&entry?.path())?;
        }
        sync_directory(path)
    } else if metadata.is_file() {
        File::open(path)?.sync_all()?;
        Ok(())
    } else {
        Err(config_error("cannot synchronize a special file"))
    }
}

#[cfg(not(unix))]
fn sync_plain_tree(_path: &Path) -> UpdaterResult<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> UpdaterResult<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> UpdaterResult<()> {
    Ok(())
}

fn ensure_direct_child_of(path: &Path, parent: &Path) -> UpdaterResult<()> {
    if path.parent() != Some(parent) {
        return Err(config_error(format!(
            "managed path is not an immediate child of {}",
            parent.display()
        )));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(config_error("managed path contains parent traversal"));
    }
    if symlink_metadata_if_exists(path)?.is_some() {
        reject_link_or_reparse(path)?;
    }
    Ok(())
}

fn remove_plain_tree(path: &Path) -> UpdaterResult<()> {
    if symlink_metadata_if_exists(path)?.is_none() {
        return Ok(());
    }
    validate_plain_tree(path, path)?;
    fs::remove_dir_all(path)?;
    Ok(())
}

fn read_bounded_json<T: for<'de> Deserialize<'de>>(path: &Path) -> UpdaterResult<T> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata_is_link_or_reparse(&metadata)
        || !metadata.is_file()
        || metadata.len() > MAX_ACTIVATION_JSON_BYTES
    {
        return Err(config_error("activation JSON is not a bounded plain file"));
    }
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|error| config_error(error.to_string()))
}

fn write_immutable_json(path: &Path, value: &RuntimeRepositorySnapshot) -> UpdaterResult<()> {
    if symlink_metadata_if_exists(path)?.is_some() {
        reject_link_or_reparse(path)?;
        let existing: RuntimeRepositorySnapshot = read_bounded_json(path)?;
        if existing != *value {
            return Err(config_error(
                "immutable snapshot already exists with different content",
            ));
        }
        return Ok(());
    }
    write_new_json(path, value)?;
    sync_directory(
        path.parent()
            .ok_or_else(|| config_error("snapshot path has no parent"))?,
    )
}

fn write_new_json<T: Serialize>(path: &Path, value: &T) -> UpdaterResult<()> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| config_error(error.to_string()))?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(path)?;
    output.write_all(&bytes)?;
    output.write_all(b"\n")?;
    output.sync_all()?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace_file(source: &Path, target: &Path) -> UpdaterResult<()> {
    fs::rename(source, target)?;
    sync_directory(
        target
            .parent()
            .ok_or_else(|| config_error("atomic pointer target has no parent"))?,
    )
}

#[cfg(target_os = "windows")]
fn atomic_replace_file(source: &Path, target: &Path) -> UpdaterResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::Storage::FileSystem::{
            MOVE_FILE_FLAGS, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        core::PCWSTR,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let flags = MOVE_FILE_FLAGS(MOVEFILE_REPLACE_EXISTING.0 | MOVEFILE_WRITE_THROUGH.0);
    for attempt in 0..2_000 {
        match unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(target.as_ptr()), flags) } {
            Ok(()) => return Ok(()),
            Err(error)
                if attempt < 1_999
                    && matches!(error.code().0 as u32, 0x8007_0005 | 0x8007_0020) =>
            {
                // Windows readers may briefly hold a handle without delete sharing.
                // Retrying preserves the single atomic replacement boundary.
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(error) => return Err(UpdaterError::Io(error.to_string())),
        }
    }
    unreachable!("bounded atomic replacement loop always returns")
}

fn config_error(message: impl Into<String>) -> UpdaterError {
    UpdaterError::Config(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
        thread,
    };
    use tempfile::TempDir;

    fn manifest_sha(bytes: &[u8]) -> String {
        lowercase_hex(&Sha256::digest(bytes))
    }

    fn candidate(
        store: &RuntimeRepositoryStore,
        id: RuntimeRepositoryId,
        digit: char,
    ) -> RuntimeRepositoryCandidate {
        let staging_root = store.create_staging_dir(id).unwrap();
        let manifest = format!("{}.json", id.as_str());
        let bytes = format!("{{\"id\":\"{}\",\"version\":\"{}\"}}", id.as_str(), digit);
        fs::write(staging_root.join(&manifest), bytes.as_bytes()).unwrap();
        fs::write(staging_root.join("payload.txt"), format!("payload-{digit}")).unwrap();
        RuntimeRepositoryCandidate {
            id,
            commit: digit.to_string().repeat(40),
            staging_root,
            manifest,
            manifest_sha256: manifest_sha(bytes.as_bytes()),
        }
    }

    fn pair(store: &RuntimeRepositoryStore, digit: char) -> Vec<RuntimeRepositoryCandidate> {
        vec![
            candidate(store, RuntimeRepositoryId::Resources, digit),
            candidate(store, RuntimeRepositoryId::Scripts, digit),
        ]
    }

    fn candidate_entry(candidate: &RuntimeRepositoryCandidate) -> RuntimeRepositorySnapshotEntry {
        RuntimeRepositorySnapshotEntry {
            id: candidate.id.as_str().to_string(),
            commit: candidate.commit.clone(),
            root: format!("objects/{}/{}", candidate.id.as_str(), candidate.commit),
            manifest: candidate.manifest.clone(),
            manifest_sha256: candidate.manifest_sha256.clone(),
        }
    }

    #[test]
    fn contract_fixture_matches_generation_and_json_shape() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/runtime-repository-activation-v1.json"
        ))
        .unwrap();
        let snapshot: RuntimeRepositorySnapshot =
            serde_json::from_value(fixture["snapshot"].clone()).unwrap();
        let pointer: RuntimeRepositoryPointer =
            serde_json::from_value(fixture["current"].clone()).unwrap();
        validate_snapshot(&snapshot).unwrap();
        validate_pointer(&pointer).unwrap();
        assert_eq!(snapshot.generation, pointer.generation);
        assert_eq!(
            serde_json::to_value(&snapshot).unwrap(),
            fixture["snapshot"]
        );
        assert_eq!(serde_json::to_value(&pointer).unwrap(), fixture["current"]);
    }

    #[test]
    fn publication_requires_exactly_resources_and_scripts() {
        let temp = TempDir::new().unwrap();
        let store = RuntimeRepositoryStore::open(temp.path()).unwrap();
        let only_resources = vec![candidate(&store, RuntimeRepositoryId::Resources, '1')];
        assert!(store.publish(&only_resources).is_err());
        assert!(store.read_current().unwrap().is_none());

        let duplicate = vec![
            candidate(&store, RuntimeRepositoryId::Resources, '2'),
            candidate(&store, RuntimeRepositoryId::Resources, '3'),
        ];
        assert!(store.publish(&duplicate).is_err());
        assert!(store.read_current().unwrap().is_none());
    }

    #[test]
    fn publication_moves_staging_to_immutable_objects_and_publishes_once() {
        let temp = TempDir::new().unwrap();
        let store = RuntimeRepositoryStore::open(temp.path()).unwrap();
        let candidates = pair(&store, '1');
        let staging = candidates
            .iter()
            .map(|candidate| candidate.staging_root.clone())
            .collect::<Vec<_>>();
        let activation = store.publish(&candidates).unwrap();
        assert!(staging.iter().all(|path| !path.exists()));
        assert!(
            store
                .root()
                .join(&activation.snapshot.repositories[0].root)
                .is_dir()
        );
        assert!(
            store
                .root()
                .join(&activation.snapshot.repositories[1].root)
                .is_dir()
        );
        assert_eq!(store.read_current().unwrap().unwrap(), activation);
        assert!(!store.previous_path().exists());
    }

    struct FailingHooks {
        enabled: AtomicBool,
        hits: AtomicUsize,
        fail_at: RuntimeRepositoryPublishCheckpoint,
    }

    impl FailingHooks {
        fn new(fail_at: RuntimeRepositoryPublishCheckpoint) -> Self {
            Self {
                enabled: AtomicBool::new(false),
                hits: AtomicUsize::new(0),
                fail_at,
            }
        }
    }

    impl RuntimeRepositoryStoreHooks for FailingHooks {
        fn checkpoint(&self, checkpoint: RuntimeRepositoryPublishCheckpoint) -> UpdaterResult<()> {
            self.hits.fetch_add(1, Ordering::SeqCst);
            if self.enabled.load(Ordering::SeqCst) && checkpoint == self.fail_at {
                return Err(UpdaterError::Workflow(format!(
                    "injected publication failure at {checkpoint:?}"
                )));
            }
            Ok(())
        }
    }

    #[test]
    fn faults_at_every_pre_current_boundary_preserve_old_generation() {
        for checkpoint in [
            RuntimeRepositoryPublishCheckpoint::CandidatesValidated,
            RuntimeRepositoryPublishCheckpoint::ObjectsCommitted,
            RuntimeRepositoryPublishCheckpoint::SnapshotWritten,
            RuntimeRepositoryPublishCheckpoint::BeforeCurrentReplace,
        ] {
            let temp = TempDir::new().unwrap();
            let hooks = Arc::new(FailingHooks::new(checkpoint));
            let store =
                RuntimeRepositoryStore::open_with_hooks(temp.path(), hooks.clone()).unwrap();
            let first = store.publish(&pair(&store, '1')).unwrap();
            hooks.enabled.store(true, Ordering::SeqCst);
            assert!(store.publish(&pair(&store, '2')).is_err());
            assert_eq!(
                store.read_current().unwrap().unwrap().pointer.generation,
                first.pointer.generation,
                "checkpoint {checkpoint:?} changed current"
            );
            assert!(hooks.hits.load(Ordering::SeqCst) >= 6);
        }
    }

    #[test]
    fn rollback_atomically_switches_to_previous_and_retains_redo_pointer() {
        let temp = TempDir::new().unwrap();
        let store = RuntimeRepositoryStore::open(temp.path()).unwrap();
        let first = store.publish(&pair(&store, '1')).unwrap();
        let second = store.publish(&pair(&store, '2')).unwrap();
        assert_eq!(store.read_current().unwrap().unwrap(), second);
        assert_eq!(store.rollback().unwrap(), first);
        assert_eq!(store.read_current().unwrap().unwrap(), first);
        let previous = store
            .read_pointer_file(&store.previous_path())
            .unwrap()
            .unwrap();
        assert_eq!(previous.generation, second.pointer.generation);
    }

    #[test]
    fn concurrent_readers_observe_only_complete_generations() {
        let temp = TempDir::new().unwrap();
        let store = RuntimeRepositoryStore::open(temp.path()).unwrap();
        let first = store.publish(&pair(&store, '1')).unwrap();
        let next_candidates = pair(&store, '2');
        let expected_new_generation = compute_runtime_repository_generation(
            &candidate_entry(&next_candidates[0]),
            &candidate_entry(&next_candidates[1]),
        );
        let running = Arc::new(AtomicBool::new(true));
        let failures = Arc::new(Mutex::new(Vec::new()));
        let mut readers = Vec::new();
        for _ in 0..8 {
            let store = store.clone();
            let running = running.clone();
            let failures = failures.clone();
            let old_generation = first.pointer.generation.clone();
            let new_generation = expected_new_generation.clone();
            readers.push(thread::spawn(move || {
                while running.load(Ordering::Relaxed) {
                    match store.read_current() {
                        Ok(Some(activation))
                            if activation.pointer.generation == old_generation
                                || activation.pointer.generation == new_generation =>
                        {
                            assert_eq!(
                                activation.pointer.generation,
                                activation.snapshot.generation
                            );
                        }
                        Ok(other) => failures
                            .lock()
                            .unwrap()
                            .push(format!("unexpected: {other:?}")),
                        Err(error) => failures.lock().unwrap().push(error.to_string()),
                    }
                }
            }));
        }
        let second = store.publish(&next_candidates).unwrap();
        assert_eq!(second.pointer.generation, expected_new_generation);
        running.store(false, Ordering::Relaxed);
        for reader in readers {
            reader.join().unwrap();
        }
        assert!(failures.lock().unwrap().is_empty());
        assert_eq!(store.read_current().unwrap().unwrap(), second);
    }

    #[test]
    fn candidate_rejects_path_escape_and_manifest_mismatch() {
        let temp = TempDir::new().unwrap();
        let store = RuntimeRepositoryStore::open(temp.path().join("root")).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("resources.json"), b"{}").unwrap();
        let escaped = RuntimeRepositoryCandidate {
            id: RuntimeRepositoryId::Resources,
            commit: "1".repeat(40),
            staging_root: outside,
            manifest: "resources.json".into(),
            manifest_sha256: manifest_sha(b"{}"),
        };
        assert!(store.validate_candidate(&escaped).is_err());

        let mut mismatched = candidate(&store, RuntimeRepositoryId::Scripts, '2');
        mismatched.manifest_sha256 = "0".repeat(64);
        assert!(store.validate_candidate(&mismatched).is_err());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn candidate_rejects_symlink_or_reparse_content() {
        let temp = TempDir::new().unwrap();
        let store = RuntimeRepositoryStore::open(temp.path()).unwrap();
        let candidate = candidate(&store, RuntimeRepositoryId::Resources, '1');
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"outside").unwrap();
        let link = candidate.staging_root.join("escape.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
            return;
        }
        assert!(store.validate_candidate(&candidate).is_err());
    }

    struct MockDownloader;

    impl RuntimeRepositoryDownloader for MockDownloader {
        fn download(
            &self,
            request: &RuntimeRepositoryFetchRequest,
            staging_root: &Path,
        ) -> UpdaterResult<RuntimeRepositoryFetchMetadata> {
            let bytes = format!("{{\"source\":\"{}\"}}", request.url);
            fs::write(staging_root.join(&request.manifest), bytes.as_bytes())?;
            Ok(RuntimeRepositoryFetchMetadata {
                commit: "a".repeat(40),
                manifest_sha256: manifest_sha(bytes.as_bytes()),
            })
        }
    }

    #[test]
    fn downloader_boundary_produces_a_validated_staging_candidate() {
        let temp = TempDir::new().unwrap();
        let store = RuntimeRepositoryStore::open(temp.path()).unwrap();
        let request = RuntimeRepositoryFetchRequest {
            id: RuntimeRepositoryId::Scripts,
            url: "https://example.invalid/scripts.git".into(),
            reference: "main".into(),
            manifest: "scripts.json".into(),
        };
        let candidate = store.download_candidate(&MockDownloader, &request).unwrap();
        assert_eq!(candidate.id, RuntimeRepositoryId::Scripts);
        assert!(candidate.staging_root.is_dir());
        store.validate_candidate(&candidate).unwrap();
    }

    #[test]
    fn protocol_rejects_noncanonical_fields() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/runtime-repository-activation-v1.json"
        ))
        .unwrap();
        let mut pointer = fixture["current"].clone();
        pointer["snapshot"] = json!("../snapshot.json");
        let pointer: RuntimeRepositoryPointer = serde_json::from_value(pointer).unwrap();
        assert!(validate_pointer(&pointer).is_err());

        let mut snapshot = fixture["snapshot"].clone();
        snapshot["repositories"][0]["manifest"] = json!("../resources.json");
        let snapshot: RuntimeRepositorySnapshot = serde_json::from_value(snapshot).unwrap();
        assert!(validate_snapshot(&snapshot).is_err());
    }

    #[test]
    fn protocol_rejects_unknown_missing_extra_and_reordered_repositories() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/runtime-repository-activation-v1.json"
        ))
        .unwrap();

        let mut unknown = fixture["snapshot"].clone();
        unknown["unknown"] = json!(true);
        assert!(serde_json::from_value::<RuntimeRepositorySnapshot>(unknown).is_err());

        let mut missing = fixture["snapshot"].clone();
        missing["repositories"].as_array_mut().unwrap().pop();
        assert!(serde_json::from_value::<RuntimeRepositorySnapshot>(missing).is_err());

        let mut extra = fixture["snapshot"].clone();
        let third = extra["repositories"][0].clone();
        extra["repositories"].as_array_mut().unwrap().push(third);
        assert!(serde_json::from_value::<RuntimeRepositorySnapshot>(extra).is_err());

        let mut reordered = fixture["snapshot"].clone();
        reordered["repositories"].as_array_mut().unwrap().swap(0, 1);
        let reordered: RuntimeRepositorySnapshot = serde_json::from_value(reordered).unwrap();
        assert!(validate_snapshot(&reordered).is_err());
    }

    #[test]
    fn invalid_existing_current_fails_closed_before_publication() {
        let temp = TempDir::new().unwrap();
        let store = RuntimeRepositoryStore::open(temp.path()).unwrap();
        store.publish(&pair(&store, '1')).unwrap();
        fs::write(store.current_path(), b"{").unwrap();

        assert!(store.publish(&pair(&store, '2')).is_err());
    }

    #[test]
    fn previous_write_failure_preserves_current_generation() {
        let temp = TempDir::new().unwrap();
        let store = RuntimeRepositoryStore::open(temp.path()).unwrap();
        let first = store.publish(&pair(&store, '1')).unwrap();
        fs::create_dir(store.previous_path()).unwrap();

        assert!(store.publish(&pair(&store, '2')).is_err());
        assert_eq!(store.read_current().unwrap().unwrap(), first);
    }
}
