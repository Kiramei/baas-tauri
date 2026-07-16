//! Restricted git2 transport and orchestration for immutable runtime repositories.
//!
//! This provider is intentionally separate from the legacy updater workflow.

use crate::{
    UpdaterError, UpdaterResult,
    runtime_repository_store::{
        RuntimeRepositoryActivation, RuntimeRepositoryDownloader, RuntimeRepositoryFetchMetadata,
        RuntimeRepositoryFetchRequest, RuntimeRepositoryId, RuntimeRepositoryStopToken,
        RuntimeRepositoryStore,
    },
};
use git2::{AutotagOption, FetchOptions, ObjectType, RemoteCallbacks, Repository};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
use url::Url;

const FETCHED_REFERENCE: &str = "refs/baas/runtime";

/// Bounds applied before and during tree materialization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeRepositoryLimits {
    pub max_depth: usize,
    pub max_entries: usize,
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_manifest_bytes: u64,
}

impl Default for RuntimeRepositoryLimits {
    fn default() -> Self {
        Self {
            max_depth: 32,
            max_entries: 100_000,
            max_files: 80_000,
            max_file_bytes: 256 * 1024 * 1024,
            max_total_bytes: 2 * 1024 * 1024 * 1024,
            max_manifest_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransportPolicy {
    HttpsOnly,
    #[cfg(test)]
    LocalTestOnly,
}

/// Production downloader using libgit2 without credential or certificate callbacks.
#[derive(Debug, Clone)]
pub struct RuntimeRepositoryGit2Downloader {
    limits: RuntimeRepositoryLimits,
    policy: TransportPolicy,
    #[cfg(test)]
    cancel_before_materialization: bool,
}

impl RuntimeRepositoryGit2Downloader {
    pub fn new(limits: RuntimeRepositoryLimits) -> UpdaterResult<Self> {
        validate_limits(limits)?;
        Ok(Self {
            limits,
            policy: TransportPolicy::HttpsOnly,
            #[cfg(test)]
            cancel_before_materialization: false,
        })
    }

    #[cfg(test)]
    fn for_local_tests(limits: RuntimeRepositoryLimits) -> Self {
        validate_limits(limits).expect("test limits must be valid");
        Self {
            limits,
            policy: TransportPolicy::LocalTestOnly,
            cancel_before_materialization: false,
        }
    }

    #[cfg(test)]
    fn cancelling_before_materialization(mut self) -> Self {
        self.cancel_before_materialization = true;
        self
    }

    fn validate_request(&self, request: &RuntimeRepositoryFetchRequest) -> UpdaterResult<()> {
        validate_exact_commit(&request.exact_commit)?;
        validate_advertised_reference(&request.advertised_reference)?;
        validate_manifest_request(&request.manifest)?;
        match self.policy {
            TransportPolicy::HttpsOnly => validate_https_url(&request.url),
            #[cfg(test)]
            TransportPolicy::LocalTestOnly => Ok(()),
        }
    }

    fn fetch_and_materialize(
        &self,
        request: &RuntimeRepositoryFetchRequest,
        staging_root: &Path,
        stop: &RuntimeRepositoryStopToken,
    ) -> UpdaterResult<RuntimeRepositoryFetchMetadata> {
        self.validate_request(request)?;
        check_cancelled(stop)?;

        let transport = staging_root.join(".t");
        fs::create_dir(&transport).map_err(|_| io_error("failed to create transport workspace"))?;
        let repository = Repository::init_bare(&transport)
            .map_err(|_| git_error("failed to initialize transport repository"))?;

        {
            let mut callbacks = RemoteCallbacks::new();
            callbacks.transfer_progress(|_| !stop.is_cancelled());
            let mut options = FetchOptions::new();
            options.remote_callbacks(callbacks);
            if self.policy == TransportPolicy::HttpsOnly {
                options.depth(1);
            }
            options.download_tags(AutotagOption::None);
            let refspec = format!("+{}:{}", request.advertised_reference, FETCHED_REFERENCE);
            let mut remote = repository
                .remote_anonymous(&request.url)
                .map_err(|_| git_error("failed to create restricted remote"))?;
            if remote.fetch(&[&refspec], Some(&mut options), None).is_err() {
                return if stop.is_cancelled() {
                    Err(UpdaterError::Cancelled)
                } else {
                    Err(git_error("failed to fetch advertised reference"))
                };
            }
        }
        check_cancelled(stop)?;

        let reference = repository
            .find_reference(FETCHED_REFERENCE)
            .map_err(|_| git_error("advertised reference was not fetched"))?;
        let commit = reference
            .peel_to_commit()
            .map_err(|_| git_error("advertised reference does not peel to a commit"))?;
        let actual_commit = commit.id().to_string();
        if actual_commit.as_bytes() != request.exact_commit.as_bytes() {
            return Err(git_error("fetched commit does not match exact commit"));
        }

        #[cfg(test)]
        if self.cancel_before_materialization {
            stop.cancel();
        }
        check_cancelled(stop)?;

        let tree = commit
            .tree()
            .map_err(|_| git_error("failed to read exact commit tree"))?;
        let mut state = MaterializationState::new(self.limits, &request.manifest);
        materialize_tree(
            &repository,
            &tree,
            staging_root,
            Path::new(""),
            0,
            stop,
            &mut state,
        )?;
        let manifest_sha256 = state
            .manifest_sha256
            .ok_or_else(|| git_error("manifest is missing from exact commit"))?;
        drop(tree);
        drop(commit);
        drop(reference);
        drop(repository);
        remove_transport(&transport)?;

        Ok(RuntimeRepositoryFetchMetadata {
            commit: actual_commit,
            manifest_sha256,
        })
    }
}

impl RuntimeRepositoryDownloader for RuntimeRepositoryGit2Downloader {
    fn download(
        &self,
        request: &RuntimeRepositoryFetchRequest,
        staging_root: &Path,
        stop: &RuntimeRepositoryStopToken,
    ) -> UpdaterResult<RuntimeRepositoryFetchMetadata> {
        self.fetch_and_materialize(request, staging_root, stop)
    }
}

/// Coordinates resources then scripts and publishes only a complete pair.
pub struct RuntimeRepositoryUpdater<D> {
    store: RuntimeRepositoryStore,
    downloader: D,
}

impl<D> RuntimeRepositoryUpdater<D>
where
    D: RuntimeRepositoryDownloader,
{
    pub fn new(store: RuntimeRepositoryStore, downloader: D) -> Self {
        Self { store, downloader }
    }

    pub fn update_from_requests(
        &self,
        resources: &RuntimeRepositoryFetchRequest,
        scripts: &RuntimeRepositoryFetchRequest,
        expected_current: Option<&str>,
        stop: &RuntimeRepositoryStopToken,
    ) -> UpdaterResult<RuntimeRepositoryActivation> {
        if resources.id != RuntimeRepositoryId::Resources
            || scripts.id != RuntimeRepositoryId::Scripts
        {
            return Err(config_error(
                "runtime repository requests must be ordered resources then scripts",
            ));
        }

        let resources_candidate =
            self.store
                .download_candidate_with_stop(&self.downloader, resources, stop)?;
        let scripts_candidate =
            match self
                .store
                .download_candidate_with_stop(&self.downloader, scripts, stop)
            {
                Ok(candidate) => candidate,
                Err(error) => {
                    let _ = self.store.discard_candidate(&resources_candidate);
                    return Err(error);
                }
            };
        let candidates = [resources_candidate, scripts_candidate];
        if let Err(error) = check_cancelled(stop) {
            for candidate in &candidates {
                let _ = self.store.discard_candidate(candidate);
            }
            return Err(error);
        }
        // Publication is the non-cancellable commit gate: after this call
        // begins, the store either preserves or atomically replaces current.
        match self.store.publish_if_current(&candidates, expected_current) {
            Ok(activation) => Ok(activation),
            Err(error) => {
                for candidate in &candidates {
                    let _ = self.store.discard_candidate(candidate);
                }
                Err(error)
            }
        }
    }
}

struct MaterializationState<'a> {
    limits: RuntimeRepositoryLimits,
    manifest: &'a str,
    entries: usize,
    files: usize,
    total_bytes: u64,
    folded_paths: HashSet<String>,
    manifest_sha256: Option<String>,
}

impl<'a> MaterializationState<'a> {
    fn new(limits: RuntimeRepositoryLimits, manifest: &'a str) -> Self {
        Self {
            limits,
            manifest,
            entries: 0,
            files: 0,
            total_bytes: 0,
            folded_paths: HashSet::new(),
            manifest_sha256: None,
        }
    }

    fn record_entry(&mut self, relative: &Path) -> UpdaterResult<()> {
        self.entries = self
            .entries
            .checked_add(1)
            .ok_or_else(|| limit_error("runtime repository entry limit exceeded"))?;
        if self.entries > self.limits.max_entries {
            return Err(limit_error("runtime repository entry limit exceeded"));
        }
        let rendered = relative
            .to_str()
            .ok_or_else(|| git_error("repository path is not valid UTF-8"))?;
        let folded = rendered.chars().flat_map(char::to_lowercase).collect();
        if !self.folded_paths.insert(folded) {
            return Err(git_error("repository contains case-folded path collision"));
        }
        Ok(())
    }

    fn record_file(&mut self, relative: &Path, bytes: &[u8]) -> UpdaterResult<()> {
        self.files = self
            .files
            .checked_add(1)
            .ok_or_else(|| limit_error("runtime repository file limit exceeded"))?;
        if self.files > self.limits.max_files {
            return Err(limit_error("runtime repository file limit exceeded"));
        }
        let size = u64::try_from(bytes.len())
            .map_err(|_| limit_error("runtime repository file size limit exceeded"))?;
        if size > self.limits.max_file_bytes {
            return Err(limit_error("runtime repository file size limit exceeded"));
        }
        self.total_bytes = self
            .total_bytes
            .checked_add(size)
            .ok_or_else(|| limit_error("runtime repository total size limit exceeded"))?;
        if self.total_bytes > self.limits.max_total_bytes {
            return Err(limit_error("runtime repository total size limit exceeded"));
        }
        if relative == Path::new(self.manifest) {
            if size > self.limits.max_manifest_bytes {
                return Err(limit_error(
                    "runtime repository manifest size limit exceeded",
                ));
            }
            self.manifest_sha256 = Some(sha256_hex(bytes));
        }
        Ok(())
    }
}

fn materialize_tree(
    repository: &Repository,
    tree: &git2::Tree<'_>,
    destination: &Path,
    relative_parent: &Path,
    depth: usize,
    stop: &RuntimeRepositoryStopToken,
    state: &mut MaterializationState<'_>,
) -> UpdaterResult<()> {
    for entry in tree.iter() {
        check_cancelled(stop)?;
        let name = std::str::from_utf8(entry.name_bytes())
            .map_err(|_| git_error("repository path is not valid UTF-8"))?;
        validate_path_segment(name)?;
        let relative = relative_parent.join(name);
        state.record_entry(&relative)?;
        let output = destination.join(&relative);
        match entry.filemode_raw() {
            0o040000 => {
                let child_depth = depth
                    .checked_add(1)
                    .ok_or_else(|| limit_error("runtime repository depth limit exceeded"))?;
                if child_depth > state.limits.max_depth {
                    return Err(limit_error("runtime repository depth limit exceeded"));
                }
                fs::create_dir(&output)
                    .map_err(|_| io_error("failed to create repository directory"))?;
                let object = entry
                    .to_object(repository)
                    .map_err(|_| git_error("failed to read repository tree"))?;
                let child = object
                    .as_tree()
                    .ok_or_else(|| git_error("tree entry has invalid object type"))?;
                materialize_tree(
                    repository,
                    child,
                    destination,
                    &relative,
                    child_depth,
                    stop,
                    state,
                )?;
            }
            0o100644 | 0o100755 => {
                let object = entry
                    .to_object(repository)
                    .map_err(|_| git_error("failed to read repository blob"))?;
                if object.kind() != Some(ObjectType::Blob) {
                    return Err(git_error("regular entry is not a blob"));
                }
                let blob = object
                    .as_blob()
                    .ok_or_else(|| git_error("regular entry is not a blob"))?;
                state.record_file(&relative, blob.content())?;
                write_blob(&output, blob.content(), stop)?;
                set_executable_if_needed(&output, entry.filemode_raw())?;
            }
            0o120000 => return Err(git_error("symbolic links are not allowed")),
            0o160000 => return Err(git_error("submodules are not allowed")),
            _ => return Err(git_error("special or unknown file mode is not allowed")),
        }
    }
    Ok(())
}

fn write_blob(output: &Path, bytes: &[u8], stop: &RuntimeRepositoryStopToken) -> UpdaterResult<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|_| io_error("failed to create repository file"))?;
    for chunk in bytes.chunks(64 * 1024) {
        check_cancelled(stop)?;
        file.write_all(chunk)
            .map_err(|_| io_error("failed to write repository file"))?;
    }
    file.sync_all()
        .map_err(|_| io_error("failed to persist repository file"))?;
    Ok(())
}

#[cfg(unix)]
fn set_executable_if_needed(path: &Path, mode: i32) -> UpdaterResult<()> {
    use std::os::unix::fs::PermissionsExt;
    if mode == 0o100755 {
        let mut permissions = fs::metadata(path)
            .map_err(|_| io_error("failed to inspect repository file"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)
            .map_err(|_| io_error("failed to apply repository file mode"))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_executable_if_needed(_path: &Path, _mode: i32) -> UpdaterResult<()> {
    Ok(())
}

fn validate_path_segment(segment: &str) -> UpdaterResult<()> {
    if segment.is_empty()
        || matches!(segment, "." | "..")
        || segment.contains(['/', '\\', '\0'])
        || segment.chars().any(char::is_control)
        || segment
            .chars()
            .any(|character| "<>:\"|?*".contains(character))
        || segment.ends_with(['.', ' '])
    {
        return Err(git_error("repository contains an unsafe path"));
    }
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(['.', ' ']);
    let upper = stem.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || is_reserved_numbered_name(&upper, "COM")
        || is_reserved_numbered_name(&upper, "LPT");
    if reserved {
        return Err(git_error("repository contains a reserved platform path"));
    }
    Ok(())
}

fn is_reserved_numbered_name(value: &str, prefix: &str) -> bool {
    matches!(
        value.strip_prefix(prefix),
        Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
    )
}

fn validate_manifest_request(manifest: &str) -> UpdaterResult<()> {
    validate_path_segment(manifest)?;
    if Path::new(manifest).components().count() != 1 {
        return Err(config_error("manifest must be a single path segment"));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn validate_exact_commit(commit: &str) -> UpdaterResult<()> {
    if commit.len() == 64 && commit.bytes().all(is_lower_hex) {
        return Err(git_error("runtime repository object format is unsupported"));
    }
    if commit.len() != 40 || !commit.bytes().all(is_lower_hex) {
        return Err(config_error(
            "exact commit must be 40 or 64 lowercase hexadecimal characters",
        ));
    }
    Ok(())
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn validate_advertised_reference(reference: &str) -> UpdaterResult<()> {
    if !(reference.starts_with("refs/heads/") || reference.starts_with("refs/tags/"))
        || !git2::Reference::is_valid_name(reference)
    {
        return Err(config_error("advertised reference is not allowed"));
    }
    Ok(())
}

fn validate_https_url(value: &str) -> UpdaterResult<()> {
    let parsed = Url::parse(value).map_err(|_| config_error("repository URL is not allowed"))?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(config_error("repository URL is not allowed"));
    }
    Ok(())
}

fn validate_limits(limits: RuntimeRepositoryLimits) -> UpdaterResult<()> {
    if limits.max_depth == 0
        || limits.max_entries == 0
        || limits.max_files == 0
        || limits.max_file_bytes == 0
        || limits.max_total_bytes == 0
        || limits.max_manifest_bytes == 0
        || limits.max_manifest_bytes > limits.max_file_bytes
    {
        return Err(config_error("runtime repository limits are invalid"));
    }
    Ok(())
}

fn check_cancelled(stop: &RuntimeRepositoryStopToken) -> UpdaterResult<()> {
    if stop.is_cancelled() {
        Err(UpdaterError::Cancelled)
    } else {
        Ok(())
    }
}

fn remove_transport(path: &Path) -> UpdaterResult<()> {
    fs::remove_dir_all(path).map_err(|_| io_error("failed to clean transport metadata"))
}

fn config_error(message: impl Into<String>) -> UpdaterError {
    UpdaterError::Config(message.into())
}

fn git_error(message: impl Into<String>) -> UpdaterError {
    UpdaterError::Git(message.into())
}

fn io_error(message: impl Into<String>) -> UpdaterError {
    UpdaterError::Io(message.into())
}

fn limit_error(message: impl Into<String>) -> UpdaterError {
    UpdaterError::Git(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Oid, Signature, TreeBuilder};
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    #[derive(Clone)]
    enum Node {
        Blob(Vec<u8>, i32),
        Tree(BTreeMap<String, Node>),
        Gitlink(Oid),
    }

    fn tree(entries: impl IntoIterator<Item = (&'static str, Node)>) -> Node {
        Node::Tree(
            entries
                .into_iter()
                .map(|(name, node)| (name.to_string(), node))
                .collect(),
        )
    }

    fn blob(bytes: impl AsRef<[u8]>) -> Node {
        Node::Blob(bytes.as_ref().to_vec(), 0o100644)
    }

    fn write_node(repository: &Repository, node: &Node) -> Oid {
        match node {
            Node::Blob(bytes, _) => repository.blob(bytes).unwrap(),
            Node::Gitlink(oid) => *oid,
            Node::Tree(entries) => {
                let mut builder: TreeBuilder<'_> = repository.treebuilder(None).unwrap();
                for (name, child) in entries {
                    let oid = write_node(repository, child);
                    let mode = match child {
                        Node::Blob(_, mode) => *mode,
                        Node::Tree(_) => 0o040000,
                        Node::Gitlink(_) => 0o160000,
                    };
                    builder.insert(name, oid, mode).unwrap();
                }
                builder.write().unwrap()
            }
        }
    }

    fn commit_repo(root: &Path, reference: &str, contents: &Node) -> String {
        let repository = Repository::init_bare(root).unwrap();
        let tree_oid = write_node(&repository, contents);
        let tree = repository.find_tree(tree_oid).unwrap();
        let signature = Signature::now("BAAS test", "baas@example.invalid").unwrap();
        repository
            .commit(
                Some(reference),
                &signature,
                &signature,
                "fixture",
                &tree,
                &[],
            )
            .unwrap()
            .to_string()
    }

    fn move_reference(root: &Path, reference: &str, contents: &Node) -> String {
        let repository = Repository::open_bare(root).unwrap();
        let parent = repository
            .find_reference(reference)
            .unwrap()
            .peel_to_commit()
            .unwrap();
        let tree_oid = write_node(&repository, contents);
        let tree = repository.find_tree(tree_oid).unwrap();
        let signature = Signature::now("BAAS test", "baas@example.invalid").unwrap();
        repository
            .commit(
                Some(reference),
                &signature,
                &signature,
                "moved fixture",
                &tree,
                &[&parent],
            )
            .unwrap()
            .to_string()
    }

    fn request(
        id: RuntimeRepositoryId,
        repo: &Path,
        commit: &str,
        manifest: &str,
    ) -> RuntimeRepositoryFetchRequest {
        RuntimeRepositoryFetchRequest {
            id,
            url: Url::from_file_path(repo.canonicalize().unwrap())
                .unwrap()
                .to_string(),
            advertised_reference: "refs/heads/main".into(),
            exact_commit: commit.into(),
            manifest: manifest.into(),
        }
    }

    fn download_fixture(
        contents: Node,
        manifest: &str,
    ) -> (TempDir, RuntimeRepositoryFetchMetadata) {
        let temp = TempDir::new().unwrap();
        let remote = temp.path().join("remote.git");
        let commit = commit_repo(&remote, "refs/heads/main", &contents);
        let staging = temp.path().join("staging");
        fs::create_dir(&staging).unwrap();
        let downloader = RuntimeRepositoryGit2Downloader::for_local_tests(Default::default());
        let metadata = downloader
            .download(
                &request(RuntimeRepositoryId::Resources, &remote, &commit, manifest),
                &staging,
                &RuntimeRepositoryStopToken::default(),
            )
            .unwrap();
        (temp, metadata)
    }

    #[test]
    fn production_policy_rejects_non_https_credentials_and_redacts_debug() {
        let downloader = RuntimeRepositoryGit2Downloader::new(Default::default()).unwrap();
        for url in [
            "http://example.invalid/repo.git",
            "file:///tmp/repo.git",
            "C:/repo.git",
            "https://user:secret@example.invalid/repo.git",
        ] {
            let request = RuntimeRepositoryFetchRequest {
                id: RuntimeRepositoryId::Resources,
                url: url.into(),
                advertised_reference: "refs/heads/main".into(),
                exact_commit: "a".repeat(40),
                manifest: "manifest.json".into(),
            };
            assert!(downloader.validate_request(&request).is_err());
            let debug = format!("{request:?}");
            assert!(!debug.contains(url));
            assert!(!debug.contains("secret"));
        }
    }

    #[test]
    fn sha256_object_id_is_explicitly_unsupported() {
        let downloader = RuntimeRepositoryGit2Downloader::new(Default::default()).unwrap();
        let request = RuntimeRepositoryFetchRequest {
            id: RuntimeRepositoryId::Resources,
            url: "https://example.invalid/repo.git".into(),
            advertised_reference: "refs/heads/main".into(),
            exact_commit: "a".repeat(64),
            manifest: "manifest.json".into(),
        };
        assert_eq!(
            downloader.validate_request(&request),
            Err(UpdaterError::Git(
                "runtime repository object format is unsupported".into()
            ))
        );
    }

    #[test]
    fn materializes_exact_commit_hashes_manifest_and_removes_transport() {
        let manifest = br#"{"schema":"test"}"#;
        let (temp, metadata) = download_fixture(
            tree([
                ("manifest.json", blob(manifest)),
                ("nested", tree([("payload.bin", blob(b"payload"))])),
            ]),
            "manifest.json",
        );
        let staging = temp.path().join("staging");
        assert_eq!(metadata.manifest_sha256, sha256_hex(manifest));
        assert!(staging.join("nested/payload.bin").is_file());
        assert!(!staging.join(".git").exists());
        assert!(!staging.join(".t").exists());
    }

    #[test]
    fn rejects_mismatch_symlink_submodule_and_unsafe_paths() {
        for unsafe_segment in ["", ".", "..", "dir\\file", "C:drive", "CON.txt", "tail. "] {
            assert!(validate_path_segment(unsafe_segment).is_err());
        }
        let fixtures = [
            tree([
                ("manifest.json", blob(b"ok")),
                ("link", Node::Blob(b"target".to_vec(), 0o120000)),
            ]),
            tree([
                ("manifest.json", blob(b"ok")),
                (
                    "module",
                    Node::Gitlink(Oid::from_str(&"b".repeat(40)).unwrap()),
                ),
            ]),
            tree([("manifest.json", blob(b"ok")), ("CON.txt", blob(b"bad"))]),
            tree([("manifest.json", blob(b"ok")), ("dir\\file", blob(b"bad"))]),
            tree([("manifest.json", blob(b"ok")), ("C:drive", blob(b"bad"))]),
            tree([("manifest.json", tree([("nested", blob(b"bad"))]))]),
            tree([("manifest.json", blob(b"ok")), ("trailing.", blob(b"bad"))]),
            tree([
                ("manifest.json", blob(b"ok")),
                ("Name", blob(b"one")),
                ("name", blob(b"two")),
            ]),
        ];
        for contents in fixtures {
            let temp = TempDir::new().unwrap();
            let remote = temp.path().join("remote.git");
            let commit = commit_repo(&remote, "refs/heads/main", &contents);
            let staging = temp.path().join("staging");
            fs::create_dir(&staging).unwrap();
            let result = RuntimeRepositoryGit2Downloader::for_local_tests(Default::default())
                .download(
                    &request(
                        RuntimeRepositoryId::Resources,
                        &remote,
                        &commit,
                        "manifest.json",
                    ),
                    &staging,
                    &RuntimeRepositoryStopToken::default(),
                );
            assert!(result.is_err());
        }

        let temp = TempDir::new().unwrap();
        let remote = temp.path().join("remote.git");
        let commit = commit_repo(
            &remote,
            "refs/heads/main",
            &tree([("manifest.json", blob(b"ok"))]),
        );
        let moved = request(
            RuntimeRepositoryId::Resources,
            &remote,
            &commit,
            "manifest.json",
        );
        let newer_commit = move_reference(
            &remote,
            "refs/heads/main",
            &tree([("manifest.json", blob(b"new"))]),
        );
        assert_ne!(moved.exact_commit, newer_commit);
        let staging = temp.path().join("staging");
        fs::create_dir(&staging).unwrap();
        assert!(
            RuntimeRepositoryGit2Downloader::for_local_tests(Default::default())
                .download(&moved, &staging, &RuntimeRepositoryStopToken::default())
                .is_err()
        );
    }

    #[test]
    fn cancellation_and_limits_fail_closed() {
        let temp = TempDir::new().unwrap();
        let remote = temp.path().join("remote.git");
        let commit = commit_repo(
            &remote,
            "refs/heads/main",
            &tree([("manifest.json", blob(b"0123456789"))]),
        );
        let store = RuntimeRepositoryStore::open(temp.path().join("install")).unwrap();
        let request = request(
            RuntimeRepositoryId::Resources,
            &remote,
            &commit,
            "manifest.json",
        );
        let already_cancelled = RuntimeRepositoryStopToken::default();
        already_cancelled.cancel();
        assert_eq!(
            store.download_candidate_with_stop(
                &RuntimeRepositoryGit2Downloader::for_local_tests(Default::default()),
                &request,
                &already_cancelled,
            ),
            Err(UpdaterError::Cancelled)
        );
        assert_eq!(
            fs::read_dir(store.root().join("staging")).unwrap().count(),
            0
        );
        let token = RuntimeRepositoryStopToken::default();
        let cancelling = RuntimeRepositoryGit2Downloader::for_local_tests(Default::default())
            .cancelling_before_materialization();
        assert_eq!(
            store.download_candidate_with_stop(&cancelling, &request, &token),
            Err(UpdaterError::Cancelled)
        );
        assert_eq!(
            fs::read_dir(store.root().join("staging")).unwrap().count(),
            0
        );

        let limits = RuntimeRepositoryLimits {
            max_file_bytes: 4,
            max_manifest_bytes: 4,
            ..Default::default()
        };
        assert!(
            store
                .download_candidate(
                    &RuntimeRepositoryGit2Downloader::for_local_tests(limits),
                    &request
                )
                .is_err()
        );
        assert_eq!(
            fs::read_dir(store.root().join("staging")).unwrap().count(),
            0
        );
    }

    #[test]
    fn enforces_depth_entry_file_and_total_limits() {
        let cases = [
            (
                tree([
                    ("manifest.json", blob(b"ok")),
                    ("one", tree([("two", tree([("value", blob(b"x"))]))])),
                ]),
                RuntimeRepositoryLimits {
                    max_depth: 1,
                    ..Default::default()
                },
            ),
            (
                tree([("manifest.json", blob(b"ok")), ("extra", blob(b"x"))]),
                RuntimeRepositoryLimits {
                    max_entries: 1,
                    ..Default::default()
                },
            ),
            (
                tree([("manifest.json", blob(b"ok")), ("extra", blob(b"x"))]),
                RuntimeRepositoryLimits {
                    max_files: 1,
                    ..Default::default()
                },
            ),
            (
                tree([("manifest.json", blob(b"123")), ("extra", blob(b"456"))]),
                RuntimeRepositoryLimits {
                    max_file_bytes: 4,
                    max_manifest_bytes: 4,
                    max_total_bytes: 5,
                    ..Default::default()
                },
            ),
        ];
        for (contents, limits) in cases {
            let temp = TempDir::new().unwrap();
            let remote = temp.path().join("remote.git");
            let commit = commit_repo(&remote, "refs/heads/main", &contents);
            let store = RuntimeRepositoryStore::open(temp.path().join("i")).unwrap();
            let request = request(
                RuntimeRepositoryId::Resources,
                &remote,
                &commit,
                "manifest.json",
            );
            assert!(
                store
                    .download_candidate(
                        &RuntimeRepositoryGit2Downloader::for_local_tests(limits),
                        &request,
                    )
                    .is_err()
            );
            assert_eq!(
                fs::read_dir(store.root().join("staging")).unwrap().count(),
                0
            );
        }
    }

    #[test]
    fn two_repository_orchestration_cleans_first_on_second_failure_and_publishes_protocol() {
        let temp = TempDir::new().unwrap();
        let resources_repo = temp.path().join("resources.git");
        let scripts_repo = temp.path().join("scripts.git");
        let resources_commit = commit_repo(
            &resources_repo,
            "refs/heads/main",
            &tree([("resources.json", blob(b"resources"))]),
        );
        let scripts_commit = commit_repo(
            &scripts_repo,
            "refs/heads/main",
            &tree([("scripts.json", blob(b"scripts"))]),
        );
        let resources = request(
            RuntimeRepositoryId::Resources,
            &resources_repo,
            &resources_commit,
            "resources.json",
        );
        let scripts = request(
            RuntimeRepositoryId::Scripts,
            &scripts_repo,
            &scripts_commit,
            "scripts.json",
        );
        let store = RuntimeRepositoryStore::open(temp.path().join("install")).unwrap();
        let updater = RuntimeRepositoryUpdater::new(
            store.clone(),
            RuntimeRepositoryGit2Downloader::for_local_tests(Default::default()),
        );

        let mut bad_scripts = scripts.clone();
        bad_scripts.exact_commit = "d".repeat(40);
        assert!(
            updater
                .update_from_requests(&resources, &bad_scripts, None, &Default::default())
                .is_err()
        );
        assert!(!store.root().join("current.json").exists());
        assert_eq!(
            fs::read_dir(store.root().join("staging")).unwrap().count(),
            0
        );

        let activation = updater
            .update_from_requests(&resources, &scripts, None, &Default::default())
            .unwrap();
        assert_eq!(activation.snapshot.repositories[0].commit, resources_commit);
        assert_eq!(activation.snapshot.repositories[1].commit, scripts_commit);
        assert!(store.root().join("current.json").is_file());
    }

    struct CancelAfterSecondDownload {
        inner: RuntimeRepositoryGit2Downloader,
        completed: AtomicUsize,
    }

    impl RuntimeRepositoryDownloader for CancelAfterSecondDownload {
        fn download(
            &self,
            request: &RuntimeRepositoryFetchRequest,
            staging_root: &Path,
            stop: &RuntimeRepositoryStopToken,
        ) -> UpdaterResult<RuntimeRepositoryFetchMetadata> {
            let metadata = self.inner.download(request, staging_root, stop)?;
            if self.completed.fetch_add(1, Ordering::AcqRel) == 1 {
                stop.cancel();
            }
            Ok(metadata)
        }
    }

    #[test]
    fn cancellation_between_second_download_and_publish_preserves_current() {
        let temp = TempDir::new().unwrap();
        let resources_repo = temp.path().join("r.git");
        let scripts_repo = temp.path().join("s.git");
        let resources_commit = commit_repo(
            &resources_repo,
            "refs/heads/main",
            &tree([("resources.json", blob(b"resources"))]),
        );
        let scripts_commit = commit_repo(
            &scripts_repo,
            "refs/heads/main",
            &tree([("scripts.json", blob(b"scripts"))]),
        );
        let resources = request(
            RuntimeRepositoryId::Resources,
            &resources_repo,
            &resources_commit,
            "resources.json",
        );
        let scripts = request(
            RuntimeRepositoryId::Scripts,
            &scripts_repo,
            &scripts_commit,
            "scripts.json",
        );
        let store = RuntimeRepositoryStore::open(temp.path().join("i")).unwrap();
        let updater = RuntimeRepositoryUpdater::new(
            store.clone(),
            CancelAfterSecondDownload {
                inner: RuntimeRepositoryGit2Downloader::for_local_tests(Default::default()),
                completed: AtomicUsize::new(0),
            },
        );
        let stop = RuntimeRepositoryStopToken::default();
        assert_eq!(
            updater.update_from_requests(&resources, &scripts, None, &stop),
            Err(UpdaterError::Cancelled)
        );
        assert!(!store.root().join("current.json").exists());
        assert_eq!(
            fs::read_dir(store.root().join("staging")).unwrap().count(),
            0
        );
    }
}
