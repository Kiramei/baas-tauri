//! Git repository synchronization and source ranking.

use crate::{
    GitBackend, OutputSink, OutputStyle, RepositoryKind, UpdateChannel, UpdateStatus, UpdaterError,
    UpdaterResult, constants,
};
use baas_term::threader::{ThreadLogStyle, ThreadProgressBar};
use git2::{FetchOptions, RemoteCallbacks, Repository, build::RepoBuilder};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const DEFAULT_BRANCH: &str = "master";

/// A ranked repository source URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedSource {
    /// Remote repository URL.
    pub url: String,
    /// Source order. `-1` means temporarily disabled.
    pub order: i32,
}

/// Source ranking file payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceRanking {
    /// Ranked sources.
    pub sources: Vec<RankedSource>,
    /// Completed failover cycles where every URL failed.
    pub all_failed_cycles: u8,
    /// Source whose real update/install operation last succeeded.
    #[serde(default)]
    pub preferred_url: Option<String>,
}

impl SourceRanking {
    /// Builds an initial ranking from an ordered URL list.
    pub fn from_urls(urls: &[String]) -> Self {
        Self {
            sources: urls
                .iter()
                .enumerate()
                .map(|(index, url)| RankedSource {
                    url: url.clone(),
                    order: index as i32,
                })
                .collect(),
            all_failed_cycles: 0,
            preferred_url: None,
        }
    }

    /// Returns true when the ranking contains exactly the expected URLs.
    pub fn matches_urls(&self, expected: &[String]) -> bool {
        let mut current = self
            .sources
            .iter()
            .map(|source| source.url.clone())
            .collect::<Vec<_>>();
        let mut expected = expected.to_vec();
        current.sort();
        expected.sort();
        current == expected
    }

    /// Returns active sources sorted by order.
    pub fn active_sources(&self) -> Vec<RankedSource> {
        let mut sources = self
            .sources
            .iter()
            .filter(|source| source.order >= 0)
            .cloned()
            .collect::<Vec<_>>();
        sources.sort_by_key(|source| source.order);
        sources
    }

    /// Marks one source as failed and compacts successful source order.
    pub fn demote_failed(&mut self, url: &str) {
        if self.preferred_url.as_deref() == Some(url) {
            self.preferred_url = None;
        }
        for source in &mut self.sources {
            if source.url == url {
                source.order = -1;
            }
        }
        self.compact_orders();
    }

    /// Compacts non-negative order values while preserving relative order.
    pub fn compact_orders(&mut self) {
        let mut active = self
            .sources
            .iter_mut()
            .filter(|source| source.order >= 0)
            .collect::<Vec<_>>();
        active.sort_by_key(|source| source.order);
        for (index, source) in active.into_iter().enumerate() {
            source.order = index as i32;
        }
    }

    /// Returns true when every source is disabled.
    pub fn all_disabled(&self) -> bool {
        self.sources.iter().all(|source| source.order < 0)
    }

    /// Promotes a successful source so it is tried first on the next run.
    pub fn promote_success(&mut self, url: &str) {
        let previous_order = self
            .sources
            .iter()
            .find(|source| source.url == url)
            .map(|source| source.order)
            .unwrap_or(-1);
        for source in &mut self.sources {
            if source.url == url {
                source.order = 0;
            } else if source.order >= 0 && source.order < previous_order {
                source.order += 1;
            }
        }
        self.compact_orders();
        self.all_failed_cycles = 0;
        self.preferred_url = Some(url.to_string());
    }

    /// Re-enables every source in stable configured order for a new cycle.
    pub fn reenable_all(&mut self) {
        self.preferred_url = None;
        for (index, source) in self.sources.iter_mut().enumerate() {
            source.order = index as i32;
        }
    }
}

const MAX_SOURCE_FAILURE_CYCLES: u8 = 3;

/// Persistent state machine for selecting and failing over download sources.
pub struct SourceSelector {
    ranking: SourceRanking,
    ranking_path: Option<PathBuf>,
    try_persisted_first: bool,
}

impl SourceSelector {
    /// Loads a persisted preferred source, or starts with an unranked source set.
    pub fn load(path: Option<&Path>, expected_urls: &[String]) -> UpdaterResult<Self> {
        let persisted = load_ranking(path, expected_urls)?;
        Ok(Self {
            ranking: persisted
                .clone()
                .unwrap_or_else(|| SourceRanking::from_urls(expected_urls)),
            ranking_path: path.map(Path::to_path_buf),
            try_persisted_first: persisted.is_some_and(|ranking| {
                ranking.preferred_url.as_ref().is_some_and(|preferred| {
                    ranking
                        .sources
                        .iter()
                        .any(|source| &source.url == preferred && source.order >= 0)
                })
            }),
        })
    }

    /// Selects the persisted winner or races all currently enabled sources.
    pub fn next_source<P: SourceProbe + Clone + 'static>(
        &mut self,
        probe_urls: &[(String, String)],
        probe: &P,
        output: &(impl OutputSink + ?Sized),
        label: &str,
    ) -> UpdaterResult<String> {
        loop {
            if self.ranking.all_disabled() {
                self.ranking.all_failed_cycles = self.ranking.all_failed_cycles.saturating_add(1);
                self.persist()?;
                if self.ranking.all_failed_cycles >= MAX_SOURCE_FAILURE_CYCLES {
                    return Err(UpdaterError::Network(format!(
                        "all {label} sources failed after {MAX_SOURCE_FAILURE_CYCLES} complete cycles"
                    )));
                }
                output.line(
                    OutputStyle::Warning,
                    &format!(
                        "All {label} sources failed; re-enabling every source for cycle {} of {MAX_SOURCE_FAILURE_CYCLES}",
                        self.ranking.all_failed_cycles + 1
                    ),
                );
                self.ranking.reenable_all();
                self.try_persisted_first = false;
                self.persist()?;
            }

            if self.try_persisted_first {
                self.try_persisted_first = false;
                if let Some(source) = self.ranking.sources.iter().find(|source| {
                    source.order >= 0
                        && self.ranking.preferred_url.as_deref() == Some(source.url.as_str())
                }) {
                    output.line(
                        OutputStyle::Info,
                        &format!("Trying persisted {label} source {}", source.url),
                    );
                    return Ok(source.url.clone());
                }
            }

            let active = self
                .ranking
                .active_sources()
                .into_iter()
                .filter_map(|source| {
                    probe_urls
                        .iter()
                        .find(|(url, _)| url == &source.url)
                        .cloned()
                })
                .collect::<Vec<_>>();
            if active.is_empty() {
                for source in self.ranking.active_sources() {
                    self.ranking.demote_failed(&source.url);
                }
                self.persist()?;
                continue;
            }
            let race = race_first_source_with_output(&active, probe, output);
            for url in race.failed {
                self.ranking.demote_failed(&url);
            }
            self.persist()?;
            if let Some(url) = race.winner {
                return Ok(url);
            }
        }
    }

    /// Disables a source whose real update/install operation failed.
    pub fn mark_failed(&mut self, url: &str) -> UpdaterResult<()> {
        self.ranking.demote_failed(url);
        self.try_persisted_first = false;
        self.persist()
    }

    /// Persists the successful source as the next run's preferred source.
    pub fn mark_succeeded(&mut self, url: &str) -> UpdaterResult<()> {
        self.ranking.promote_success(url);
        self.try_persisted_first = true;
        self.persist()
    }

    fn persist(&self) -> UpdaterResult<()> {
        if let Some(path) = &self.ranking_path {
            save_ranking(path, &self.ranking)?;
        }
        Ok(())
    }
}

struct SourceRace {
    winner: Option<String>,
    failed: Vec<String>,
}

/// Result of a repository synchronization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoSyncResult {
    /// Repository that was synchronized.
    pub kind: RepositoryKind,
    /// Operation outcome.
    pub status: UpdateStatus,
    /// URL that succeeded.
    pub source_url: String,
    /// Local HEAD SHA after synchronization.
    pub sha: String,
}

/// Options for repository synchronization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoSyncOptions {
    /// Repository kind.
    pub kind: RepositoryKind,
    /// Update channel.
    pub channel: UpdateChannel,
    /// Target directory for the working tree.
    pub target_dir: PathBuf,
    /// Optional JSON file used to persist source ranking.
    pub ranking_path: Option<PathBuf>,
    /// Git implementation used for synchronization.
    pub git_backend: GitBackend,
}

/// Measures whether source URLs are reachable and how long they take.
pub trait SourceProbe: Send + Sync {
    /// Returns a duration for a reachable URL.
    fn measure(&self, url: &str) -> UpdaterResult<Duration>;
}

/// Git backend abstraction used for mock-first tests.
pub trait GitExecutor {
    /// Returns whether system Git CLI is available.
    fn has_cli(&self) -> bool;
    /// Runs a shallow CLI clone.
    fn clone_cli(&self, url: &str, branch: &str, target: &Path) -> UpdaterResult<()>;
    /// Runs a shallow CLI fetch/reset update.
    fn update_cli(&self, url: &str, branch: &str, target: &Path) -> UpdaterResult<()>;
    /// Returns local HEAD SHA using CLI.
    fn local_sha_cli(&self, target: &Path) -> UpdaterResult<String>;
    /// Returns remote branch HEAD SHA.
    fn remote_sha(&self, url: &str, branch: &str) -> UpdaterResult<String>;
    /// Runs a shallow git2 clone.
    fn clone_git2(
        &self,
        url: &str,
        branch: &str,
        target: &Path,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<()>;
    /// Runs a shallow git2 fetch/reset update.
    fn update_git2(
        &self,
        url: &str,
        branch: &str,
        target: &Path,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<()>;
    /// Returns local HEAD SHA using git2.
    fn local_sha_git2(&self, target: &Path) -> UpdaterResult<String>;
}

/// Real source probe that uses `git ls-remote` as a reachability check.
#[derive(Debug, Clone, Copy, Default)]
pub struct GitSourceProbe;

impl SourceProbe for GitSourceProbe {
    /// Handles the measure workflow.
    fn measure(&self, url: &str) -> UpdaterResult<Duration> {
        let start = Instant::now();
        let mut command = Command::new("git");
        hide_command_window(&mut command);
        configure_git_cli_command(&mut command);
        let status = command
            .arg("-c")
            .arg("credential.interactive=never")
            .arg("ls-remote")
            .arg("--heads")
            .arg(url)
            .arg(DEFAULT_BRANCH)
            .env("GIT_TERMINAL_PROMPT", "0")
            .status()
            .map_err(|error| UpdaterError::Git(error.to_string()))?;
        if status.success() {
            Ok(start.elapsed())
        } else {
            Err(UpdaterError::Git(format!("source probe failed for {url}")))
        }
    }
}

/// Real source probe for git2-only environments that cannot rely on Git CLI.
#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, Copy, Default)]
pub struct GitHttpSourceProbe;

#[cfg(not(target_os = "android"))]
impl SourceProbe for GitHttpSourceProbe {
    /// Handles the measure workflow.
    fn measure(&self, url: &str) -> UpdaterResult<Duration> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        let probe_url = git_smart_http_probe_url(url);
        let start = Instant::now();
        let response = client
            .get(&probe_url)
            .header("Git-Protocol", "version=2")
            .send()
            .map_err(|error| UpdaterError::Network(error.to_string()))?;
        if response.status().is_success() || response.status().is_redirection() {
            Ok(start.elapsed())
        } else {
            Err(UpdaterError::Network(format!(
                "source probe failed for {url}: HTTP {}",
                response.status()
            )))
        }
    }
}

/// Real Git executor that prefers CLI commands and provides git2 fallback.
#[derive(Debug, Clone, Copy, Default)]
pub struct RealGitExecutor;

impl GitExecutor for RealGitExecutor {
    /// Returns the has cli result.
    fn has_cli(&self) -> bool {
        let mut command = Command::new("git");
        hide_command_window(&mut command);
        configure_git_cli_command(&mut command);
        command
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    /// Handles the clone cli workflow.
    fn clone_cli(&self, url: &str, branch: &str, target: &Path) -> UpdaterResult<()> {
        run_git(
            &[
                "clone",
                "--depth",
                "1",
                "--branch",
                branch,
                url,
                &target.to_string_lossy(),
            ],
            None,
        )
    }

    /// Performs the update cli operation.
    fn update_cli(&self, url: &str, branch: &str, target: &Path) -> UpdaterResult<()> {
        run_git(&["remote", "set-url", "origin", url], Some(target))?;
        run_git(&["fetch", "--depth", "1", "origin", branch], Some(target))?;
        run_git(&["reset", "--hard", "FETCH_HEAD"], Some(target))?;
        let _ = run_git(&["reflog", "expire", "--expire=now", "--all"], Some(target));
        let _ = run_git(&["gc", "--prune=now"], Some(target));
        Ok(())
    }

    /// Handles the local sha cli workflow.
    fn local_sha_cli(&self, target: &Path) -> UpdaterResult<String> {
        let mut cmd = Command::new("git");
        hide_command_window(&mut cmd);
        configure_git_cli_command(&mut cmd);
        let output = cmd
            .arg("rev-parse")
            .arg("HEAD")
            .current_dir(target)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|error| UpdaterError::Git(error.to_string()))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(UpdaterError::Git(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ))
        }
    }

    /// Handles the remote sha workflow.
    fn remote_sha(&self, url: &str, branch: &str) -> UpdaterResult<String> {
        let mut cmd = Command::new("git");
        hide_command_window(&mut cmd);
        configure_git_cli_command(&mut cmd);
        let output = cmd
            .arg("-c")
            .arg("credential.interactive=never")
            .arg("ls-remote")
            .arg("--heads")
            .arg(url)
            .arg(branch)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|error| UpdaterError::Git(error.to_string()))?;
        if !output.status.success() {
            return Err(UpdaterError::Git(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout
            .split_whitespace()
            .next()
            .filter(|sha| !sha.is_empty())
            .map(ToOwned::to_owned)
            .ok_or_else(|| UpdaterError::Git(format!("remote branch not found: {url} {branch}")))
    }

    /// Handles the clone git2 workflow.
    fn clone_git2(
        &self,
        url: &str,
        branch: &str,
        target: &Path,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<()> {
        let mut fetch_options = git2_fetch_options(output);
        fetch_options.depth(1);
        let mut builder = RepoBuilder::new();
        builder.fetch_options(fetch_options);
        builder.branch(branch);
        builder.clone(url, target)?;
        Ok(())
    }

    /// Performs the update git2 operation.
    fn update_git2(
        &self,
        url: &str,
        branch: &str,
        target: &Path,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<()> {
        let repo = Repository::open(target)?;
        if repo.find_remote("origin").is_ok() {
            repo.remote_set_url("origin", url)?;
        } else {
            repo.remote("origin", url)?;
        }
        let mut remote = repo.find_remote("origin")?;
        let mut fetch_options = git2_fetch_options(output);
        fetch_options.depth(1);
        remote.fetch(&[branch], Some(&mut fetch_options), None)?;
        let fetch_head = repo.find_reference("FETCH_HEAD")?;
        let object = fetch_head.peel(git2::ObjectType::Commit)?;
        remove_git_index(target)?;
        repo.reset(&object, git2::ResetType::Hard, None)?;
        Ok(())
    }

    /// Handles the local sha git2 workflow.
    fn local_sha_git2(&self, target: &Path) -> UpdaterResult<String> {
        let repo = Repository::open(target)?;
        let head = repo.head()?.peel_to_commit()?;
        Ok(head.id().to_string())
    }
}

/// Synchronizes repositories with source ranking and Git fallback behavior.
pub struct RepoManager<E> {
    executor: E,
}

impl<E: GitExecutor> RepoManager<E> {
    /// Creates a repository manager using the provided Git executor.
    pub fn new(executor: E) -> Self {
        Self { executor }
    }

    /// Synchronizes one repository by trying ranked sources in order.
    pub fn sync(
        &self,
        options: &RepoSyncOptions,
        probe: &(impl SourceProbe + Clone + 'static),
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<RepoSyncResult> {
        let expected_urls = repository_urls(options.kind, options.channel);
        if options.git_backend == GitBackend::GitCli && !self.executor.has_cli() {
            return Err(UpdaterError::Git(
                "Git CLI backend selected, but system git is unavailable".to_string(),
            ));
        }
        let branch = repository_branch(options.kind)?;
        let mut last_error: Option<UpdaterError> = None;
        let probe_urls = expected_urls
            .iter()
            .map(|url| (url.clone(), url.clone()))
            .collect::<Vec<_>>();
        let mut selector = SourceSelector::load(options.ranking_path.as_deref(), &expected_urls)?;

        loop {
            let source_url = match selector.next_source(
                &probe_urls,
                probe,
                output,
                &format!("{} repository", options.kind.as_str()),
            ) {
                Ok(url) => url,
                Err(error) => {
                    let detail = last_error
                        .map(|last| format!("; last error: {}", last.message()))
                        .unwrap_or_default();
                    return Err(UpdaterError::Git(format!("{}{detail}", error.message())));
                }
            };
            output.line(
                OutputStyle::Info,
                &format!(
                    "Synchronizing {} repository from {}",
                    options.kind.as_str(),
                    source_url
                ),
            );
            match self.try_source(
                &source_url,
                &branch,
                &options.target_dir,
                options.git_backend,
                output,
            ) {
                Ok(status) => {
                    let sha = self.local_sha(&options.target_dir, options.git_backend)?;
                    selector.mark_succeeded(&source_url)?;
                    return Ok(RepoSyncResult {
                        kind: options.kind,
                        status,
                        source_url,
                        sha,
                    });
                }
                Err(error) => {
                    output.line(OutputStyle::Warning, &format!("{error}"));
                    selector.mark_failed(&source_url)?;
                    last_error = Some(error);
                    cleanup_failed_clone(&options.target_dir)?;
                }
            }
        }
    }

    /// Handles the try source workflow.
    fn try_source(
        &self,
        url: &str,
        branch: &str,
        target: &Path,
        git_backend: GitBackend,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<UpdateStatus> {
        let is_update = prepare_repository_target(target, output)?;
        let can_check_remote = git_backend != GitBackend::Git2 && self.executor.has_cli();
        if is_update
            && can_check_remote
            && let Ok(local_sha) = self.local_sha(target, git_backend)
            && let Ok(remote_sha) = self.executor.remote_sha(url, branch)
            && local_sha == remote_sha
        {
            output.line(
                OutputStyle::Success,
                &format!("{} repository already at {local_sha}", target.display()),
            );
            return Ok(UpdateStatus::Skipped);
        }

        match git_backend {
            GitBackend::GitCli => {
                if !self.executor.has_cli() {
                    return Err(UpdaterError::Git(
                        "Git CLI backend selected, but system git is unavailable".to_string(),
                    ));
                }
                if is_update {
                    self.executor.update_cli(url, branch, target)?;
                    Ok(UpdateStatus::Updated)
                } else {
                    self.executor.clone_cli(url, branch, target)?;
                    Ok(UpdateStatus::Installed)
                }
            }
            GitBackend::Auto => {
                if self.executor.has_cli() {
                    let cli_result = if is_update {
                        self.executor.update_cli(url, branch, target)
                    } else {
                        self.executor.clone_cli(url, branch, target)
                    };
                    match cli_result {
                        Ok(()) => {
                            return Ok(if is_update {
                                UpdateStatus::Updated
                            } else {
                                UpdateStatus::Installed
                            });
                        }
                        Err(error) => output.line(
                            OutputStyle::Warning,
                            &format!("Git CLI failed; falling back to git2: {error}"),
                        ),
                    }
                }
                self.try_source_git2(url, branch, target, is_update, output)
            }
            GitBackend::Git2 => self.try_source_git2(url, branch, target, is_update, output),
        }
    }

    /// Handles the try source git2 workflow.
    fn try_source_git2(
        &self,
        url: &str,
        branch: &str,
        target: &Path,
        is_update: bool,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<UpdateStatus> {
        if is_update {
            self.executor.update_git2(url, branch, target, output)?;
            Ok(UpdateStatus::Updated)
        } else {
            self.executor.clone_git2(url, branch, target, output)?;
            Ok(UpdateStatus::Installed)
        }
    }

    /// Handles the local sha workflow.
    fn local_sha(&self, target: &Path, git_backend: GitBackend) -> UpdaterResult<String> {
        match git_backend {
            GitBackend::GitCli => self.executor.local_sha_cli(target),
            GitBackend::Git2 => self.executor.local_sha_git2(target),
            GitBackend::Auto => {
                if self.executor.has_cli() {
                    self.executor
                        .local_sha_cli(target)
                        .or_else(|_| self.executor.local_sha_git2(target))
                } else {
                    self.executor.local_sha_git2(target)
                }
            }
        }
    }
}

/// Returns the ordered source URLs for a repository and channel.
pub fn repository_urls(kind: RepositoryKind, channel: UpdateChannel) -> Vec<String> {
    let source = match (kind, channel) {
        (RepositoryKind::Main, UpdateChannel::Stable) => &constants::MAIN_REPO_SRC,
        (RepositoryKind::Main, UpdateChannel::Dev) => &constants::MAIN_REPO_SRC_DEV,
        (RepositoryKind::Cpp, _) => &constants::CPP_REPO_SRC,
    };
    std::iter::once(source.main)
        .chain(source.proxy.iter().copied())
        .map(ToOwned::to_owned)
        .collect()
}

/// Returns the branch name for a repository on the current platform.
pub fn repository_branch(kind: RepositoryKind) -> UpdaterResult<String> {
    match kind {
        RepositoryKind::Main => Ok(DEFAULT_BRANCH.to_string()),
        RepositoryKind::Cpp => cpp_branch_for(std::env::consts::OS, std::env::consts::ARCH),
    }
}

/// Maps OS and architecture to the Cpp prebuild branch.
pub fn cpp_branch_for(os: &str, arch: &str) -> UpdaterResult<String> {
    match (os, arch) {
        ("windows", "x86_64" | "amd64") => Ok("windows-x64".to_string()),
        ("linux", "x86_64" | "amd64") => Ok("linux-x64".to_string()),
        ("macos", "aarch64" | "arm64") => Ok("macos-arm64".to_string()),
        _ => Err(UpdaterError::Git(format!(
            "unsupported Cpp repository platform: {os}/{arch}"
        ))),
    }
}

/// Loads a ranking file or benchmarks sources when it is missing or stale.
pub fn load_or_benchmark_ranking(
    path: Option<&Path>,
    expected_urls: &[String],
    probe: &impl SourceProbe,
) -> UpdaterResult<SourceRanking> {
    load_or_benchmark_ranking_with_output(path, expected_urls, probe, &crate::NoopOutput)
}

/// Loads a ranking file or benchmarks sources with terminal repaint output.
pub fn load_or_benchmark_ranking_with_output(
    path: Option<&Path>,
    expected_urls: &[String],
    probe: &impl SourceProbe,
    output: &(impl OutputSink + ?Sized),
) -> UpdaterResult<SourceRanking> {
    if let Some(path) = path
        && path.exists()
    {
        let content = fs::read_to_string(path)?;
        let ranking: SourceRanking = serde_json::from_str(&content)
            .map_err(|error| UpdaterError::Config(error.to_string()))?;
        if ranking.matches_urls(expected_urls) && !ranking.all_disabled() {
            return Ok(ranking);
        }
    }
    Ok(benchmark_sources_with_output(expected_urls, probe, output))
}

/// Loads a valid persisted ranking without performing a new benchmark.
fn load_ranking(
    path: Option<&Path>,
    expected_urls: &[String],
) -> UpdaterResult<Option<SourceRanking>> {
    let Some(path) = path else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)?;
    let ranking: SourceRanking =
        serde_json::from_str(&content).map_err(|error| UpdaterError::Config(error.to_string()))?;
    Ok(ranking.matches_urls(expected_urls).then_some(ranking))
}

/// Loads a ranking file or returns the expected URLs in their configured order.
pub fn load_or_default_ranking(
    path: Option<&Path>,
    expected_urls: &[String],
) -> UpdaterResult<SourceRanking> {
    if let Some(path) = path
        && path.exists()
    {
        let content = fs::read_to_string(path)?;
        let ranking: SourceRanking = serde_json::from_str(&content)
            .map_err(|error| UpdaterError::Config(error.to_string()))?;
        if ranking.matches_urls(expected_urls) && !ranking.all_disabled() {
            return Ok(ranking);
        }
    }
    Ok(SourceRanking::from_urls(expected_urls))
}

/// Benchmarks sources and returns a sorted ranking.
pub fn benchmark_sources(expected_urls: &[String], probe: &impl SourceProbe) -> SourceRanking {
    benchmark_sources_with_output(expected_urls, probe, &crate::NoopOutput)
}

/// Benchmarks sources and renders multi-line status when terminal output exists.
pub fn benchmark_sources_with_output(
    expected_urls: &[String],
    probe: &impl SourceProbe,
    output: &(impl OutputSink + ?Sized),
) -> SourceRanking {
    let source_probes = expected_urls
        .iter()
        .map(|url| (url.clone(), url.clone()))
        .collect::<Vec<_>>();
    benchmark_source_probes_with_output(&source_probes, probe, output)
}

/// Benchmarks source URLs using separate probe URLs.
///
/// The returned ranking always stores the source URL. The probe URL is used
/// only for reachability measurement, which is useful for mirror roots that are
/// consumed by a tool but do not respond successfully themselves.
pub fn benchmark_source_probes_with_output(
    source_probes: &[(String, String)],
    probe: &impl SourceProbe,
    output: &(impl OutputSink + ?Sized),
) -> SourceRanking {
    let mut measured = Vec::new();
    let mut failed = Vec::new();
    let mut statuses = source_probes
        .iter()
        .map(|(url, _)| format!("pending  {url}"))
        .collect::<Vec<_>>();
    let mut repaint = output
        .thread_output()
        .map(|term| term.log().block_repaint());

    for (index, (url, _)) in source_probes.iter().enumerate() {
        statuses[index] = format!("testing  {url}");
    }
    render_probe_status(&mut repaint, &statuses);

    thread::scope(|scope| {
        let (tx, rx) = mpsc::channel();
        for (index, (source_url, probe_url)) in source_probes.iter().enumerate() {
            let tx = tx.clone();
            scope.spawn(move || {
                let result = probe.measure(probe_url);
                let _ = tx.send((index, source_url.clone(), result));
            });
        }
        drop(tx);

        for (index, url, result) in rx {
            match result {
                Ok(duration) => {
                    statuses[index] = format!("ok       {:>5} ms  {url}", duration.as_millis());
                    measured.push((url, duration));
                }
                Err(_) => {
                    statuses[index] = format!("failed          {url}");
                    failed.push(url);
                }
            }
            render_probe_status(&mut repaint, &statuses);
        }
    });
    if let Some(repaint) = &mut repaint {
        repaint.finish();
    }
    measured.sort_by_key(|(_, duration)| *duration);
    let mut sources = measured
        .into_iter()
        .enumerate()
        .map(|(index, (url, _))| RankedSource {
            url,
            order: index as i32,
        })
        .collect::<Vec<_>>();
    sources.extend(
        failed
            .into_iter()
            .map(|url| RankedSource { url, order: -1 }),
    );
    SourceRanking {
        sources,
        all_failed_cycles: 0,
        preferred_url: None,
    }
}

/// Races enabled sources and returns as soon as the first probe succeeds.
///
/// Probe workers own their inputs and are intentionally detached after a
/// winner is found, so a slow source cannot delay the real download/update.
fn race_first_source_with_output<P: SourceProbe + Clone + 'static>(
    source_probes: &[(String, String)],
    probe: &P,
    output: &(impl OutputSink + ?Sized),
) -> SourceRace {
    let mut statuses = source_probes
        .iter()
        .map(|(url, _)| format!("testing  {url}"))
        .collect::<Vec<_>>();
    let mut repaint = output
        .thread_output()
        .map(|term| term.log().block_repaint());
    render_probe_status(&mut repaint, &statuses);

    let (tx, rx) = mpsc::channel();
    for (index, (source_url, probe_url)) in source_probes.iter().cloned().enumerate() {
        let tx = tx.clone();
        let probe = probe.clone();
        thread::spawn(move || {
            let result = probe.measure(&probe_url);
            let _ = tx.send((index, source_url, result));
        });
    }
    drop(tx);

    let mut failed = Vec::new();
    for (index, url, result) in rx {
        match result {
            Ok(duration) => {
                statuses[index] = format!("selected {:>5} ms  {url}", duration.as_millis());
                render_probe_status(&mut repaint, &statuses);
                if let Some(repaint) = &mut repaint {
                    repaint.finish();
                }
                return SourceRace {
                    winner: Some(url),
                    failed,
                };
            }
            Err(_) => {
                statuses[index] = format!("failed          {url}");
                failed.push(url);
                render_probe_status(&mut repaint, &statuses);
            }
        }
    }
    if let Some(repaint) = &mut repaint {
        repaint.finish();
    }
    SourceRace {
        winner: None,
        failed,
    }
}

/// Handles the render probe status workflow.
fn render_probe_status(
    repaint: &mut Option<baas_term::threader::ThreadBlockRepaint>,
    statuses: &[String],
) {
    if let Some(repaint) = repaint {
        let lines = statuses.iter().map(String::as_str).collect::<Vec<_>>();
        repaint.render(ThreadLogStyle::Muted, lines);
    }
}

/// Saves source ranking to a JSON file.
pub fn save_ranking(path: &Path, ranking: &SourceRanking) -> UpdaterResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(ranking)
        .map_err(|error| UpdaterError::Config(error.to_string()))?;
    fs::write(path, content)?;
    Ok(())
}

/// Performs the run git operation.
fn run_git(args: &[&str], cwd: Option<&Path>) -> UpdaterResult<()> {
    let mut command = Command::new("git");
    hide_command_window(&mut command);
    configure_git_cli_command(&mut command);
    command
        .arg("-c")
        .arg("credential.interactive=never")
        .args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .map_err(|error| UpdaterError::Git(error.to_string()))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(UpdaterError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

/// Handles the configure git cli command workflow.
fn configure_git_cli_command(command: &mut Command) {
    command
        .arg("-c")
        .arg("credential.helper=")
        .arg("-c")
        .arg("credential.interactive=never")
        .arg("-c")
        .arg("core.askPass=echo")
        .arg("-c")
        .arg("core.sshCommand=ssh -o BatchMode=yes")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GCM_MODAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo")
        .env("SSH_ASKPASS", "echo");
}

/// Handles the git smart http probe url workflow.
#[cfg(not(target_os = "android"))]
fn git_smart_http_probe_url(url: &str) -> String {
    format!(
        "{}/info/refs?service=git-upload-pack",
        url.trim_end_matches('/')
    )
}

/// Handles the hide command window workflow.
#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

/// Handles the hide command window workflow.
#[cfg(not(target_os = "windows"))]
fn hide_command_window(_command: &mut Command) {}

/// Handles the git2 fetch options workflow.
fn git2_fetch_options(output: &(impl OutputSink + ?Sized)) -> FetchOptions<'_> {
    let mut callbacks = RemoteCallbacks::new();
    let term = output.thread_output().cloned();
    let mut progress: Option<ThreadProgressBar> = None;
    callbacks.transfer_progress(move |stats| {
        let total = stats.total_objects() as u64;
        let received = stats.received_objects() as u64;
        if total > 0 {
            if progress.is_none()
                && let Some(term) = term.clone()
            {
                progress = Some(term.progress_bar("git2 transfer", total, 30));
            }
            if let Some(progress_bar) = progress.as_mut() {
                progress_bar.set(received, format!("{received}/{total} objects"));
                if received >= total {
                    progress_bar.finish(ThreadLogStyle::Success, "git2 transfer complete");
                    progress = None;
                }
            }
        }
        true
    });
    let mut fetch_options = FetchOptions::new();
    fetch_options.remote_callbacks(callbacks);
    fetch_options
}

/// Performs the cleanup failed clone operation.
fn cleanup_failed_clone(target: &Path) -> UpdaterResult<()> {
    if is_valid_git_repository(target) {
        return Ok(());
    }
    if target.exists() {
        remove_dir_all_retry(target)?;
    }
    Ok(())
}

/// Handles the prepare repository target workflow.
fn prepare_repository_target(
    target: &Path,
    output: &(impl OutputSink + ?Sized),
) -> UpdaterResult<bool> {
    if !target.exists() {
        return Ok(false);
    }
    if is_valid_git_repository(target) {
        return Ok(true);
    }
    output.line(
        OutputStyle::Warning,
        &format!(
            "Removing incomplete repository staging directory: {}",
            target.display()
        ),
    );
    remove_dir_all_retry(target).map_err(|error| {
        UpdaterError::Io(format!(
            "failed to remove incomplete repository at {}; close any process using this directory and retry: {}",
            target.display(),
            error.message()
        ))
    })?;
    Ok(false)
}

/// Returns the is valid git repository result.
fn is_valid_git_repository(target: &Path) -> bool {
    target.join(".git").exists() && Repository::open(target).is_ok()
}

/// Performs the remove dir all retry operation.
fn remove_dir_all_retry(target: &Path) -> UpdaterResult<()> {
    let mut last_error = None;
    for attempt in 0..5 {
        match fs::remove_dir_all(target) {
            Ok(()) => return Ok(()),
            Err(_) if !target.exists() => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                clear_readonly_recursive(target);
                release_repository_locks(target);
                thread::sleep(Duration::from_millis(50 * (attempt + 1)));
            }
        }
    }
    match fs::remove_dir_all(target) {
        Ok(()) => Ok(()),
        Err(_) if !target.exists() => Ok(()),
        Err(error) => Err(last_error.unwrap_or(error).into()),
    }
}

/// Performs the clear readonly recursive operation.
fn clear_readonly_recursive(target: &Path) {
    if let Ok(metadata) = fs::metadata(target) {
        clear_readonly(target, metadata);
    }
    if let Ok(entries) = fs::read_dir(target) {
        for entry in entries.flatten() {
            clear_readonly_recursive(&entry.path());
        }
    }
}

/// Performs the clear readonly operation.
#[cfg(target_family = "windows")]
#[allow(clippy::permissions_set_readonly_false)]
fn clear_readonly(target: &Path, metadata: fs::Metadata) {
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        permissions.set_readonly(false);
        let _ = fs::set_permissions(target, permissions);
    }
}

/// Performs the clear readonly operation.
#[cfg(target_family = "unix")]
fn clear_readonly(target: &Path, metadata: fs::Metadata) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    if mode & 0o200 == 0 {
        permissions.set_mode(mode | 0o200);
        let _ = fs::set_permissions(target, permissions);
    }
}

/// Handles the release repository locks workflow.
#[cfg(target_os = "windows")]
fn release_repository_locks(target: &Path) {
    let script = r#"
$target = [System.IO.Path]::GetFullPath($args[0]).ToLowerInvariant()
$names = @('git.exe', 'git-remote-http.exe', 'git-remote-https.exe', 'ssh.exe')
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and
    $names -contains $_.Name.ToLowerInvariant() -and
    $_.CommandLine.ToLowerInvariant().Contains($target)
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
"#;
    let mut command = Command::new("powershell");
    hide_command_window(&mut command);
    let _ = command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script)
        .arg(target)
        .status();
}

/// Handles the release repository locks workflow.
#[cfg(not(target_os = "windows"))]
fn release_repository_locks(_target: &Path) {}

/// Removes the existing Git index before a hard reset.
fn remove_git_index(target: &Path) -> UpdaterResult<()> {
    let index_path = target.join(".git").join("index");
    match fs::remove_file(&index_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    #[derive(Clone)]
    struct Probe {
        ok: Vec<String>,
    }

    impl SourceProbe for Probe {
        /// Handles the measure workflow.
        fn measure(&self, url: &str) -> UpdaterResult<Duration> {
            if self.ok.iter().any(|item| item == url) {
                Ok(Duration::from_millis(if url.contains("fast") {
                    1
                } else {
                    10
                }))
            } else {
                Err(UpdaterError::Network("fail".to_string()))
            }
        }
    }

    #[derive(Default)]
    struct MockGit {
        has_cli: bool,
        remote_sha: String,
        cli_results: Mutex<VecDeque<UpdaterResult<()>>>,
        git2_error: Option<String>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl MockGit {
        /// Handles the with cli failure then git2 workflow.
        fn with_cli_failure_then_git2() -> Self {
            let mut cli_results = VecDeque::new();
            cli_results.push_back(Err(UpdaterError::Git("cli failed".to_string())));
            Self {
                has_cli: true,
                remote_sha: "remote-sha".to_string(),
                cli_results: Mutex::new(cli_results),
                git2_error: None,
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }

        /// Handles the up to date workflow.
        fn up_to_date() -> Self {
            Self {
                has_cli: true,
                remote_sha: "cli-sha".to_string(),
                cli_results: Mutex::new(VecDeque::new()),
                git2_error: None,
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }

        /// Handles the git2 failure workflow.
        fn git2_failure(message: &str) -> Self {
            Self {
                has_cli: true,
                remote_sha: "remote-sha".to_string(),
                cli_results: Mutex::new(VecDeque::new()),
                git2_error: Some(message.to_string()),
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl GitExecutor for MockGit {
        /// Returns the has cli result.
        fn has_cli(&self) -> bool {
            self.has_cli
        }

        /// Handles the clone cli workflow.
        fn clone_cli(&self, url: &str, branch: &str, _target: &Path) -> UpdaterResult<()> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("clone_cli:{url}:{branch}"));
            self.cli_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(()))
        }

        /// Performs the update cli operation.
        fn update_cli(&self, url: &str, branch: &str, _target: &Path) -> UpdaterResult<()> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("update_cli:{url}:{branch}"));
            self.cli_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(()))
        }

        /// Handles the local sha cli workflow.
        fn local_sha_cli(&self, _target: &Path) -> UpdaterResult<String> {
            Ok("cli-sha".to_string())
        }

        /// Handles the remote sha workflow.
        fn remote_sha(&self, _url: &str, _branch: &str) -> UpdaterResult<String> {
            Ok(self.remote_sha.clone())
        }

        /// Handles the clone git2 workflow.
        fn clone_git2(
            &self,
            url: &str,
            branch: &str,
            _target: &Path,
            _output: &(impl OutputSink + ?Sized),
        ) -> UpdaterResult<()> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("clone_git2:{url}:{branch}"));
            if let Some(error) = &self.git2_error {
                return Err(UpdaterError::Git(error.clone()));
            }
            Ok(())
        }

        /// Performs the update git2 operation.
        fn update_git2(
            &self,
            url: &str,
            branch: &str,
            _target: &Path,
            _output: &(impl OutputSink + ?Sized),
        ) -> UpdaterResult<()> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("update_git2:{url}:{branch}"));
            if let Some(error) = &self.git2_error {
                return Err(UpdaterError::Git(error.clone()));
            }
            Ok(())
        }

        /// Handles the local sha git2 workflow.
        fn local_sha_git2(&self, _target: &Path) -> UpdaterResult<String> {
            Ok("git2-sha".to_string())
        }
    }

    /// Handles the ranking detects stale url set and demotes failures workflow.
    #[test]
    fn ranking_detects_stale_url_set_and_demotes_failures() {
        let mut ranking = SourceRanking::from_urls(&["a".to_string(), "b".to_string()]);

        assert!(ranking.matches_urls(&["b".to_string(), "a".to_string()]));
        assert!(!ranking.matches_urls(&["a".to_string(), "c".to_string()]));

        ranking.demote_failed("a");
        assert_eq!(ranking.sources[0].order, -1);
        assert_eq!(ranking.active_sources()[0].url, "b");
    }

    /// Handles the benchmarks sources by duration and marks failures workflow.
    #[test]
    fn benchmarks_sources_by_duration_and_marks_failures() {
        let ranking = benchmark_sources(
            &[
                "https://slow.example".to_string(),
                "https://down.example".to_string(),
                "https://fast.example".to_string(),
            ],
            &Probe {
                ok: vec![
                    "https://slow.example".to_string(),
                    "https://fast.example".to_string(),
                ],
            },
        );

        assert_eq!(ranking.sources[0].url, "https://fast.example");
        assert_eq!(ranking.sources[1].url, "https://slow.example");
        assert_eq!(ranking.sources[2].order, -1);
    }

    /// Handles the benchmarks sources in parallel workflow.
    #[test]
    fn benchmarks_sources_in_parallel() {
        struct ParallelProbe {
            active: AtomicUsize,
            max_active: AtomicUsize,
        }

        impl SourceProbe for ParallelProbe {
            /// Handles the measure workflow.
            fn measure(&self, _url: &str) -> UpdaterResult<Duration> {
                let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
                self.max_active.fetch_max(active, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(30));
                self.active.fetch_sub(1, Ordering::SeqCst);
                Ok(Duration::from_millis(1))
            }
        }

        let probe = ParallelProbe {
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
        };
        let ranking =
            benchmark_sources(&["a".to_string(), "b".to_string(), "c".to_string()], &probe);

        assert_eq!(ranking.sources.len(), 3);
        assert!(probe.max_active.load(Ordering::SeqCst) > 1);
    }

    /// Handles the git http probe uses smart http refs endpoint workflow.
    #[test]
    fn git_http_probe_uses_smart_http_refs_endpoint() {
        assert_eq!(
            git_smart_http_probe_url("https://example.com/repo.git/"),
            "https://example.com/repo.git/info/refs?service=git-upload-pack"
        );
    }

    /// Handles the cpp branch mapping matches reference script workflow.
    #[test]
    fn cpp_branch_mapping_matches_reference_script() {
        assert_eq!(cpp_branch_for("windows", "x86_64").unwrap(), "windows-x64");
        assert_eq!(cpp_branch_for("linux", "x86_64").unwrap(), "linux-x64");
        assert_eq!(cpp_branch_for("macos", "aarch64").unwrap(), "macos-arm64");
        assert!(cpp_branch_for("windows", "aarch64").is_err());
    }

    /// Handles the remove git index before hard reset workflow.
    #[test]
    fn remove_git_index_ignores_missing_index() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join(".git");
        fs::create_dir_all(&git_dir).unwrap();
        let index = git_dir.join("index");
        fs::write(&index, b"stale index").unwrap();

        remove_git_index(dir.path()).unwrap();
        assert!(!index.exists());
        remove_git_index(dir.path()).unwrap();
    }

    /// Performs the sync falls back from cli to git2 operation.
    #[test]
    fn sync_falls_back_from_cli_to_git2() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        let ranking = dir.path().join("ranking.json");
        let url = repository_urls(RepositoryKind::Main, UpdateChannel::Stable)
            .into_iter()
            .next()
            .unwrap();
        save_ranking(
            &ranking,
            &SourceRanking::from_urls(&repository_urls(
                RepositoryKind::Main,
                UpdateChannel::Stable,
            )),
        )
        .unwrap();
        let git = MockGit::with_cli_failure_then_git2();
        let calls = Arc::clone(&git.calls);
        let manager = RepoManager::new(git);

        let result = manager
            .sync(
                &RepoSyncOptions {
                    kind: RepositoryKind::Main,
                    channel: UpdateChannel::Stable,
                    target_dir: target,
                    ranking_path: Some(ranking),
                    git_backend: GitBackend::Auto,
                },
                &Probe {
                    ok: vec![url.clone()],
                },
                &crate::NoopOutput,
            )
            .unwrap();

        assert_eq!(result.status, UpdateStatus::Installed);
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                format!("clone_cli:{url}:master"),
                format!("clone_git2:{url}:master")
            ]
        );
    }

    /// Performs the sync skips update when remote sha matches local head operation.
    #[test]
    fn sync_skips_update_when_remote_sha_matches_local_head() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        Repository::init(&target).unwrap();
        let ranking = dir.path().join("ranking.json");
        let urls = repository_urls(RepositoryKind::Main, UpdateChannel::Stable);
        let url = urls.first().unwrap().clone();
        save_ranking(&ranking, &SourceRanking::from_urls(&urls)).unwrap();
        let git = MockGit::up_to_date();
        let calls = Arc::clone(&git.calls);
        let manager = RepoManager::new(git);

        let result = manager
            .sync(
                &RepoSyncOptions {
                    kind: RepositoryKind::Main,
                    channel: UpdateChannel::Stable,
                    target_dir: target,
                    ranking_path: Some(ranking),
                    git_backend: GitBackend::Auto,
                },
                &Probe { ok: vec![url] },
                &crate::NoopOutput,
            )
            .unwrap();

        assert_eq!(result.status, UpdateStatus::Skipped);
        assert!(calls.lock().unwrap().is_empty());
    }

    /// Performs the sync with git2 uses ranked sources operation.
    #[test]
    fn sync_with_git2_uses_ranked_sources() {
        #[derive(Clone)]
        struct FastSourceProbe {
            fast_url: String,
        }

        impl SourceProbe for FastSourceProbe {
            /// Handles the measure workflow.
            fn measure(&self, url: &str) -> UpdaterResult<Duration> {
                if url == self.fast_url {
                    std::thread::sleep(Duration::from_millis(1));
                    Ok(Duration::from_millis(1))
                } else {
                    std::thread::sleep(Duration::from_millis(50));
                    Ok(Duration::from_millis(50))
                }
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        let ranking = dir.path().join("ranking.json");
        let urls = repository_urls(RepositoryKind::Main, UpdateChannel::Stable);
        let fast_url = urls[1].clone();
        let git = MockGit::default();
        let calls = Arc::clone(&git.calls);
        let manager = RepoManager::new(git);

        let result = manager
            .sync(
                &RepoSyncOptions {
                    kind: RepositoryKind::Main,
                    channel: UpdateChannel::Stable,
                    target_dir: target,
                    ranking_path: Some(ranking),
                    git_backend: GitBackend::Git2,
                },
                &FastSourceProbe {
                    fast_url: fast_url.clone(),
                },
                &crate::NoopOutput,
            )
            .unwrap();

        assert_eq!(result.source_url, fast_url);
        assert_eq!(
            *calls.lock().unwrap(),
            vec![format!("clone_git2:{fast_url}:master")]
        );
    }

    /// Performs the sync removes incomplete staging directory before clone operation.
    #[test]
    fn sync_removes_incomplete_staging_directory_before_clone() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        fs::create_dir_all(target.join("objects")).unwrap();
        fs::write(target.join("objects").join("partial.pack"), "partial").unwrap();
        let ranking = dir.path().join("ranking.json");
        let url = repository_urls(RepositoryKind::Main, UpdateChannel::Stable)
            .into_iter()
            .next()
            .unwrap();
        let git = MockGit::default();
        let calls = Arc::clone(&git.calls);
        let manager = RepoManager::new(git);

        let result = manager
            .sync(
                &RepoSyncOptions {
                    kind: RepositoryKind::Main,
                    channel: UpdateChannel::Stable,
                    target_dir: target.clone(),
                    ranking_path: Some(ranking),
                    git_backend: GitBackend::Git2,
                },
                &Probe {
                    ok: vec![url.clone()],
                },
                &crate::NoopOutput,
            )
            .unwrap();

        assert_eq!(result.status, UpdateStatus::Installed);
        assert!(!target.exists());
        assert_eq!(
            *calls.lock().unwrap(),
            vec![format!("clone_git2:{url}:master")]
        );
    }

    /// Handles the git2 only failure preserves git2 error without rebenchmarking workflow.
    #[test]
    fn git2_failure_exhausts_three_cycles_and_preserves_last_error() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        let urls = repository_urls(RepositoryKind::Main, UpdateChannel::Stable);
        let tls_error = "there is no TLS stream available; class=Ssl (16)";
        let git = MockGit::git2_failure(tls_error);
        let manager = RepoManager::new(git);

        let error = manager
            .sync(
                &RepoSyncOptions {
                    kind: RepositoryKind::Main,
                    channel: UpdateChannel::Stable,
                    target_dir: target,
                    ranking_path: None,
                    git_backend: GitBackend::Git2,
                },
                &Probe { ok: urls },
                &crate::NoopOutput,
            )
            .unwrap_err();

        let message = error.message();
        assert!(message.contains("failed after 3 complete cycles"));
        assert!(message.contains(tls_error));
    }

    /// Source selection returns on the first successful response without
    /// waiting for slower probe workers to finish.
    #[test]
    fn source_selector_stops_waiting_after_first_success() {
        #[derive(Clone)]
        struct TimedProbe;

        impl SourceProbe for TimedProbe {
            fn measure(&self, url: &str) -> UpdaterResult<Duration> {
                let delay = if url == "fast" { 10 } else { 300 };
                std::thread::sleep(Duration::from_millis(delay));
                Ok(Duration::from_millis(delay))
            }
        }

        let urls = vec!["slow".to_string(), "fast".to_string()];
        let probes = urls
            .iter()
            .map(|url| (url.clone(), url.clone()))
            .collect::<Vec<_>>();
        let mut selector = SourceSelector::load(None, &urls).unwrap();
        let started = Instant::now();

        let selected = selector
            .next_source(&probes, &TimedProbe, &crate::NoopOutput, "test")
            .unwrap();

        assert_eq!(selected, "fast");
        assert!(started.elapsed() < Duration::from_millis(150));
    }

    /// A successful real operation persists its source and the next run uses
    /// it directly without launching another benchmark.
    #[test]
    fn source_selector_persists_successful_source() {
        #[derive(Clone)]
        struct CountingProbe(Arc<AtomicUsize>);

        impl SourceProbe for CountingProbe {
            fn measure(&self, url: &str) -> UpdaterResult<Duration> {
                self.0.fetch_add(1, Ordering::SeqCst);
                if url == "winner" {
                    Ok(Duration::from_millis(1))
                } else {
                    std::thread::sleep(Duration::from_millis(50));
                    Ok(Duration::from_millis(50))
                }
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sources.json");
        let urls = vec!["other".to_string(), "winner".to_string()];
        let probes = urls
            .iter()
            .map(|url| (url.clone(), url.clone()))
            .collect::<Vec<_>>();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut selector = SourceSelector::load(Some(&path), &urls).unwrap();
        let selected = selector
            .next_source(
                &probes,
                &CountingProbe(Arc::clone(&calls)),
                &crate::NoopOutput,
                "test",
            )
            .unwrap();
        selector.mark_succeeded(&selected).unwrap();

        let later_calls = Arc::new(AtomicUsize::new(0));
        let mut reloaded = SourceSelector::load(Some(&path), &urls).unwrap();
        let reused = reloaded
            .next_source(
                &probes,
                &CountingProbe(Arc::clone(&later_calls)),
                &crate::NoopOutput,
                "test",
            )
            .unwrap();

        assert_eq!(reused, "winner");
        assert_eq!(later_calls.load(Ordering::SeqCst), 0);
    }

    /// Handles the all disabled ranking errors after three cycles workflow.
    #[test]
    fn all_disabled_ranking_errors_after_three_cycles() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ranking.json");
        save_ranking(
            &path,
            &SourceRanking {
                sources: vec![RankedSource {
                    url: "https://fast.example".to_string(),
                    order: -1,
                }],
                all_failed_cycles: 2,
                preferred_url: None,
            },
        )
        .unwrap();

        let loaded = load_or_benchmark_ranking(
            Some(&path),
            &["https://fast.example".to_string()],
            &Probe { ok: Vec::new() },
        )
        .unwrap();

        assert!(loaded.all_disabled());
    }
}
