//! Restricted git2 transport and orchestration for immutable runtime repositories.
//!
//! This provider is intentionally separate from the legacy updater workflow.

use crate::{
    UpdaterError, UpdaterResult,
    runtime_repository_store::{
        RuntimeRepositoryActivation, RuntimeRepositoryCandidate, RuntimeRepositoryDownloader,
        RuntimeRepositoryFetchMetadata, RuntimeRepositoryFetchRequest, RuntimeRepositoryId,
        RuntimeRepositoryStopToken, RuntimeRepositoryStore, validate_runtime_repository_tree,
    },
};
use git2::{
    AutotagOption, FetchOptions, ObjectType, RemoteCallbacks, RemoteRedirect, Repository,
    transport::{Service, SmartSubtransport, SmartSubtransportStream, Transport},
};
use reqwest::{
    blocking::{Client, Response},
    header::{ACCEPT, CONTENT_TYPE, HeaderValue},
    redirect::Policy,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, Cursor, Read, Write},
    path::Path,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use url::Url;
use uuid::Uuid;

const FETCHED_REFERENCE: &str = "refs/baas/runtime";
const RESTRICTED_HTTPS_SCHEME: &str = "baas-https";
const MAX_UPLOAD_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_ADVERTISEMENT_BYTES_CEILING: u64 = 64 * 1024 * 1024;
const MAX_ADVERTISED_REFS_CEILING: usize = 100_000;
static RESTRICTED_HTTPS_REGISTRATION: OnceLock<Result<(), ()>> = OnceLock::new();
static RESTRICTED_HTTPS_CONTEXTS: OnceLock<Mutex<HashMap<String, Arc<HttpsTransportContext>>>> =
    OnceLock::new();

/// Bounds applied before and during tree materialization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeRepositoryLimits {
    pub connect_timeout_ms: u32,
    /// Maximum wait for response headers or for one body read to make progress.
    pub read_timeout_ms: u32,
    pub max_advertisement_bytes: u64,
    pub max_advertised_refs: usize,
    pub max_fetch_bytes: u64,
    pub max_fetch_objects: usize,
    /// Absolute ceiling for one fetch, distinct from the per-read stall timeout.
    pub fetch_deadline_ms: u32,
    pub max_odb_object_bytes: u64,
    pub max_odb_total_bytes: u64,
    pub odb_validation_timeout_ms: u32,
    pub max_commit_bytes: u64,
    pub max_tree_bytes: u64,
    pub max_tag_bytes: u64,
    pub max_tag_depth: usize,
    pub max_path_bytes: usize,
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
            connect_timeout_ms: 15_000,
            read_timeout_ms: 15_000,
            max_advertisement_bytes: 4 * 1024 * 1024,
            max_advertised_refs: 8_192,
            max_fetch_bytes: 3 * 1024 * 1024 * 1024,
            max_fetch_objects: 200_000,
            fetch_deadline_ms: 30 * 60 * 1_000,
            max_odb_object_bytes: 256 * 1024 * 1024,
            max_odb_total_bytes: 3 * 1024 * 1024 * 1024,
            odb_validation_timeout_ms: 30_000,
            max_commit_bytes: 1024 * 1024,
            max_tree_bytes: 16 * 1024 * 1024,
            max_tag_bytes: 1024 * 1024,
            max_tag_depth: 8,
            max_path_bytes: 1024,
            max_depth: 32,
            max_entries: 32_768,
            max_files: 16_384,
            max_file_bytes: 256 * 1024 * 1024,
            max_total_bytes: 2 * 1024 * 1024 * 1024,
            max_manifest_bytes: 16 * 1024 * 1024,
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

    /// Upper bound for one blocked connect, TLS, read, or write wait before
    /// cancellation can be observed. This is not a total-fetch duration;
    /// active pack transfer observes cancellation on each progress callback.
    pub fn network_stop_response_bound(&self) -> Duration {
        Duration::from_millis(u64::from(
            self.limits
                .connect_timeout_ms
                .max(self.limits.read_timeout_ms),
        ))
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
        let fetch_deadline = Instant::now()
            .checked_add(Duration::from_millis(u64::from(
                self.limits.fetch_deadline_ms,
            )))
            .ok_or_else(|| limit_error("runtime repository fetch deadline is invalid"))?;

        let transport = staging_root.join(".t");
        fs::create_dir(&transport).map_err(|_| io_error("failed to create transport workspace"))?;
        let repository = Repository::init_bare(&transport)
            .map_err(|_| git_error("failed to initialize transport repository"))?;
        let https_context = match self.policy {
            TransportPolicy::HttpsOnly => Some(RestrictedHttpsContextGuard::install(
                &request.url,
                self.limits,
                stop,
                fetch_deadline,
            )?),
            #[cfg(test)]
            TransportPolicy::LocalTestOnly => None,
        };
        let remote_url = https_context
            .as_ref()
            .map_or(request.url.as_str(), RestrictedHttpsContextGuard::url);

        {
            let mut fetch_limit_exceeded = false;
            let mut fetch_deadline_exceeded = false;
            let mut callbacks = RemoteCallbacks::new();
            callbacks.transfer_progress(|progress| {
                let received_bytes = u64::try_from(progress.received_bytes()).unwrap_or(u64::MAX);
                let observed_objects = progress.total_objects().max(progress.received_objects());
                if received_bytes > self.limits.max_fetch_bytes
                    || observed_objects > self.limits.max_fetch_objects
                {
                    fetch_limit_exceeded = true;
                    return false;
                }
                if Instant::now() >= fetch_deadline {
                    fetch_deadline_exceeded = true;
                    return false;
                }
                !stop.is_cancelled()
            });
            let mut options = FetchOptions::new();
            options.remote_callbacks(callbacks);
            if self.policy == TransportPolicy::HttpsOnly {
                options.depth(1);
            }
            options.download_tags(AutotagOption::None);
            options.follow_redirects(RemoteRedirect::None);
            let refspec = format!("+{}:{}", request.advertised_reference, FETCHED_REFERENCE);
            let mut remote = repository
                .remote_anonymous(remote_url)
                .map_err(|_| git_error("failed to create restricted remote"))?;
            let fetch_result = remote.fetch(&[&refspec], Some(&mut options), None);
            drop(remote);
            drop(options);
            if fetch_result.is_err() {
                return if stop.is_cancelled() {
                    Err(UpdaterError::Cancelled)
                } else if fetch_limit_exceeded {
                    Err(limit_error("runtime repository fetch limit exceeded"))
                } else if fetch_deadline_exceeded || Instant::now() >= fetch_deadline {
                    Err(limit_error("runtime repository fetch deadline exceeded"))
                } else {
                    Err(git_error("failed to fetch advertised reference"))
                };
            }
        }
        if Instant::now() >= fetch_deadline {
            return Err(limit_error("runtime repository fetch deadline exceeded"));
        }
        check_cancelled(stop)?;
        validate_fetched_odb(&repository, self.limits, stop, fetch_deadline)?;

        let reference = repository
            .find_reference(FETCHED_REFERENCE)
            .map_err(|_| git_error("advertised reference was not fetched"))?;
        let advertised_oid = reference
            .target()
            .ok_or_else(|| git_error("advertised reference has no direct object"))?;
        let commit = peel_bounded_commit(&repository, advertised_oid, self.limits)?;
        let actual_commit = commit.id().to_string();
        if actual_commit.as_bytes() != request.exact_commit.as_bytes() {
            return Err(git_error("fetched commit does not match exact commit"));
        }

        #[cfg(test)]
        if self.cancel_before_materialization {
            stop.cancel();
        }
        check_cancelled(stop)?;

        let tree = find_bounded_tree(&repository, commit.tree_id(), self.limits.max_tree_bytes)?;
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
        validate_runtime_repository_tree(staging_root, &request.manifest, &manifest_sha256)?;

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

struct HttpsTransportContext {
    url: Url,
    client: Client,
    stop: RuntimeRepositoryStopToken,
    max_advertisement_bytes: u64,
    max_advertised_refs: usize,
    max_pack_response_bytes: u64,
    pack_response_bytes: AtomicU64,
    fetch_deadline: Instant,
}

struct RestrictedHttpsContextGuard {
    key: String,
    url: String,
}

impl RestrictedHttpsContextGuard {
    fn install(
        original_url: &str,
        limits: RuntimeRepositoryLimits,
        stop: &RuntimeRepositoryStopToken,
        fetch_deadline: Instant,
    ) -> UpdaterResult<Self> {
        register_restricted_https_transport()?;
        let url = Url::parse(original_url)
            .map_err(|_| config_error("runtime repository URL is invalid"))?;
        let client = Client::builder()
            .https_only(true)
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_millis(u64::from(limits.connect_timeout_ms)))
            // reqwest's blocking client reapplies this duration while waiting
            // for response headers and on every Response::read call. It is a
            // no-progress I/O timeout, not one deadline for the whole body.
            .timeout(Duration::from_millis(u64::from(limits.read_timeout_ms)))
            .build()
            .map_err(|_| git_error("failed to initialize restricted HTTPS transport"))?;
        let key = Uuid::new_v4().simple().to_string();
        let context = Arc::new(HttpsTransportContext {
            url,
            client,
            stop: stop.clone(),
            max_advertisement_bytes: limits.max_advertisement_bytes,
            max_advertised_refs: limits.max_advertised_refs,
            max_pack_response_bytes: limits.max_fetch_bytes,
            pack_response_bytes: AtomicU64::new(0),
            fetch_deadline,
        });
        restricted_https_contexts()
            .lock()
            .map_err(|_| git_error("restricted HTTPS transport gate is unavailable"))?
            .insert(key.clone(), context);
        Ok(Self {
            url: format!("{RESTRICTED_HTTPS_SCHEME}://{key}"),
            key,
        })
    }

    fn url(&self) -> &str {
        &self.url
    }
}

impl Drop for RestrictedHttpsContextGuard {
    fn drop(&mut self) {
        if let Ok(mut contexts) = restricted_https_contexts().lock() {
            contexts.remove(&self.key);
        }
    }
}

fn restricted_https_contexts() -> &'static Mutex<HashMap<String, Arc<HttpsTransportContext>>> {
    RESTRICTED_HTTPS_CONTEXTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[ctor::ctor]
fn initialize_restricted_https_transport() {
    let _ = register_restricted_https_transport();
}

fn register_restricted_https_transport() -> UpdaterResult<()> {
    let registration = RESTRICTED_HTTPS_REGISTRATION.get_or_init(|| {
        // SAFETY: the constructor above registers this unique scheme before
        // main can create concurrent transports. OnceLock makes the fallback
        // call idempotent, and the scheme is never replaced or unregistered.
        // Built-in transports used by legacy updater paths are untouched.
        unsafe {
            git2::transport::register(RESTRICTED_HTTPS_SCHEME, |remote| {
                let custom_url = Url::parse(remote.url()?)
                    .map_err(|_| git2::Error::from_str("restricted HTTPS context is invalid"))?;
                let key = custom_url
                    .host_str()
                    .ok_or_else(|| git2::Error::from_str("restricted HTTPS context is missing"))?;
                let context = restricted_https_contexts()
                    .lock()
                    .map_err(|_| git2::Error::from_str("restricted HTTPS context is unavailable"))?
                    .get(key)
                    .cloned()
                    .ok_or_else(|| git2::Error::from_str("restricted HTTPS context expired"))?;
                Transport::smart(remote, true, RestrictedHttpsSubtransport { context })
            })
        }
        .map_err(|_| ())
    });
    registration
        .as_ref()
        .map_err(|_| git_error("failed to register restricted HTTPS transport"))
        .copied()
}

struct RestrictedHttpsSubtransport {
    context: Arc<HttpsTransportContext>,
}

impl SmartSubtransport for RestrictedHttpsSubtransport {
    fn action(
        &self,
        _url: &str,
        service: Service,
    ) -> Result<Box<dyn SmartSubtransportStream>, git2::Error> {
        if self.context.stop.is_cancelled() {
            return Err(git2::Error::from_str("runtime repository fetch cancelled"));
        }
        if Instant::now() >= self.context.fetch_deadline {
            return Err(git2::Error::from_str(
                "runtime repository fetch deadline exceeded",
            ));
        }
        match service {
            Service::UploadPackLs => {
                let mut endpoint = git_service_url(&self.context.url, "info/refs");
                endpoint.set_query(Some("service=git-upload-pack"));
                let response = self
                    .context
                    .client
                    .get(endpoint)
                    .header(ACCEPT, "application/x-git-upload-pack-advertisement")
                    .send()
                    .map_err(|_| git2::Error::from_str("restricted HTTPS request failed"))?;
                validate_git_response(
                    &response,
                    "application/x-git-upload-pack-advertisement",
                    self.context.max_advertisement_bytes,
                )?;
                let advertisement = read_and_validate_advertisement(
                    response,
                    self.context.max_advertisement_bytes,
                    self.context.max_advertised_refs,
                    &self.context.stop,
                    self.context.fetch_deadline,
                )?;
                Ok(Box::new(RestrictedHttpsStream::buffered(
                    Arc::clone(&self.context),
                    advertisement,
                )))
            }
            Service::UploadPack => Ok(Box::new(RestrictedHttpsStream::request(Arc::clone(
                &self.context,
            )))),
            Service::ReceivePackLs | Service::ReceivePack => Err(git2::Error::from_str(
                "restricted HTTPS transport is fetch-only",
            )),
        }
    }

    fn close(&self) -> Result<(), git2::Error> {
        Ok(())
    }
}

enum RestrictedHttpsStreamState {
    Response(Response),
    Buffered(Cursor<Vec<u8>>),
    Request(Vec<u8>),
}

struct RestrictedHttpsStream {
    context: Arc<HttpsTransportContext>,
    state: RestrictedHttpsStreamState,
}

impl RestrictedHttpsStream {
    fn buffered(context: Arc<HttpsTransportContext>, bytes: Vec<u8>) -> Self {
        Self {
            context,
            state: RestrictedHttpsStreamState::Buffered(Cursor::new(bytes)),
        }
    }

    fn request(context: Arc<HttpsTransportContext>) -> Self {
        Self {
            context,
            state: RestrictedHttpsStreamState::Request(Vec::new()),
        }
    }

    fn send_request(&mut self) -> io::Result<()> {
        let RestrictedHttpsStreamState::Request(body) = &mut self.state else {
            return Ok(());
        };
        if self.context.stop.is_cancelled() {
            return Err(io::Error::other("runtime repository fetch cancelled"));
        }
        if Instant::now() >= self.context.fetch_deadline {
            return Err(io::Error::other(
                "runtime repository fetch deadline exceeded",
            ));
        }
        let endpoint = git_service_url(&self.context.url, "git-upload-pack");
        let request_body = std::mem::take(body);
        let response = self
            .context
            .client
            .post(endpoint)
            .header(CONTENT_TYPE, "application/x-git-upload-pack-request")
            .header(ACCEPT, "application/x-git-upload-pack-result")
            .body(request_body)
            .send()
            .map_err(|_| io::Error::other("restricted HTTPS request failed"))?;
        if Instant::now() >= self.context.fetch_deadline {
            return Err(io::Error::other(
                "runtime repository fetch deadline exceeded",
            ));
        }
        validate_git_response(
            &response,
            "application/x-git-upload-pack-result",
            self.context.max_pack_response_bytes,
        )
        .map_err(|_| io::Error::other("restricted HTTPS response is invalid"))?;
        self.state = RestrictedHttpsStreamState::Response(response);
        Ok(())
    }
}

impl Read for RestrictedHttpsStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.context.stop.is_cancelled() {
            return Err(io::Error::other("runtime repository fetch cancelled"));
        }
        if Instant::now() >= self.context.fetch_deadline {
            return Err(io::Error::other(
                "runtime repository fetch deadline exceeded",
            ));
        }
        if matches!(self.state, RestrictedHttpsStreamState::Request(_)) {
            self.send_request()?;
        }
        if let RestrictedHttpsStreamState::Buffered(bytes) = &mut self.state {
            return bytes.read(buffer);
        }
        let RestrictedHttpsStreamState::Response(response) = &mut self.state else {
            unreachable!("request stream becomes a response before reading")
        };
        let used = self.context.pack_response_bytes.load(Ordering::Relaxed);
        if used >= self.context.max_pack_response_bytes {
            let mut extra = [0_u8; 1];
            return match response.read(&mut extra) {
                Ok(0) => Ok(0),
                Ok(_) => Err(io::Error::other(
                    "runtime repository HTTPS response limit exceeded",
                )),
                Err(_) => Err(io::Error::other("restricted HTTPS response read failed")),
            };
        }
        let remaining = self.context.max_pack_response_bytes - used;
        let allowed = usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let read = response
            .read(&mut buffer[..allowed])
            .map_err(|_| io::Error::other("restricted HTTPS response read failed"))?;
        if Instant::now() >= self.context.fetch_deadline {
            return Err(io::Error::other(
                "runtime repository fetch deadline exceeded",
            ));
        }
        let read_u64 = u64::try_from(read).unwrap_or(u64::MAX);
        let previous = self
            .context
            .pack_response_bytes
            .fetch_add(read_u64, Ordering::Relaxed);
        if previous.saturating_add(read_u64) > self.context.max_pack_response_bytes {
            return Err(io::Error::other(
                "runtime repository HTTPS response limit exceeded",
            ));
        }
        Ok(read)
    }
}

impl Write for RestrictedHttpsStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let RestrictedHttpsStreamState::Request(body) = &mut self.state else {
            return Err(io::Error::other("restricted HTTPS response is read-only"));
        };
        if self.context.stop.is_cancelled() {
            return Err(io::Error::other("runtime repository fetch cancelled"));
        }
        if Instant::now() >= self.context.fetch_deadline {
            return Err(io::Error::other(
                "runtime repository fetch deadline exceeded",
            ));
        }
        let next_len = body
            .len()
            .checked_add(buffer.len())
            .ok_or_else(|| io::Error::other("Git upload request limit exceeded"))?;
        if next_len > MAX_UPLOAD_REQUEST_BYTES {
            return Err(io::Error::other("Git upload request limit exceeded"));
        }
        body.extend_from_slice(buffer);
        if Instant::now() >= self.context.fetch_deadline {
            return Err(io::Error::other(
                "runtime repository fetch deadline exceeded",
            ));
        }
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn git_service_url(base: &Url, suffix: &str) -> Url {
    let mut url = base.clone();
    let mut path = url.path().trim_end_matches('/').to_string();
    path.push('/');
    path.push_str(suffix);
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    url
}

fn validate_git_response(
    response: &Response,
    expected_content_type: &'static str,
    max_response_bytes: u64,
) -> Result<(), git2::Error> {
    if !response.status().is_success() {
        return Err(git2::Error::from_str(
            "restricted HTTPS server returned an unsuccessful status",
        ));
    }
    let expected = HeaderValue::from_static(expected_content_type);
    if response.headers().get(CONTENT_TYPE) != Some(&expected) {
        return Err(git2::Error::from_str(
            "restricted HTTPS server returned an invalid content type",
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > max_response_bytes)
    {
        return Err(git2::Error::from_str(
            "runtime repository HTTPS response limit exceeded",
        ));
    }
    Ok(())
}

fn read_and_validate_advertisement(
    mut response: Response,
    max_bytes: u64,
    max_refs: usize,
    stop: &RuntimeRepositoryStopToken,
    deadline: Instant,
) -> Result<Vec<u8>, git2::Error> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        if stop.is_cancelled() {
            return Err(git2::Error::from_str("runtime repository fetch cancelled"));
        }
        if Instant::now() >= deadline {
            return Err(git2::Error::from_str(
                "runtime repository fetch deadline exceeded",
            ));
        }
        let read = response
            .read(&mut buffer)
            .map_err(|_| git2::Error::from_str("restricted HTTPS advertisement read failed"))?;
        if read == 0 {
            break;
        }
        let next = u64::try_from(bytes.len())
            .unwrap_or(u64::MAX)
            .saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
        if next > max_bytes {
            return Err(git2::Error::from_str(
                "runtime repository advertisement byte limit exceeded",
            ));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    validate_advertisement_pkt_lines(&bytes, max_refs)?;
    Ok(bytes)
}

fn validate_advertisement_pkt_lines(bytes: &[u8], max_refs: usize) -> Result<(), git2::Error> {
    let mut offset = 0usize;
    let mut saw_service = false;
    let mut refs = 0usize;
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset.saturating_add(4))
            .ok_or_else(|| git2::Error::from_str("runtime repository advertisement is invalid"))?;
        let header = std::str::from_utf8(header)
            .map_err(|_| git2::Error::from_str("runtime repository advertisement is invalid"))?;
        let length = usize::from_str_radix(header, 16)
            .map_err(|_| git2::Error::from_str("runtime repository advertisement is invalid"))?;
        offset += 4;
        if length <= 2 {
            continue;
        }
        if length < 4 {
            return Err(git2::Error::from_str(
                "runtime repository advertisement is invalid",
            ));
        }
        let payload_length = length - 4;
        let payload = bytes
            .get(offset..offset.saturating_add(payload_length))
            .ok_or_else(|| git2::Error::from_str("runtime repository advertisement is invalid"))?;
        offset += payload_length;
        if !saw_service {
            if !payload.starts_with(b"# service=git-upload-pack\n") {
                return Err(git2::Error::from_str(
                    "runtime repository advertisement service is invalid",
                ));
            }
            saw_service = true;
            continue;
        }
        refs = refs
            .checked_add(1)
            .ok_or_else(|| git2::Error::from_str("runtime repository ref limit exceeded"))?;
        if refs > max_refs {
            return Err(git2::Error::from_str(
                "runtime repository ref limit exceeded",
            ));
        }
    }
    if !saw_service {
        return Err(git2::Error::from_str(
            "runtime repository advertisement service is missing",
        ));
    }
    Ok(())
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
                    return Err(
                        self.error_after_discard(error, std::iter::once(&resources_candidate))
                    );
                }
            };
        let candidates = [resources_candidate, scripts_candidate];
        if let Err(error) = check_cancelled(stop) {
            return Err(self.error_after_discard(error, &candidates));
        }
        // Publication is the non-cancellable commit gate: after this call
        // begins, the store either preserves or atomically replaces current.
        match self.store.publish_if_current(&candidates, expected_current) {
            Ok(activation) => Ok(activation),
            Err(error) => Err(self.error_after_discard(error, &candidates)),
        }
    }

    fn error_after_discard<'a>(
        &self,
        original: UpdaterError,
        candidates: impl IntoIterator<Item = &'a RuntimeRepositoryCandidate>,
    ) -> UpdaterError {
        let mut cleanup_failed = false;
        for candidate in candidates {
            cleanup_failed |= self.store.discard_candidate(candidate).is_err();
        }
        if cleanup_failed {
            UpdaterError::Io(format!(
                "runtime repository staging cleanup failed after {} failure",
                original.code()
            ))
        } else {
            original
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
            .components()
            .map(|component| {
                component
                    .as_os_str()
                    .to_str()
                    .ok_or_else(|| git_error("repository path is not valid UTF-8"))
            })
            .collect::<UpdaterResult<Vec<_>>>()?
            .join("/");
        if rendered.len() > self.limits.max_path_bytes {
            return Err(limit_error("runtime repository path length limit exceeded"));
        }
        if rendered.split('/').count() > self.limits.max_depth {
            return Err(limit_error("runtime repository depth limit exceeded"));
        }
        let folded = portable_path_key(&rendered);
        if !self.folded_paths.insert(folded) {
            return Err(git_error("repository contains case-folded path collision"));
        }
        Ok(())
    }

    fn reserve_file(&mut self, relative: &Path, raw_size: usize) -> UpdaterResult<u64> {
        self.files = self
            .files
            .checked_add(1)
            .ok_or_else(|| limit_error("runtime repository file limit exceeded"))?;
        if self.files > self.limits.max_files {
            return Err(limit_error("runtime repository file limit exceeded"));
        }
        let size = u64::try_from(raw_size)
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
        if relative == Path::new(self.manifest) && size > self.limits.max_manifest_bytes {
            return Err(limit_error(
                "runtime repository manifest size limit exceeded",
            ));
        }
        Ok(size)
    }

    fn record_manifest_content(&mut self, relative: &Path, bytes: &[u8]) {
        if relative == Path::new(self.manifest) {
            self.manifest_sha256 = Some(sha256_hex(bytes));
        }
    }
}

fn validate_fetched_odb(
    repository: &Repository,
    limits: RuntimeRepositoryLimits,
    stop: &RuntimeRepositoryStopToken,
    fetch_deadline: Instant,
) -> UpdaterResult<()> {
    let odb = repository
        .odb()
        .map_err(|_| git_error("failed to inspect fetched object database"))?;
    let odb_deadline = Instant::now()
        .checked_add(Duration::from_millis(u64::from(
            limits.odb_validation_timeout_ms,
        )))
        .ok_or_else(|| limit_error("runtime repository object validation deadline is invalid"))?;
    let deadline = fetch_deadline.min(odb_deadline);
    let mut objects = 0usize;
    let mut total_bytes = 0u64;
    let mut failure = None;
    let scan = odb.foreach(|oid| {
        let result = (|| {
            check_cancelled(stop)?;
            if Instant::now() >= deadline {
                return Err(limit_error(
                    "runtime repository object validation deadline exceeded",
                ));
            }
            objects = objects
                .checked_add(1)
                .ok_or_else(|| limit_error("runtime repository object limit exceeded"))?;
            if objects > limits.max_fetch_objects {
                return Err(limit_error("runtime repository object limit exceeded"));
            }
            let (size, _) = odb
                .read_header(*oid)
                .map_err(|_| git_error("failed to inspect fetched object header"))?;
            let size = u64::try_from(size)
                .map_err(|_| limit_error("runtime repository object size limit exceeded"))?;
            if size > limits.max_odb_object_bytes {
                return Err(limit_error("runtime repository object size limit exceeded"));
            }
            total_bytes = total_bytes
                .checked_add(size)
                .ok_or_else(|| limit_error("runtime repository object byte limit exceeded"))?;
            if total_bytes > limits.max_odb_total_bytes {
                return Err(limit_error("runtime repository object byte limit exceeded"));
            }
            Ok(())
        })();
        if let Err(error) = result {
            failure = Some(error);
            false
        } else {
            true
        }
    });
    if let Some(error) = failure {
        return Err(error);
    }
    scan.map_err(|_| git_error("failed to enumerate fetched object database"))?;
    Ok(())
}

fn peel_bounded_commit(
    repository: &Repository,
    mut oid: git2::Oid,
    limits: RuntimeRepositoryLimits,
) -> UpdaterResult<git2::Commit<'_>> {
    let odb = repository
        .odb()
        .map_err(|_| git_error("failed to inspect repository object database"))?;
    for tag_depth in 0..=limits.max_tag_depth {
        let (raw_size, kind) = odb
            .read_header(oid)
            .map_err(|_| git_error("failed to inspect advertised object header"))?;
        let raw_size = u64::try_from(raw_size)
            .map_err(|_| limit_error("runtime repository metadata size limit exceeded"))?;
        match kind {
            ObjectType::Commit => {
                if raw_size > limits.max_commit_bytes {
                    return Err(limit_error("runtime repository commit size limit exceeded"));
                }
                return repository
                    .find_commit(oid)
                    .map_err(|_| git_error("failed to read exact commit"));
            }
            ObjectType::Tag if tag_depth < limits.max_tag_depth => {
                if raw_size > limits.max_tag_bytes {
                    return Err(limit_error("runtime repository tag size limit exceeded"));
                }
                oid = repository
                    .find_tag(oid)
                    .map_err(|_| git_error("failed to read advertised tag"))?
                    .target_id();
            }
            ObjectType::Tag => {
                return Err(limit_error("runtime repository tag depth limit exceeded"));
            }
            _ => return Err(git_error("advertised reference does not peel to a commit")),
        }
    }
    Err(limit_error("runtime repository tag depth limit exceeded"))
}

fn find_bounded_tree(
    repository: &Repository,
    oid: git2::Oid,
    max_tree_bytes: u64,
) -> UpdaterResult<git2::Tree<'_>> {
    let odb = repository
        .odb()
        .map_err(|_| git_error("failed to inspect repository object database"))?;
    let (raw_size, kind) = odb
        .read_header(oid)
        .map_err(|_| git_error("failed to inspect repository tree header"))?;
    let raw_size = u64::try_from(raw_size)
        .map_err(|_| limit_error("runtime repository tree size limit exceeded"))?;
    if kind != ObjectType::Tree {
        return Err(git_error("tree entry has invalid object type"));
    }
    if raw_size > max_tree_bytes {
        return Err(limit_error("runtime repository tree size limit exceeded"));
    }
    repository
        .find_tree(oid)
        .map_err(|_| git_error("failed to read repository tree"))
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
                let child = find_bounded_tree(repository, entry.id(), state.limits.max_tree_bytes)?;
                materialize_tree(
                    repository,
                    &child,
                    destination,
                    &relative,
                    child_depth,
                    stop,
                    state,
                )?;
            }
            0o100644 => {
                let odb = repository
                    .odb()
                    .map_err(|_| git_error("failed to inspect repository object database"))?;
                let (raw_size, raw_kind) = odb
                    .read_header(entry.id())
                    .map_err(|_| git_error("failed to inspect repository blob header"))?;
                if raw_kind != ObjectType::Blob {
                    return Err(git_error("regular entry is not a blob"));
                }
                let reserved_size = state.reserve_file(&relative, raw_size)?;
                let object = entry
                    .to_object(repository)
                    .map_err(|_| git_error("failed to read repository blob"))?;
                if object.kind() != Some(ObjectType::Blob) {
                    return Err(git_error("regular entry is not a blob"));
                }
                let blob = object
                    .as_blob()
                    .ok_or_else(|| git_error("regular entry is not a blob"))?;
                if u64::try_from(blob.size()).ok() != Some(reserved_size) {
                    return Err(git_error("repository blob size changed while reading"));
                }
                let content = blob.content();
                state.record_manifest_content(&relative, content);
                write_blob(&output, content, stop)?;
            }
            0o100755 => return Err(git_error("executable files are not allowed")),
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

fn validate_path_segment(segment: &str) -> UpdaterResult<()> {
    if segment.is_empty()
        || matches!(segment, "." | "..")
        || segment.contains(['/', '\\', '\0'])
        || segment.starts_with(' ')
        || segment.chars().any(is_nonportable_character)
        || segment.ends_with(['.', ' '])
    {
        return Err(git_error("repository contains an unsafe path"));
    }
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(['.', ' ']);
    let alias = portable_alias_key(stem);
    let reserved = matches!(alias.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || is_reserved_numbered_name(&alias, "COM")
        || is_reserved_numbered_name(&alias, "LPT");
    if reserved {
        return Err(git_error("repository contains a reserved platform path"));
    }
    Ok(())
}

fn portable_alias_key(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '\u{00b9}' => '1',
            '\u{00b2}' => '2',
            '\u{00b3}' => '3',
            other if other.is_ascii_lowercase() => other.to_ascii_uppercase(),
            other => other,
        })
        .collect()
}

fn portable_path_key(path: &str) -> String {
    path.chars()
        .map(|character| {
            if character.is_ascii_uppercase() {
                character.to_ascii_lowercase()
            } else {
                character
            }
        })
        .collect()
}

fn is_nonportable_character(character: char) -> bool {
    let codepoint = character as u32;
    character.is_control()
        || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
        || matches!(codepoint, 0x85 | 0x2028 | 0x2029)
        || (0x7f..=0x9f).contains(&codepoint)
        || (0xfdd0..=0xfdef).contains(&codepoint)
        || codepoint & 0xffff == 0xfffe
        || codepoint & 0xffff == 0xffff
        || is_combining_or_jamo(codepoint)
}

fn is_combining_or_jamo(codepoint: u32) -> bool {
    (0x0300..=0x036f).contains(&codepoint)
        || (0x1ab0..=0x1aff).contains(&codepoint)
        || (0x1dc0..=0x1dff).contains(&codepoint)
        || (0x20d0..=0x20ff).contains(&codepoint)
        || (0xfe20..=0xfe2f).contains(&codepoint)
        || matches!(codepoint, 0x3099 | 0x309a)
        || (0x1100..=0x11ff).contains(&codepoint)
        || (0xa960..=0xa97f).contains(&codepoint)
        || (0xd7b0..=0xd7ff).contains(&codepoint)
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
            "exact commit must be 40 lowercase hexadecimal characters",
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
    if limits.connect_timeout_ms == 0
        || limits.read_timeout_ms == 0
        || limits.connect_timeout_ms > i32::MAX as u32
        || limits.read_timeout_ms > i32::MAX as u32
        || limits.max_advertisement_bytes == 0
        || limits.max_advertisement_bytes > MAX_ADVERTISEMENT_BYTES_CEILING
        || limits.max_advertised_refs == 0
        || limits.max_advertised_refs > MAX_ADVERTISED_REFS_CEILING
        || limits.max_fetch_bytes == 0
        || limits.max_fetch_objects == 0
        || limits.fetch_deadline_ms == 0
        || limits.max_odb_object_bytes == 0
        || limits.max_odb_total_bytes < limits.max_odb_object_bytes
        || limits.odb_validation_timeout_ms == 0
        || limits.max_commit_bytes == 0
        || limits.max_tree_bytes == 0
        || limits.max_tag_bytes == 0
        || limits.max_tag_depth == 0
        || limits.max_path_bytes == 0
        || limits.max_depth == 0
        || limits.max_entries == 0
        || limits.max_files == 0
        || limits.max_file_bytes == 0
        || limits.max_total_bytes == 0
        || limits.max_manifest_bytes == 0
        || limits.max_manifest_bytes > limits.max_file_bytes
        || limits.max_odb_object_bytes < limits.max_file_bytes
        || limits.max_odb_object_bytes < limits.max_tree_bytes
        || limits.max_odb_object_bytes < limits.max_commit_bytes
        || limits.max_odb_object_bytes < limits.max_tag_bytes
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
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Instant;
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

    fn tree_manifest(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let entries = entries
            .iter()
            .map(|(path, bytes)| {
                serde_json::json!({
                    "path": path,
                    "size": bytes.len().to_string(),
                    "sha256": sha256_hex(bytes),
                    "mode": "file",
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_vec(&serde_json::json!({
            "schema": "baas.runtime-repository.tree-manifest/v1",
            "entries": entries,
        }))
        .unwrap()
    }

    fn empty_manifest() -> Vec<u8> {
        tree_manifest(&[])
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

    fn annotated_tag(root: &Path, name: &str, commit: &str) {
        let repository = Repository::open_bare(root).unwrap();
        let target = repository
            .find_object(Oid::from_str(commit).unwrap(), Some(ObjectType::Commit))
            .unwrap();
        let signature = Signature::now("BAAS test", "baas@example.invalid").unwrap();
        repository
            .tag(name, &target, &signature, "annotated fixture", false)
            .unwrap();
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

    fn advertisement_pkt(payload: &[u8]) -> Vec<u8> {
        let mut result = format!("{:04x}", payload.len() + 4).into_bytes();
        result.extend_from_slice(payload);
        result
    }

    #[test]
    fn advertisement_has_independent_byte_and_ref_limits() {
        let mut advertisement = advertisement_pkt(b"# service=git-upload-pack\n");
        advertisement.extend_from_slice(b"0000");
        advertisement.extend_from_slice(&advertisement_pkt(
            format!("{} refs/heads/main\0capability\n", "a".repeat(40)).as_bytes(),
        ));
        advertisement.extend_from_slice(&advertisement_pkt(
            format!("{} refs/heads/other\n", "b".repeat(40)).as_bytes(),
        ));
        advertisement.extend_from_slice(b"0000");
        assert!(validate_advertisement_pkt_lines(&advertisement, 2).is_ok());
        assert!(validate_advertisement_pkt_lines(&advertisement, 1).is_err());

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = advertisement.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            socket.write_all(&body).unwrap();
        });
        let response = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap()
            .get(format!("http://{address}/info/refs"))
            .send()
            .unwrap();
        assert!(
            read_and_validate_advertisement(
                response,
                u64::try_from(advertisement.len() - 1).unwrap(),
                2,
                &RuntimeRepositoryStopToken::default(),
                Instant::now() + Duration::from_secs(1),
            )
            .is_err()
        );
        server.join().unwrap();
    }

    #[test]
    fn slow_advertisement_obeys_the_absolute_fetch_deadline() {
        let advertisement = advertisement_pkt(b"# service=git-upload-pack\n");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = advertisement.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .unwrap();
            for byte in body {
                thread::sleep(Duration::from_millis(20));
                if socket.write_all(&[byte]).is_err() {
                    break;
                }
                let _ = socket.flush();
            }
        });
        let response = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(100))
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap()
            .get(format!("http://{address}/info/refs"))
            .send()
            .unwrap();
        let error = read_and_validate_advertisement(
            response,
            u64::try_from(advertisement.len()).unwrap(),
            1,
            &RuntimeRepositoryStopToken::default(),
            Instant::now() + Duration::from_millis(55),
        )
        .unwrap_err();
        assert!(error.message().contains("fetch deadline exceeded"));
        server.join().unwrap();
    }

    #[test]
    fn blocking_read_timeout_resets_when_a_slow_response_keeps_progressing() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n")
                .unwrap();
            for byte in b"slow" {
                thread::sleep(Duration::from_millis(70));
                socket.write_all(std::slice::from_ref(byte)).unwrap();
                socket.flush().unwrap();
            }
        });
        let client = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(120))
            .timeout(Duration::from_millis(120))
            .build()
            .unwrap();
        let started = Instant::now();
        let mut response = client.get(format!("http://{address}/slow")).send().unwrap();
        let mut body = Vec::new();
        response.read_to_end(&mut body).unwrap();
        let elapsed = started.elapsed();
        server.join().unwrap();
        assert_eq!(body, b"slow");
        assert!(elapsed >= Duration::from_millis(250));
    }

    #[test]
    fn restricted_https_transport_has_bounded_stalls_and_cleans_its_context() {
        fn stalled_fetch(
            cancel: bool,
        ) -> (
            UpdaterResult<RuntimeRepositoryFetchMetadata>,
            Duration,
            bool,
        ) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                listener.set_nonblocking(true).unwrap();
                let deadline = Instant::now() + Duration::from_secs(2);
                while Instant::now() < deadline {
                    match listener.accept() {
                        Ok((_socket, _)) => {
                            thread::sleep(Duration::from_millis(700));
                            return true;
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("stalled fixture failed: {error}"),
                    }
                }
                false
            });
            let temp = TempDir::new().unwrap();
            let staging = temp.path().join("staging");
            fs::create_dir(&staging).unwrap();
            let limits = RuntimeRepositoryLimits {
                connect_timeout_ms: 150,
                read_timeout_ms: 150,
                ..Default::default()
            };
            let downloader = RuntimeRepositoryGit2Downloader::new(limits).unwrap();
            assert_eq!(
                downloader.network_stop_response_bound(),
                Duration::from_millis(150)
            );
            let stop = RuntimeRepositoryStopToken::default();
            let cancellation = cancel.then(|| {
                let stop = stop.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(40));
                    stop.cancel();
                })
            });
            let request = RuntimeRepositoryFetchRequest {
                id: RuntimeRepositoryId::Resources,
                url: format!("https://{address}/repo.git"),
                advertised_reference: "refs/heads/main".into(),
                exact_commit: "a".repeat(40),
                manifest: "manifest.json".into(),
            };
            let started = Instant::now();
            let result = downloader.download(&request, &staging, &stop);
            let elapsed = started.elapsed();
            if let Some(cancellation) = cancellation {
                cancellation.join().unwrap();
            }
            (result, elapsed, server.join().unwrap())
        }

        let (timed_out, elapsed, connected) = stalled_fetch(false);
        assert!(timed_out.is_err());
        assert!(connected, "timeout case never connected to fixture");
        assert!(elapsed < Duration::from_secs(1));
        let (cancelled, elapsed, _) = stalled_fetch(true);
        assert_eq!(cancelled, Err(UpdaterError::Cancelled));
        assert!(elapsed < Duration::from_secs(1));
        assert!(restricted_https_contexts().lock().unwrap().is_empty());
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
        let payload = b"payload";
        let manifest = tree_manifest(&[("nested/payload.bin", payload)]);
        let (temp, metadata) = download_fixture(
            tree([
                ("manifest.json", blob(&manifest)),
                ("nested", tree([("payload.bin", blob(payload))])),
            ]),
            "manifest.json",
        );
        let staging = temp.path().join("staging");
        assert_eq!(metadata.manifest_sha256, sha256_hex(&manifest));
        assert!(staging.join("nested/payload.bin").is_file());
        assert!(!staging.join(".git").exists());
        assert!(!staging.join(".t").exists());
    }

    #[test]
    fn annotated_tag_peels_to_the_pinned_commit_with_bounded_metadata() {
        let temp = TempDir::new().unwrap();
        let remote = temp.path().join("remote.git");
        let commit = commit_repo(
            &remote,
            "refs/heads/main",
            &tree([("manifest.json", blob(empty_manifest()))]),
        );
        annotated_tag(&remote, "runtime-v1", &commit);
        let mut tagged = request(
            RuntimeRepositoryId::Resources,
            &remote,
            &commit,
            "manifest.json",
        );
        tagged.advertised_reference = "refs/tags/runtime-v1".into();
        let staging = temp.path().join("staging");
        fs::create_dir(&staging).unwrap();
        RuntimeRepositoryGit2Downloader::for_local_tests(Default::default())
            .download(&tagged, &staging, &Default::default())
            .unwrap();

        let repository = Repository::open_bare(&remote).unwrap();
        let tag_oid = repository.refname_to_id("refs/tags/runtime-v1").unwrap();
        let tiny_tag = RuntimeRepositoryLimits {
            max_tag_bytes: 1,
            ..Default::default()
        };
        assert_eq!(
            peel_bounded_commit(&repository, tag_oid, tiny_tag).err(),
            Some(limit_error("runtime repository tag size limit exceeded"))
        );
        let commit_oid = Oid::from_str(&commit).unwrap();
        let tiny_commit = RuntimeRepositoryLimits {
            max_commit_bytes: 1,
            ..Default::default()
        };
        assert_eq!(
            peel_bounded_commit(&repository, commit_oid, tiny_commit).err(),
            Some(limit_error("runtime repository commit size limit exceeded"))
        );
        let tree_oid = repository.find_commit(commit_oid).unwrap().tree_id();
        assert_eq!(
            find_bounded_tree(&repository, tree_oid, 1).err(),
            Some(limit_error("runtime repository tree size limit exceeded"))
        );
    }

    #[test]
    fn rejects_mismatch_symlink_submodule_and_unsafe_paths() {
        for unsafe_segment in [
            "",
            ".",
            "..",
            "dir\\file",
            "C:drive",
            "CON.txt",
            "COM¹.txt",
            "LPT³",
            "tail. ",
        ] {
            assert!(validate_path_segment(unsafe_segment).is_err());
        }
        let fixtures = [
            tree([
                ("manifest.json", blob(empty_manifest())),
                ("link", Node::Blob(b"target".to_vec(), 0o120000)),
            ]),
            tree([
                ("manifest.json", blob(empty_manifest())),
                ("run.exe", Node::Blob(b"binary".to_vec(), 0o100755)),
            ]),
            tree([
                ("manifest.json", blob(empty_manifest())),
                (
                    "module",
                    Node::Gitlink(Oid::from_str(&"b".repeat(40)).unwrap()),
                ),
            ]),
            tree([
                ("manifest.json", blob(empty_manifest())),
                ("CON.txt", blob(b"bad")),
            ]),
            tree([
                ("manifest.json", blob(empty_manifest())),
                ("dir\\file", blob(b"bad")),
            ]),
            tree([
                ("manifest.json", blob(empty_manifest())),
                ("C:drive", blob(b"bad")),
            ]),
            tree([("manifest.json", tree([("nested", blob(b"bad"))]))]),
            tree([
                ("manifest.json", blob(empty_manifest())),
                ("trailing.", blob(b"bad")),
            ]),
            tree([
                ("manifest.json", blob(empty_manifest())),
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
            &tree([("manifest.json", blob(empty_manifest()))]),
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
            &tree([("manifest.json", blob(empty_manifest()))]),
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
            &tree([("manifest.json", blob(empty_manifest()))]),
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
    fn fetch_byte_and_object_budgets_fail_closed() {
        let temp = TempDir::new().unwrap();
        let remote = temp.path().join("remote.git");
        let payload = vec![b'x'; 128 * 1024];
        let manifest = tree_manifest(&[("payload.bin", payload.as_slice())]);
        let commit = commit_repo(
            &remote,
            "refs/heads/main",
            &tree([
                ("manifest.json", blob(&manifest)),
                ("payload.bin", blob(&payload)),
            ]),
        );
        let request = request(
            RuntimeRepositoryId::Resources,
            &remote,
            &commit,
            "manifest.json",
        );
        for limits in [
            RuntimeRepositoryLimits {
                max_fetch_bytes: 1,
                ..Default::default()
            },
            RuntimeRepositoryLimits {
                max_fetch_objects: 1,
                ..Default::default()
            },
        ] {
            let store = RuntimeRepositoryStore::open(
                temp.path()
                    .join(format!("install-{}", limits.max_fetch_objects)),
            )
            .unwrap();
            assert_eq!(
                store.download_candidate(
                    &RuntimeRepositoryGit2Downloader::for_local_tests(limits),
                    &request,
                ),
                Err(limit_error("runtime repository fetch limit exceeded"))
            );
            assert_eq!(
                fs::read_dir(store.root().join("staging")).unwrap().count(),
                0
            );
        }
    }

    #[test]
    fn fetched_odb_rejects_large_uncompressed_objects_before_materialization() {
        let temp = TempDir::new().unwrap();
        let remote = temp.path().join("remote.git");
        let payload = vec![0_u8; 256 * 1024];
        let manifest = tree_manifest(&[("payload.bin", payload.as_slice())]);
        let commit = commit_repo(
            &remote,
            "refs/heads/main",
            &tree([
                ("manifest.json", blob(&manifest)),
                ("payload.bin", blob(&payload)),
            ]),
        );
        let limits = RuntimeRepositoryLimits {
            max_odb_object_bytes: 64 * 1024,
            max_odb_total_bytes: 1024 * 1024,
            max_commit_bytes: 64 * 1024,
            max_tree_bytes: 64 * 1024,
            max_tag_bytes: 64 * 1024,
            max_file_bytes: 64 * 1024,
            max_manifest_bytes: 64 * 1024,
            ..Default::default()
        };
        let store = RuntimeRepositoryStore::open(temp.path().join("install")).unwrap();
        let result = store.download_candidate(
            &RuntimeRepositoryGit2Downloader::for_local_tests(limits),
            &request(
                RuntimeRepositoryId::Resources,
                &remote,
                &commit,
                "manifest.json",
            ),
        );
        assert_eq!(
            result,
            Err(limit_error("runtime repository object size limit exceeded"))
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
                    ("manifest.json", blob(empty_manifest())),
                    ("one", tree([("two", tree([("value", blob(b"x"))]))])),
                ]),
                RuntimeRepositoryLimits {
                    max_depth: 1,
                    ..Default::default()
                },
            ),
            (
                tree([
                    ("manifest.json", blob(empty_manifest())),
                    ("extra", blob(b"x")),
                ]),
                RuntimeRepositoryLimits {
                    max_entries: 1,
                    ..Default::default()
                },
            ),
            (
                tree([
                    ("manifest.json", blob(empty_manifest())),
                    ("extra", blob(b"x")),
                ]),
                RuntimeRepositoryLimits {
                    max_files: 1,
                    ..Default::default()
                },
            ),
            (
                tree([
                    ("manifest.json", blob(empty_manifest())),
                    ("extra", blob(b"456")),
                ]),
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
            &tree([("resources.json", blob(empty_manifest()))]),
        );
        let scripts_commit = commit_repo(
            &scripts_repo,
            "refs/heads/main",
            &tree([("scripts.json", blob(empty_manifest()))]),
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
        let old_resources_commit = commit_repo(
            &resources_repo,
            "refs/heads/main",
            &tree([("resources.json", blob(empty_manifest()))]),
        );
        let old_scripts_commit = commit_repo(
            &scripts_repo,
            "refs/heads/main",
            &tree([("scripts.json", blob(empty_manifest()))]),
        );
        let old_resources = request(
            RuntimeRepositoryId::Resources,
            &resources_repo,
            &old_resources_commit,
            "resources.json",
        );
        let old_scripts = request(
            RuntimeRepositoryId::Scripts,
            &scripts_repo,
            &old_scripts_commit,
            "scripts.json",
        );
        let store = RuntimeRepositoryStore::open(temp.path().join("i")).unwrap();
        let seed = RuntimeRepositoryUpdater::new(
            store.clone(),
            RuntimeRepositoryGit2Downloader::for_local_tests(Default::default()),
        );
        let existing = seed
            .update_from_requests(&old_resources, &old_scripts, None, &Default::default())
            .unwrap();
        let resources_commit = move_reference(
            &resources_repo,
            "refs/heads/main",
            &tree([("resources.json", blob(empty_manifest()))]),
        );
        let scripts_commit = move_reference(
            &scripts_repo,
            "refs/heads/main",
            &tree([("scripts.json", blob(empty_manifest()))]),
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
        let updater = RuntimeRepositoryUpdater::new(
            store.clone(),
            CancelAfterSecondDownload {
                inner: RuntimeRepositoryGit2Downloader::for_local_tests(Default::default()),
                completed: AtomicUsize::new(0),
            },
        );
        let stop = RuntimeRepositoryStopToken::default();
        assert_eq!(
            updater.update_from_requests(
                &resources,
                &scripts,
                Some(&existing.pointer.generation),
                &stop,
            ),
            Err(UpdaterError::Cancelled)
        );
        assert_eq!(store.read_current().unwrap(), Some(existing));
        assert_eq!(
            fs::read_dir(store.root().join("staging")).unwrap().count(),
            0
        );
    }
}
