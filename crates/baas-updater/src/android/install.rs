//! First installation of the Android service repository into caller-owned staging.
//!
//! Probes use libgit2's real fetch protocol and bounded pack samples. They never
//! download ZIPs or invoke a system Git executable. Python owns final publication,
//! compatibility patches, configuration preservation, and OCR setup.

use super::{android_remote_callbacks, configure_android_git2_ssl, head_sha};
use crate::{OutputSink, OutputStyle, RepositoryKind, UpdateChannel, UpdaterError, UpdaterResult};
use git2::{
    AutotagOption, Direction, FetchOptions, Repository,
    build::{CheckoutBuilder, RepoBuilder},
};
use serde::Serialize;
use std::{
    cmp::Ordering as CmpOrdering,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Resource budgets for Android's first Main-repository installation.
#[derive(Debug, Clone)]
pub struct AndroidMainInstallOptions {
    /// Defaults to the channel's configured repository mirrors.
    pub source_urls: Option<Vec<String>>,
    /// Trusted source whose master commit every mirror must match. Defaults to
    /// the channel's official GitHub repository, independently of source_urls.
    pub canonical_source_url: Option<String>,
    /// Optional commit resolved by the caller from an authenticated official
    /// GitHub endpoint. Never populate this from a mirror's own advertisement.
    /// When absent, the canonical GitHub Git refs supply the trusted commit.
    pub expected_sha: Option<String>,
    /// Stop each pack sample after this many received bytes (default 1 MiB).
    pub probe_sample_bytes: usize,
    /// Time budget for each pack sample (default 3 seconds).
    pub probe_sample_timeout: Duration,
    /// Shared concurrent probe budget (default 10 seconds).
    /// An in-flight blocking network read may take up to libgit2's 20s timeout;
    /// workers are cancelled and joined before installing, never detached.
    pub probe_timeout: Duration,
    /// Maximum time for an individual clone/fetch attempt.
    pub source_timeout: Duration,
    /// Overall budget, including probes and all source attempts.
    pub total_timeout: Duration,
    /// Emits a heartbeat even while the remote sends no progress.
    pub heartbeat_interval: Duration,
}

impl Default for AndroidMainInstallOptions {
    fn default() -> Self {
        Self {
            source_urls: None,
            canonical_source_url: None,
            expected_sha: None,
            probe_sample_bytes: 1_048_576,
            probe_sample_timeout: Duration::from_secs(3),
            probe_timeout: Duration::from_secs(10),
            source_timeout: Duration::from_secs(180),
            total_timeout: Duration::from_secs(300),
            heartbeat_interval: Duration::from_secs(2),
        }
    }
}

/// Verified staged repository. The caller must still patch and publish it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidMainInstallReport {
    pub sha: String,
    pub source_url: String,
}

#[derive(Debug, Clone)]
struct ProbeResult {
    url: String,
    master_sha: Option<String>,
    latency: Duration,
    bytes: usize,
    sample_elapsed: Duration,
    elapsed: Duration,
    valid: bool,
    note: String,
}

impl ProbeResult {
    fn bytes_per_second(&self) -> Option<f64> {
        (self.bytes > 0).then(|| self.bytes as f64 / self.sample_elapsed.as_secs_f64().max(0.001))
    }
}

#[derive(Clone)]
struct Control {
    cancelled: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    deadline: Instant,
}

impl Control {
    fn active(&self) -> bool {
        !self.cancelled.load(Ordering::Relaxed)
            && !self.stop.load(Ordering::Relaxed)
            && Instant::now() < self.deadline
    }

    fn check(&self) -> UpdaterResult<()> {
        if self.cancelled.load(Ordering::Relaxed) || self.stop.load(Ordering::Relaxed) {
            Err(UpdaterError::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(UpdaterError::Network(
                "Android git2 operation timed out".into(),
            ))
        } else {
            Ok(())
        }
    }
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Installs only the Main repository into a dedicated, disposable staging directory.
///
/// `target_dir` is fully owned by this call and must not be the active backend
/// root. No setup.toml, current SHA, configuration, or Cpp/OCR state is updated.
/// Success requires a checked-out commit with main.service.py and service/.
pub fn install_android_main_repository(
    target_dir: &Path,
    channel: UpdateChannel,
    cancelled: Arc<AtomicBool>,
    output: Arc<dyn OutputSink>,
    options: AndroidMainInstallOptions,
) -> UpdaterResult<AndroidMainInstallReport> {
    let started = Instant::now();
    let total_deadline = started + options.total_timeout;
    let control = Control {
        cancelled,
        stop: Arc::new(AtomicBool::new(false)),
        deadline: total_deadline,
    };
    control.check()?;
    if channel != UpdateChannel::Dev {
        return Err(UpdaterError::Config(
            "Stable lacks the Android service backend; choose Development (Dev)".into(),
        ));
    }
    if options.probe_sample_bytes == 0 || options.heartbeat_interval.is_zero() {
        return Err(UpdaterError::Config(
            "git2 sample size and heartbeat interval must be positive".into(),
        ));
    }
    configure_android_git2_ssl(output.as_ref())?;
    let parent = target_dir
        .parent()
        .ok_or_else(|| UpdaterError::Config("staging directory needs a parent".into()))?;
    fs::create_dir_all(parent)?;
    let scratch = Scratch(parent.join(format!(".android-git2-probe-{}", Uuid::new_v4())));
    fs::create_dir_all(&scratch.0)?;
    let official_urls = crate::repo::repository_urls(RepositoryKind::Main, channel);
    let canonical_url = options
        .canonical_source_url
        .clone()
        .unwrap_or_else(|| official_urls[0].clone());
    let mut urls = options.source_urls.clone().unwrap_or(official_urls);
    if urls.is_empty() {
        return Err(UpdaterError::Config(
            "Android git2 has no repository sources".into(),
        ));
    }
    let supplied_expected = options
        .expected_sha
        .as_deref()
        .map(|sha| {
            if sha.len() != 40 || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(UpdaterError::Config(
                    "Trusted expected_sha must be a 40-character Git commit ID".into(),
                ));
            }
            Ok(sha.to_ascii_lowercase())
        })
        .transpose()?;
    if supplied_expected.is_none() && !urls.contains(&canonical_url) {
        urls.push(canonical_url.clone());
    }
    if let Some(sha) = &supplied_expected {
        output.line(OutputStyle::Info, &format!("[probe] trusted caller supplied official master SHA={sha}; mirrors must match before speed ranking"));
    } else {
        output.line(OutputStyle::Info, &format!("[probe] trusted master source={canonical_url}; mirrors must advertise the same commit before speed ranking"));
    }
    output.line(OutputStyle::Info, &format!("[probe] testing {} Git sources concurrently; sample limit={} bytes/{}s; shared budget={}s (blocking network reads bounded separately)", urls.len(), options.probe_sample_bytes, options.probe_sample_timeout.as_secs_f64(), options.probe_timeout.as_secs_f64()));
    let mut ranked = probe_sources(&scratch.0, urls, &control, &output, &options);
    control.check()?;
    let expected_sha = supplied_expected.or_else(|| ranked.iter()
        .find(|result| result.url == canonical_url && result.valid)
        .and_then(|result| result.master_sha.clone()))
        .ok_or_else(|| UpdaterError::Network(format!(
            "Could not verify the trusted GitHub master commit from {canonical_url}; refusing to install an unverified mirror version. Check the network and retry."
        )))?;
    output.line(OutputStyle::Info, &format!("[probe] required master SHA={expected_sha}; only matching mirrors can enter speed ranking"));
    ranked.retain(|result| {
        if !result.valid { return false; }
        if result.master_sha.as_deref() != Some(expected_sha.as_str()) {
            output.line(OutputStyle::Warning, &format!("[probe] excluded mismatched mirror source={} master={} expected={expected_sha}; speed cannot override repository version", result.url, result.master_sha.as_deref().unwrap_or("unverified")));
            return false;
        }
        true
    });
    ranked.sort_by(compare_probes);
    if ranked.is_empty() {
        return Err(UpdaterError::Network(format!(
            "No Git source matches the trusted master commit {expected_sha}; reachable mirrors were mismatched or invalid. See [probe] diagnostics and retry."
        )));
    }
    for (index, source) in ranked.iter().enumerate() {
        output.line(
            OutputStyle::Info,
            &format!(
                "[probe] rank={} source={} rate={} latency={}ms",
                index + 1,
                source.url,
                rate_label(source.bytes_per_second()),
                source.latency.as_millis()
            ),
        );
    }
    let mut errors = Vec::new();
    for source in ranked {
        control.check()?;
        let attempt = Scratch(parent.join(format!(".android-git2-clone-{}", Uuid::new_v4())));
        let source_control = Control {
            deadline: total_deadline.min(Instant::now() + options.source_timeout),
            ..control.clone()
        };
        output.line(
            OutputStyle::Info,
            &format!(
                "[git2 transfer] selecting {}; depth=1 branch=master timeout={}s",
                source.url,
                source_control
                    .deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs()
            ),
        );
        let result = clone_with_progress(
            &source.url,
            &attempt.0,
            &source_control,
            &output,
            options.heartbeat_interval,
        )
        .and_then(|sha| {
            source_control.check()?;
            if sha != expected_sha {
                return Err(UpdaterError::Git(format!(
                    "[verify] mirror HEAD changed or mismatched after probing: expected {expected_sha}, checked out {sha}; refusing to publish"
                )));
            }
            verify_staged_repository(&attempt.0, &sha, output.as_ref())?;
            control.check()?;
            if target_dir.exists() {
                fs::remove_dir_all(target_dir)?;
            }
            fs::rename(&attempt.0, target_dir)?;
            Ok(sha)
        });
        match result {
            Ok(sha) => {
                output.line(OutputStyle::Success, &format!("[verify] Main repository ready in staging at {sha}; source={}; elapsed={}s", source.url, started.elapsed().as_secs_f64()));
                return Ok(AndroidMainInstallReport {
                    sha,
                    source_url: source.url,
                });
            }
            Err(error) => {
                control.check()?;
                output.line(
                    OutputStyle::Warning,
                    &format!(
                        "[git2 transfer] source failed; trying next ranked source: {}: {}",
                        source.url,
                        error.message()
                    ),
                );
                errors.push(format!("{}: {}", source.url, error.message()));
            }
        }
    }
    Err(UpdaterError::Git(format!(
        "All measured Git sources failed: {}",
        errors.join("; ")
    )))
}

fn compare_probes(left: &ProbeResult, right: &ProbeResult) -> CmpOrdering {
    match (left.bytes_per_second(), right.bytes_per_second()) {
        (Some(left_rate), Some(right_rate)) => right_rate
            .total_cmp(&left_rate)
            .then_with(|| left.latency.cmp(&right.latency)),
        (Some(_), None) => CmpOrdering::Less,
        (None, Some(_)) => CmpOrdering::Greater,
        (None, None) => left.latency.cmp(&right.latency),
    }
}

fn rate_label(rate: Option<f64>) -> String {
    rate.map(|rate| format!("{:.1} KiB/s", rate / 1024.0))
        .unwrap_or_else(|| "not-throughput (refs latency only)".into())
}

fn probe_sources(
    scratch: &Path,
    urls: Vec<String>,
    control: &Control,
    output: &Arc<dyn OutputSink>,
    options: &AndroidMainInstallOptions,
) -> Vec<ProbeResult> {
    let started = Instant::now();
    let probe_control = Control {
        stop: Arc::new(AtomicBool::new(false)),
        deadline: control.deadline.min(started + options.probe_timeout),
        ..control.clone()
    };
    let (tx, rx) = mpsc::channel();
    thread::scope(|scope| {
        let mut workers = Vec::new();
        for (index, url) in urls.into_iter().enumerate() {
            let tx = tx.clone();
            let folder = scratch.join(index.to_string());
            let probe_control = probe_control.clone();
            let output = Arc::clone(output);
            workers.push(scope.spawn(move || {
                output.line(
                    OutputStyle::Info,
                    &format!(
                        "[probe] begin source={url}; validating Git refs and sampling pack transfer"
                    ),
                );
                let result = probe_source(&folder, url, &probe_control, &output, options);
                let _ = tx.send(result);
            }));
        }
        drop(tx);
        let mut results = Vec::new();
        loop {
            match rx.recv_timeout(options.heartbeat_interval) {
                Ok(result) => {
                    output.line(if result.valid { OutputStyle::Info } else { OutputStyle::Warning }, &format!("[probe] source={} valid={} master={} elapsed={}ms refs={}ms sample={} bytes/{}ms rate={} detail={}", result.url, result.valid, result.master_sha.as_deref().unwrap_or("unverified"), result.elapsed.as_millis(), result.latency.as_millis(), result.bytes, result.sample_elapsed.as_millis(), rate_label(result.bytes_per_second()), result.note));
                    results.push(result);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !probe_control.active() {
                        probe_control.stop.store(true, Ordering::Relaxed);
                    }
                    output.line(OutputStyle::Info, &format!("[probe] heartbeat elapsed={}s completed={}; {}", started.elapsed().as_secs(), results.len(), if probe_control.active() { "waiting for bounded Git samples" } else { "probe budget/cancellation reached; cancelling and joining in-flight libgit2 reads (server timeout up to 20s)" }));
                }
            }
        }
        for worker in workers {
            if worker.join().is_err() {
                output.line(
                    OutputStyle::Warning,
                    "[probe] worker panicked; source excluded",
                );
            }
        }
        results
    })
}

fn probe_source(
    folder: &Path,
    url: String,
    control: &Control,
    output: &Arc<dyn OutputSink>,
    options: &AndroidMainInstallOptions,
) -> ProbeResult {
    let started = Instant::now();
    let mut result = ProbeResult {
        url,
        master_sha: None,
        latency: Duration::ZERO,
        bytes: 0,
        sample_elapsed: Duration::ZERO,
        elapsed: Duration::ZERO,
        valid: false,
        note: String::new(),
    };
    let run = (|| -> UpdaterResult<()> {
        control.check()?;
        let repo = Repository::init_bare(folder)?;
        let mut remote = repo.remote_anonymous(&result.url)?;
        {
            let connection = remote.connect_auth(
                Direction::Fetch,
                Some(android_remote_callbacks(output.as_ref())),
                None,
            )?;
            let master = connection
                .list()?
                .iter()
                .find(|head| head.name() == "refs/heads/master")
                .ok_or_else(|| {
                    UpdaterError::Git("master branch absent from Git advertisement".into())
                })?;
            result.master_sha = Some(master.oid().to_string());
        }
        result.valid = true;
        result.latency = started.elapsed();
        control.check()?;
        let sampled = Instant::now();
        let sample_deadline = control.deadline.min(sampled + options.probe_sample_timeout);
        let mut callbacks = android_remote_callbacks(output.as_ref());
        let bytes = Arc::new(AtomicU64::new(0));
        let received_bytes = Arc::clone(&bytes);
        callbacks.transfer_progress(move |stats| {
            received_bytes.store(stats.received_bytes() as u64, Ordering::Relaxed);
            control.active()
                && Instant::now() < sample_deadline
                && stats.received_bytes() < options.probe_sample_bytes
        });
        callbacks.sideband_progress(move |_| control.active() && Instant::now() < sample_deadline);
        let mut fetch = FetchOptions::new();
        fetch
            .remote_callbacks(callbacks)
            .download_tags(AutotagOption::None);
        if result.url.starts_with("http://") || result.url.starts_with("https://") {
            fetch.depth(1);
        }
        let sampled_result = remote.download(&["refs/heads/master"], Some(&mut fetch));
        let _ = remote.disconnect();
        result.bytes = bytes.load(Ordering::Relaxed) as usize;
        result.sample_elapsed = sampled.elapsed();
        result.note = match sampled_result {
            Ok(()) => "complete valid pack sample".into(),
            Err(error) if result.bytes > 0 => format!("bounded partial pack sample: {error}"),
            Err(error) => format!("Git refs validated; no throughput sample: {error}"),
        };
        Ok(())
    })();
    if let Err(error) = run {
        result.note = error.message();
    }
    result.elapsed = started.elapsed();
    result
}

fn clone_with_progress(
    url: &str,
    target: &Path,
    control: &Control,
    output: &Arc<dyn OutputSink>,
    heartbeat_interval: Duration,
) -> UpdaterResult<String> {
    control.check()?;
    let started = Instant::now();
    let bytes = Arc::new(AtomicU64::new(0));
    let objects = Arc::new(AtomicU64::new(0));
    let phase = Arc::new(Mutex::new("connecting / negotiating Git pack"));
    let (stop_tx, stop_rx) = mpsc::channel();
    thread::scope(|scope| {
        let heartbeat_bytes = Arc::clone(&bytes);
        let heartbeat_objects = Arc::clone(&objects);
        let heartbeat_phase = Arc::clone(&phase);
        let heartbeat = scope.spawn(move || {
            while matches!(stop_rx.recv_timeout(heartbeat_interval), Err(mpsc::RecvTimeoutError::Timeout)) {
                let phase = *heartbeat_phase.lock().unwrap_or_else(|error| error.into_inner());
                let bytes = heartbeat_bytes.load(Ordering::Relaxed);
                output.line(OutputStyle::Info, &format!("[git2 transfer] heartbeat elapsed={}s source={} phase={} objects={} bytes={} average={:.1} KiB/s status={}", started.elapsed().as_secs(), url, phase, heartbeat_objects.load(Ordering::Relaxed), bytes, bytes as f64 / 1024.0 / started.elapsed().as_secs_f64().max(0.001), if control.active() { "working; waiting for next Git callback" } else { "cancelling; waiting for bounded network read" }));
            }
        });
        let result = (|| -> UpdaterResult<String> {
            let mut callbacks = android_remote_callbacks(output.as_ref());
            let mut last_log = Instant::now() - Duration::from_secs(1);
            let mut completion_logged = false;
            let transfer_phase = Arc::clone(&phase);
            let transfer_bytes = Arc::clone(&bytes);
            let transfer_objects = Arc::clone(&objects);
            callbacks.transfer_progress(move |stats| {
                transfer_bytes.store(stats.received_bytes() as u64, Ordering::Relaxed);
                transfer_objects.store(stats.received_objects() as u64, Ordering::Relaxed);
                *transfer_phase.lock().unwrap_or_else(|error| error.into_inner()) = "receiving / indexing Git objects";
                let complete = stats.total_objects() > 0
                    && stats.indexed_objects() == stats.total_objects()
                    && stats.indexed_deltas() == stats.total_deltas();
                if last_log.elapsed() >= Duration::from_millis(500) || (complete && !completion_logged) {
                    let percent = stats.received_objects().saturating_mul(100) / stats.total_objects().max(1);
                    output.line(OutputStyle::Info, &format!("[git2 transfer] objects={}/{} indexed={} deltas={}/{} bytes={} rate={:.1} KiB/s progress={} elapsed={}s", stats.received_objects(), stats.total_objects(), stats.indexed_objects(), stats.indexed_deltas(), stats.total_deltas(), stats.received_bytes(), stats.received_bytes() as f64 / 1024.0 / started.elapsed().as_secs_f64().max(0.001), percent, started.elapsed().as_secs_f64()));
                    last_log = Instant::now();
                    completion_logged |= complete;
                }
                control.active()
            });
            callbacks.sideband_progress(|message| {
                if !control.active() {
                    return false;
                }
                let message = String::from_utf8_lossy(message);
                if !message.trim().is_empty() {
                    output.line(
                        OutputStyle::Muted,
                        &format!("[git2 transfer] remote: {}", message.trim()),
                    );
                }
                true
            });
            let mut fetch = FetchOptions::new();
            fetch
                .remote_callbacks(callbacks)
                .download_tags(AutotagOption::None);
            if url.starts_with("http://") || url.starts_with("https://") {
                fetch.depth(1);
            }
            let mut checkout = CheckoutBuilder::new();
            let mut last_checkout = Instant::now() - Duration::from_secs(1);
            checkout.progress(|path, completed, total| {
                *phase.lock().unwrap_or_else(|error| error.into_inner()) =
                    "checking out repository files";
                if last_checkout.elapsed() >= Duration::from_millis(500) || completed == total {
                    output.line(
                        OutputStyle::Info,
                        &format!(
                            "[checkout] files={completed}/{total} progress={}% path={}",
                            completed.saturating_mul(100) / total.max(1),
                            path.map(|path| path.to_string_lossy().into_owned())
                                .unwrap_or_default()
                        ),
                    );
                    last_checkout = Instant::now();
                }
            });
            checkout
                .notify_on(git2::CheckoutNotificationType::all())
                .notify(|_, _, _, _, _| control.active());
            let repo = RepoBuilder::new()
                .branch("master")
                .fetch_options(fetch)
                .with_checkout(checkout)
                .clone(url, target)?;
            control.check()?;
            output.line(
                OutputStyle::Success,
                &format!(
                    "[git2 transfer] complete objects={} bytes={} average={:.1} KiB/s elapsed={}s",
                    objects.load(Ordering::Relaxed),
                    bytes.load(Ordering::Relaxed),
                    bytes.load(Ordering::Relaxed) as f64
                        / 1024.0
                        / started.elapsed().as_secs_f64().max(0.001),
                    started.elapsed().as_secs_f64()
                ),
            );
            head_sha(&repo)
        })();
        let _ = stop_tx.send(());
        let _ = heartbeat.join();
        control.check()?;
        result
    })
}

fn verify_staged_repository(
    target: &Path,
    sha: &str,
    output: &dyn OutputSink,
) -> UpdaterResult<()> {
    output.line(
        OutputStyle::Info,
        "[verify] checking Git HEAD and required Android service files",
    );
    let repo = Repository::open(target)?;
    if head_sha(&repo)? != sha
        || !target.join("main.service.py").is_file()
        || !target.join("service").is_dir()
    {
        return Err(UpdaterError::Git("Git repository does not contain the Android service backend (main.service.py and service/ required)".into()));
    }
    let tree = repo.head()?.peel_to_tree()?;
    let service = tree.get_path(Path::new("main.service.py"))?;
    if service.kind() != Some(git2::ObjectType::Blob) || service.filemode() == 0o120000 {
        return Err(UpdaterError::Git(
            "Android service entry must be a regular tracked file".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::CollectOutput;
    use std::{
        collections::HashMap,
        io::{Read, Write},
        net::{Shutdown, TcpListener, TcpStream},
        process::{Command, Stdio},
    };

    struct GitHttpFixture {
        directory: tempfile::TempDir,
        address: String,
        stop: Arc<AtomicBool>,
        server: Option<thread::JoinHandle<()>>,
        sha: String,
        trace: Arc<Mutex<Vec<String>>>,
    }

    impl GitHttpFixture {
        fn new(with_service: bool) -> Self {
            Self::with_revision(with_service, "fixture")
        }

        fn with_revision(with_service: bool, revision: &str) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let source = directory.path().join("source");
            let mut init = git2::RepositoryInitOptions::new();
            init.initial_head("master");
            let repo = Repository::init_opts(&source, &init).unwrap();
            if with_service {
                fs::write(source.join("main.service.py"), "print('fixture service')\n").unwrap();
                fs::create_dir(source.join("service")).unwrap();
                fs::write(source.join("service/__init__.py"), "# service\n").unwrap();
            } else {
                fs::write(source.join("README.md"), "not an Android service\n").unwrap();
            }
            // Incompressible objects make this a real throughput sample instead
            // of merely a refs/ping timing test.
            let mut random = 0x123456789abcdef0_u64;
            for index in 0..64 {
                let mut data = vec![0_u8; 32 * 1024];
                for byte in &mut data {
                    random ^= random << 13;
                    random ^= random >> 7;
                    random ^= random << 17;
                    *byte = random as u8;
                }
                fs::write(source.join(format!("sample-{index}.bin")), data).unwrap();
            }
            let mut index = repo.index().unwrap();
            index
                .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
                .unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let signature = git2::Signature::now("fixture", "fixture@example.invalid").unwrap();
            let oid = repo
                .commit(Some("HEAD"), &signature, &signature, revision, &tree, &[])
                .unwrap();
            drop(tree);
            let bare = directory.path().join("repo.git");
            RepoBuilder::new()
                .bare(true)
                .clone(source.to_str().unwrap(), &bare)
                .unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = format!("http://{}", listener.local_addr().unwrap());
            let stop = Arc::new(AtomicBool::new(false));
            let server_stop = Arc::clone(&stop);
            let root = directory.path().to_path_buf();
            let posts = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
            let trace = Arc::new(Mutex::new(Vec::new()));
            let server_trace = Arc::clone(&trace);
            let server = thread::spawn(move || {
                let mut workers = Vec::new();
                while !server_stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let root = root.clone();
                            let posts = Arc::clone(&posts);
                            let trace = Arc::clone(&server_trace);
                            workers.push(thread::spawn(move || {
                                if let Err(error) = serve_git(stream, &root, &posts, &trace) {
                                    trace
                                        .lock()
                                        .unwrap()
                                        .push(format!("request failed: {error}"));
                                    if !matches!(
                                        error.kind(),
                                        std::io::ErrorKind::BrokenPipe
                                            | std::io::ErrorKind::ConnectionReset
                                    ) {
                                        eprintln!("Git HTTP fixture request failed: {error}");
                                    }
                                }
                            }));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(_) => break,
                    }
                }
                for worker in workers {
                    let _ = worker.join();
                }
            });
            Self {
                directory,
                address,
                stop,
                server: Some(server),
                sha: oid.to_string(),
                trace,
            }
        }

        fn url(&self, name: &str) -> String {
            format!("{}/{name}/repo.git", self.address)
        }
    }

    impl Drop for GitHttpFixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(server) = self.server.take() {
                server.join().unwrap();
            }
        }
    }

    fn read_http_line(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
        let mut line = Vec::new();
        let mut byte = [0_u8; 1];
        while !line.ends_with(b"\r\n") {
            reader.read_exact(&mut byte)?;
            line.push(byte[0]);
            if line.len() > 32 * 1024 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "fixture HTTP line exceeds 32 KiB",
                ));
            }
        }
        line.truncate(line.len() - 2);
        Ok(line)
    }

    fn read_chunked_body(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
        let mut body = Vec::new();
        loop {
            let line = read_http_line(reader)?;
            let size = std::str::from_utf8(line.split(|byte| *byte == b';').next().unwrap())
                .ok()
                .and_then(|value| usize::from_str_radix(value.trim(), 16).ok())
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "invalid fixture HTTP chunk",
                    )
                })?;
            if size == 0 {
                // Consume all trailers before closing the request socket. Leaving
                // these bytes unread can turn a complete response into a TCP reset.
                while !read_http_line(reader)?.is_empty() {}
                return Ok(body);
            }
            let end = body
                .len()
                .checked_add(size)
                .filter(|end| *end <= 16 * 1024 * 1024)
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "fixture HTTP body exceeds 16 MiB",
                    )
                })?;
            let start = body.len();
            body.resize(end, 0);
            reader.read_exact(&mut body[start..])?;
            let mut ending = [0_u8; 2];
            reader.read_exact(&mut ending)?;
            if ending != *b"\r\n" {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "fixture HTTP chunk is missing its trailing CRLF",
                ));
            }
        }
    }

    fn finish_http_response(stream: &mut TcpStream) -> std::io::Result<()> {
        stream.flush()?;
        // Finish the response before waiting for the client's FIN, consuming
        // any remaining input instead of dropping a socket with unread bytes.
        match stream.shutdown(Shutdown::Write) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotConnected | std::io::ErrorKind::ConnectionReset
                ) =>
            {
                return Ok(())
            }
            Err(error) => return Err(error),
        }
        let mut discard = [0_u8; 4096];
        loop {
            match stream.read(&mut discard) {
                Ok(0) => return Ok(()),
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::ConnectionReset
                    ) =>
                {
                    return Ok(())
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn serve_git(
        mut stream: TcpStream,
        root: &Path,
        posts: &Mutex<HashMap<String, usize>>,
        trace: &Mutex<Vec<String>>,
    ) -> std::io::Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_nodelay(true)?;
        let mut request = Vec::new();
        let mut byte = [0_u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte)?;
            request.push(byte[0]);
            if request.len() > 32 * 1024 {
                return Ok(());
            }
        }
        let headers = String::from_utf8_lossy(&request);
        let mut first = headers.lines().next().unwrap().split_whitespace();
        let method = first.next().unwrap();
        let path = first.next().unwrap();
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        let (kind, git_path) = path.trim_start_matches('/').split_once('/').unwrap();
        let header = |name: &str| {
            headers.lines().skip(1).find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case(name).then_some(value.trim())
            })
        };
        let content_type = header("content-type").unwrap_or("");
        trace.lock().unwrap().push(format!(
            "{method} {path}; length={:?} transfer={:?} expect={:?} connection={:?} content_type={content_type}",
            header("content-length"), header("transfer-encoding"), header("expect"), header("connection")
        ));
        if header("expect").is_some_and(|value| value.eq_ignore_ascii_case("100-continue")) {
            stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
        }
        // CGI needs decoded request bytes and their length even when the HTTP
        // client used chunked framing instead of a Content-Length header.
        let body = if header("transfer-encoding").is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("chunked"))
        }) {
            read_chunked_body(&mut stream)?
        } else {
            let length = header("content-length")
                .unwrap_or("0")
                .parse::<usize>()
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
            let mut body = vec![0; length];
            stream.read_exact(&mut body)?;
            body
        };
        if kind == "invalid" {
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 18\r\nConnection: close\r\n\r\n<html>error</html>\n")?;
            return finish_http_response(&mut stream);
        }
        if method == "GET" && kind != "slow" && kind != "broken" {
            thread::sleep(Duration::from_millis(35));
        }
        if method == "POST" {
            let mut counts = posts.lock().unwrap();
            let count = counts.entry(kind.to_string()).or_default();
            *count += 1;
            if kind == "broken" && *count > 2 {
                stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
                return finish_http_response(&mut stream);
            }
        }
        let mut command = Command::new("git");
        command
            .arg("http-backend")
            .env("GIT_PROJECT_ROOT", root)
            .env("GIT_HTTP_EXPORT_ALL", "1")
            .env("PATH_INFO", format!("/{git_path}"))
            .env("QUERY_STRING", query)
            .env("REQUEST_METHOD", method)
            .env("CONTENT_TYPE", content_type)
            .env("CONTENT_LENGTH", body.len().to_string())
            .env("REMOTE_ADDR", "127.0.0.1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut backend = command.spawn()?;
        backend.stdin.take().unwrap().write_all(&body)?;
        let result = backend.wait_with_output()?;
        if !result.status.success() {
            return Err(std::io::Error::other(format!(
                "git http-backend failed: {}",
                String::from_utf8_lossy(&result.stderr)
            )));
        }
        let split = result
            .stdout
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap();
        let cgi_headers = String::from_utf8_lossy(&result.stdout[..split]);
        let response_body = &result.stdout[split + 4..];
        trace.lock().unwrap().push(format!(
            "{method} {path}; decoded={} response={} CGI headers={}",
            body.len(),
            response_body.len(),
            cgi_headers.replace("\r\n", " | ")
        ));
        stream.write_all(format!("HTTP/1.1 200 OK\r\n{cgi_headers}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response_body.len()).as_bytes())?;
        if kind == "slow" && method == "POST" && response_body.len() > 128 * 1024 {
            for (index, chunk) in response_body.chunks(16 * 1024).enumerate() {
                // Throttle beyond the bounded 128 KiB probe, not all 2 MiB of
                // a clone: coarse Windows/macOS timers must not manufacture a
                // source timeout after throughput has already been measured.
                // The delay must exceed per-request CGI startup/compression
                // noise, otherwise concurrent jobs can make "slow" win.
                if index < 256 * 1024 / (16 * 1024) {
                    thread::sleep(Duration::from_millis(100));
                }
                stream.write_all(chunk)?;
            }
        } else {
            stream.write_all(response_body)?;
        }
        finish_http_response(&mut stream)
    }

    fn options(urls: Vec<String>) -> AndroidMainInstallOptions {
        AndroidMainInstallOptions {
            canonical_source_url: urls.iter().find(|url| !url.contains("/invalid/")).cloned(),
            expected_sha: None,
            source_urls: Some(urls),
            probe_sample_bytes: 128 * 1024,
            probe_sample_timeout: Duration::from_secs(3),
            probe_timeout: Duration::from_secs(10),
            source_timeout: Duration::from_secs(15),
            total_timeout: Duration::from_secs(45),
            heartbeat_interval: Duration::from_millis(50),
        }
    }

    #[test]
    fn git_http_fixture_serves_complete_packs_for_length_and_chunked_requests() {
        let fixture = GitHttpFixture::new(true);
        let want = format!("want {} side-band-64k ofs-delta\n", fixture.sha);
        let body = format!("{:04x}{want}00000009done\n", want.len() + 4);
        for chunked in [false, true] {
            let address = fixture.address.strip_prefix("http://").unwrap();
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream.set_nodelay(true).unwrap();
            let framing = if chunked {
                "tRaNsFeR-EnCoDiNg: cHuNkEd\r\nExPeCt: 100-continue\r\n".to_string()
            } else {
                format!("Content-Length: {}\r\n", body.len())
            };
            stream.write_all(format!(
                "POST /fast/repo.git/git-upload-pack HTTP/1.1\r\nHost: {address}\r\ncOnTeNt-TyPe: application/x-git-upload-pack-request\r\n{framing}Connection: close\r\n\r\n"
            ).as_bytes()).unwrap();
            if chunked {
                assert_eq!(
                    read_http_line(&mut stream).unwrap(),
                    b"HTTP/1.1 100 Continue"
                );
                assert!(read_http_line(&mut stream).unwrap().is_empty());
                let mut wire = Vec::new();
                for chunk in body.as_bytes().chunks(7) {
                    wire.extend_from_slice(
                        format!("{:x};fixture=true\r\n", chunk.len()).as_bytes(),
                    );
                    wire.extend_from_slice(chunk);
                    wire.extend_from_slice(b"\r\n");
                }
                wire.extend_from_slice(b"0\r\nFixture-Trailer: consumed\r\n\r\n");
                stream.write_all(&wire).unwrap();
            } else {
                stream.write_all(body.as_bytes()).unwrap();
            }
            let mut response = Vec::new();
            stream.read_to_end(&mut response).unwrap_or_else(|error| {
                panic!(
                    "chunked={chunked}: {error}; HTTP trace: {:?}",
                    fixture.trace.lock().unwrap()
                )
            });
            let end = response
                .windows(4)
                .position(|bytes| bytes == b"\r\n\r\n")
                .unwrap();
            let headers = String::from_utf8_lossy(&response[..end]);
            assert!(headers.starts_with("HTTP/1.1 200 OK"), "{headers}");
            assert!(
                headers.contains("application/x-git-upload-pack-result"),
                "{headers}"
            );
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let pack = &response[end + 4..];
            assert_eq!(pack.len(), length, "chunked={chunked}");
            assert!(
                pack.windows(4).any(|bytes| bytes == b"PACK"),
                "CGI did not receive a valid Git upload-pack request"
            );
        }
    }

    #[test]
    fn fast_valid_git_mirror_with_an_older_commit_is_excluded_before_ranking() {
        let canonical = GitHttpFixture::with_revision(true, "canonical current revision");
        let old_mirror = GitHttpFixture::with_revision(true, "stale mirror revision");
        assert_ne!(canonical.sha, old_mirror.sha);
        let target = canonical.directory.path().join("staging");
        let output = Arc::new(CollectOutput::default());
        let mut settings = options(vec![old_mirror.url("fast"), canonical.url("slow")]);
        settings.canonical_source_url = Some(canonical.url("slow"));
        let report = install_android_main_repository(
            &target,
            UpdateChannel::Dev,
            Arc::new(AtomicBool::new(false)),
            output.clone(),
            settings,
        )
        .unwrap();
        assert_eq!(report.sha, canonical.sha);
        assert_eq!(report.source_url, canonical.url("slow"));
        assert_eq!(
            head_sha(&Repository::open(&target).unwrap()).unwrap(),
            canonical.sha
        );
        let messages = output.lines.lock().unwrap();
        assert!(messages
            .iter()
            .any(|(_, line)| line.contains("excluded mismatched mirror")
                && line.contains(&old_mirror.sha)
                && line.contains(&canonical.sha)));
        assert!(!messages
            .iter()
            .any(|(_, line)| line.starts_with("[git2 transfer] selecting")
                && line.contains(&old_mirror.address)));
    }

    #[test]
    fn unavailable_canonical_version_does_not_silently_accept_a_valid_mirror() {
        let fixture = GitHttpFixture::new(true);
        let target = fixture.directory.path().join("staging");
        let mut settings = options(vec![fixture.url("fast")]);
        settings.canonical_source_url = Some(fixture.url("invalid"));
        let error = install_android_main_repository(
            &target,
            UpdateChannel::Dev,
            Arc::new(AtomicBool::new(false)),
            Arc::new(crate::NoopOutput),
            settings,
        )
        .unwrap_err();
        assert!(error
            .message()
            .contains("Could not verify the trusted GitHub master commit"));
        assert!(!target.exists());
    }

    #[test]
    fn official_api_commit_can_verify_a_mirror_when_canonical_git_refs_are_unavailable() {
        let fixture = GitHttpFixture::new(true);
        let target = fixture.directory.path().join("staging");
        let mut settings = options(vec![fixture.url("fast")]);
        settings.canonical_source_url = Some(fixture.url("invalid"));
        settings.expected_sha = Some(fixture.sha.clone());
        let report = install_android_main_repository(
            &target,
            UpdateChannel::Dev,
            Arc::new(AtomicBool::new(false)),
            Arc::new(crate::NoopOutput),
            settings,
        )
        .unwrap_or_else(|error| {
            panic!("{error:?}; HTTP trace: {:?}", fixture.trace.lock().unwrap())
        });
        assert_eq!(report.sha, fixture.sha);
    }

    struct ChangeHeadOnClone {
        inner: CollectOutput,
        bare: PathBuf,
        changed: AtomicBool,
    }

    impl OutputSink for ChangeHeadOnClone {
        fn line(&self, style: OutputStyle, message: &str) {
            self.inner.line(style, message);
            if message.starts_with("[git2 transfer] selecting")
                && !self.changed.swap(true, Ordering::Relaxed)
            {
                let repo = Repository::open_bare(&self.bare).unwrap();
                let previous = repo.head().unwrap().peel_to_commit().unwrap();
                let tree = previous.tree().unwrap();
                let signature = git2::Signature::now("fixture", "fixture@example.invalid").unwrap();
                repo.commit(
                    Some("refs/heads/master"),
                    &signature,
                    &signature,
                    "HEAD changed between probe and clone",
                    &tree,
                    &[&previous],
                )
                .unwrap();
            }
        }
    }

    #[test]
    fn ref_change_between_probe_and_clone_cannot_publish_an_unverified_commit() {
        let fixture = GitHttpFixture::new(true);
        let target = fixture.directory.path().join("staging");
        let output = Arc::new(ChangeHeadOnClone {
            inner: CollectOutput::default(),
            bare: fixture.directory.path().join("repo.git"),
            changed: AtomicBool::new(false),
        });
        let error = install_android_main_repository(
            &target,
            UpdateChannel::Dev,
            Arc::new(AtomicBool::new(false)),
            output.clone(),
            options(vec![fixture.url("fast")]),
        )
        .unwrap_err();
        assert!(output.changed.load(Ordering::Relaxed));
        assert!(
            error
                .message()
                .contains("mirror HEAD changed or mismatched after probing"),
            "{error:?}; HTTP trace: {:?}",
            fixture.trace.lock().unwrap()
        );
        assert!(error.message().contains(&fixture.sha));
        assert!(!target.exists());
    }

    #[test]
    fn smart_http_samples_rank_real_throughput_before_refs_latency_and_reject_html() {
        let fixture = GitHttpFixture::new(true);
        let parent = tempfile::tempdir().unwrap();
        fs::create_dir(parent.path().join("config")).unwrap();
        fs::write(parent.path().join("config/keep.json"), "user config").unwrap();
        let target = parent.path().join(".baas-next");
        let output = Arc::new(CollectOutput::default());
        let report = install_android_main_repository(
            &target,
            UpdateChannel::Dev,
            Arc::new(AtomicBool::new(false)),
            output.clone(),
            options(vec![
                fixture.url("invalid"),
                fixture.url("slow"),
                fixture.url("fast"),
            ]),
        )
        .unwrap();
        assert_eq!(
            report.source_url,
            fixture.url("fast"),
            "Git progress: {:?}; HTTP trace: {:?}",
            output.lines.lock().unwrap(),
            fixture.trace.lock().unwrap()
        );
        assert_eq!(report.sha, fixture.sha);
        assert_eq!(
            head_sha(&Repository::open(&target).unwrap()).unwrap(),
            fixture.sha
        );
        assert!(target.join("main.service.py").is_file());
        assert_eq!(
            fs::read_to_string(parent.path().join("config/keep.json")).unwrap(),
            "user config"
        );
        let messages = output.lines.lock().unwrap();
        assert!(messages
            .iter()
            .any(|(_, line)| line.contains("valid=false") && line.contains("invalid")));
        for phase in ["[probe]", "[git2 transfer]", "[checkout]", "[verify]"] {
            assert!(
                messages.iter().any(|(_, line)| line.contains(phase)),
                "missing {phase}"
            );
        }
    }

    #[test]
    fn clone_failure_tries_the_next_measured_source() {
        let fixture = GitHttpFixture::new(true);
        let target = fixture.directory.path().join("staging");
        let output = Arc::new(CollectOutput::default());
        let report = install_android_main_repository(
            &target,
            UpdateChannel::Dev,
            Arc::new(AtomicBool::new(false)),
            output.clone(),
            options(vec![fixture.url("broken"), fixture.url("slow")]),
        )
        .unwrap();
        assert_eq!(report.source_url, fixture.url("slow"));
        assert_eq!(report.sha, fixture.sha);
        let messages = output.lines.lock().unwrap();
        assert!(
            messages
                .iter()
                .any(|(_, line)| line.contains("source failed") && line.contains("broken")),
            "{messages:?}"
        );
    }

    #[test]
    fn incompatible_repository_never_publishes_a_partial_staging_directory() {
        let fixture = GitHttpFixture::new(false);
        let target = fixture.directory.path().join("staging");
        let error = install_android_main_repository(
            &target,
            UpdateChannel::Dev,
            Arc::new(AtomicBool::new(false)),
            Arc::new(crate::NoopOutput),
            options(vec![fixture.url("fast")]),
        )
        .unwrap_err();
        assert!(
            error.message().contains("main.service.py"),
            "{error:?}; HTTP trace: {:?}",
            fixture.trace.lock().unwrap()
        );
        assert!(!target.exists());
        assert!(!fs::read_dir(fixture.directory.path())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".android-git2-")));
    }

    #[test]
    fn cancellation_during_an_actual_transfer_joins_workers_and_cleans_staging() {
        let fixture = GitHttpFixture::new(true);
        let target = fixture.directory.path().join("staging");
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let canceller = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            worker_cancelled.store(true, Ordering::Relaxed);
        });
        let error = install_android_main_repository(
            &target,
            UpdateChannel::Dev,
            cancelled,
            Arc::new(crate::NoopOutput),
            options(vec![fixture.url("slow")]),
        )
        .unwrap_err();
        canceller.join().unwrap();
        assert_eq!(error, UpdaterError::Cancelled);
        assert!(!target.exists());
        assert!(!fs::read_dir(fixture.directory.path())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".android-git2-")));
    }
}
