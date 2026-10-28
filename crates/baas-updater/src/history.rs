//! Bounded commit metadata, independent of Git object fetching and MirrorC.
//!
//! History reads existing commits only. The cache and archive manifest contain
//! three fields per commit; neither API responses nor patches are persisted.

use crate::{UpdateChannel, constants};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 500;
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const CACHE_TTL: u64 = 600;
pub const MANIFEST_NAME: &str = ".baas-commit-history.json";

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRequest {
    pub channel: Option<UpdateChannel>,
    pub limit: Option<usize>,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CommitMetadata {
    pub hash: String,
    pub author: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryIssue {
    Offline,
    RateLimited,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryReport {
    pub entries: Vec<CommitMetadata>,
    pub repository: String,
    pub reference: String,
    pub current: Option<String>,
    pub source: String,
    pub stale: bool,
    pub partial: bool,
    pub has_more: bool,
    pub issue: Option<HistoryIssue>,
}

pub struct HistoryHttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub has_more: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: u8,
    repository: String,
    reference: String,
    entries: Vec<CommitMetadata>,
    #[serde(default)]
    fetched_at: u64,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    partial: bool,
}

pub fn repository(channel: UpdateChannel) -> &'static str {
    match channel {
        UpdateChannel::Stable => "pur1fying/blue_archive_auto_script",
        UpdateChannel::Dev => "Kiramei/baas-dev",
    }
}

/// Reads only metadata, with an injectable network boundary for Android and tests.
/// A caller-chosen cache directory must be outside any `.git` directory.
pub fn get_commit_history(
    root: &Path,
    cache_dir: &Path,
    channel: UpdateChannel,
    current: Option<String>,
    request: &HistoryRequest,
    mut fetch: impl FnMut(&str) -> Result<HistoryHttpResponse, HistoryIssue>,
) -> HistoryReport {
    let limit = request.limit.unwrap_or(100).clamp(1, MAX_ENTRIES);
    let repo_name = repository(channel);
    let cache_path = cache_dir.join(format!("{}-master.json", channel.as_str()));
    let cache_safe = !cache_dir
        .components()
        .any(|part| part.as_os_str() == ".git");
    let mut cached = cache_safe
        .then(|| read_manifest(&cache_path, repo_name))
        .flatten();
    let current = current
        .filter(|hash| valid_hash(hash))
        .or_else(|| read_local(root, channel, 0).and_then(|(_, head, _, _)| head));
    let now = unix_time();
    if let Some(cache) = &cached {
        if !request.refresh
            && !cache.partial
            && cache.fetched_at > 0
            && cache.fetched_at <= now
            && now - cache.fetched_at <= CACHE_TTL
            && (cache.entries.len() >= limit || !cache.has_more)
        {
            return report(
                &cache.entries,
                limit,
                repo_name,
                current,
                "cache",
                false,
                false,
                cache.has_more,
                None,
            );
        }
    }

    let mut entries = Vec::new();
    let mut more = true;
    let mut issue = None;
    let mut seen = HashSet::new();
    let mut anchor = String::from("master");
    for page in 1..=limit.div_ceil(100) {
        let url = format!(
            "https://api.github.com/repos/{repo_name}/commits?sha={anchor}&per_page=100&page={page}"
        );
        let page_result = fetch(&url).and_then(|response| match response.status {
            200 if response.body.len() as u64 <= MAX_BYTES => {
                let rows = parse_github(&response.body)?;
                Ok((rows, response.has_more))
            }
            403 | 429 => Err(HistoryIssue::RateLimited),
            _ => Err(HistoryIssue::Unavailable),
        });
        match page_result {
            Ok((rows, has_next)) => {
                let count = rows.len();
                if page == 1 {
                    if let Some(first) = rows.first() {
                        anchor = first.hash.clone();
                    }
                }
                for row in rows {
                    if seen.insert(row.hash.clone()) {
                        entries.push(row);
                    }
                }
                more = has_next;
                if count == 0 || !more {
                    break;
                }
            }
            Err(error) => {
                issue = Some(error);
                break;
            }
        }
    }
    if issue.is_none() {
        let manifest = Manifest {
            schema: 1,
            repository: repo_name.into(),
            reference: "master".into(),
            entries: entries.iter().take(MAX_ENTRIES).cloned().collect(),
            fetched_at: now,
            has_more: more,
            partial: false,
        };
        if cache_safe {
            write_cache(&cache_path, &manifest);
        }
        return report(
            &entries, limit, repo_name, current, "github", false, false, more, None,
        );
    }

    // Preserve successful pages for offline access, explicitly marked incomplete.
    // A failed refresh must not replace a larger existing metadata snapshot.
    if !entries.is_empty()
        && cached
            .as_ref()
            .is_none_or(|cache| entries.len() >= cache.entries.len())
    {
        let manifest = Manifest {
            schema: 1,
            repository: repo_name.into(),
            reference: "master".into(),
            entries: entries.iter().take(MAX_ENTRIES).cloned().collect(),
            fetched_at: now,
            has_more: true,
            partial: true,
        };
        if cache_safe {
            write_cache(&cache_path, &manifest);
        }
    }
    if !entries.is_empty() {
        if let Some(cache) = cached.as_mut() {
            if cache.entries.len() > entries.len()
                && cache.entries.first().map(|row| &row.hash)
                    != entries.first().map(|row| &row.hash)
            {
                // Preserve the larger snapshot without claiming it is a fresh
                // result after discovering a newer branch tip.
                cache.partial = true;
                if cache_safe {
                    write_cache(&cache_path, cache);
                }
            }
        }
    }
    if !entries.is_empty() {
        // A successful newer page is more useful than an older, larger snapshot.
        return report(
            &entries, limit, repo_name, current, "github", false, true, true, issue,
        );
    }
    let mut fallback = (entries, "github", false, true, false);
    if let Some((rows, _, shallow, has_more)) = read_local(root, channel, limit) {
        if rows.len() > fallback.0.len() {
            fallback = (rows, "local", false, shallow, has_more);
        }
    }
    if let Some(bundle) = read_manifest(&root.join(MANIFEST_NAME), repo_name) {
        if bundle.entries.len() > fallback.0.len() {
            fallback = (bundle.entries, "bundle", true, true, bundle.has_more);
        }
    }
    if let Some(cache) = cached {
        if cache.entries.len() > fallback.0.len() {
            let partial = cache.partial || (cache.has_more && cache.entries.len() < limit);
            fallback = (cache.entries, "cache", true, partial, cache.has_more);
        }
    }
    report(
        &fallback.0,
        limit,
        repo_name,
        current,
        fallback.1,
        fallback.2,
        fallback.3,
        fallback.4,
        issue,
    )
}

#[allow(clippy::too_many_arguments)]
fn report(
    entries: &[CommitMetadata],
    limit: usize,
    repository: &str,
    current: Option<String>,
    source: &str,
    stale: bool,
    partial: bool,
    has_more: bool,
    issue: Option<HistoryIssue>,
) -> HistoryReport {
    HistoryReport {
        entries: entries.iter().take(limit).cloned().collect(),
        repository: repository.into(),
        reference: "master".into(),
        current,
        source: source.into(),
        stale,
        partial,
        has_more: entries.len() > limit || has_more,
        issue,
    }
}

fn valid_hash(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn metadata(hash: &str, author: &str, message: &str) -> Option<CommitMetadata> {
    if !valid_hash(hash) {
        return None;
    }
    let clean = |value: &str, maximum: usize| {
        value
            .split([
                '\n', '\r', '\u{000b}', '\u{000c}', '\u{001c}', '\u{001d}', '\u{001e}', '\u{0085}',
                '\u{2028}', '\u{2029}',
            ])
            .next()
            .unwrap_or_default()
            .chars()
            .filter(|character| !character.is_control())
            .take(maximum)
            .collect::<String>()
            .trim()
            .to_string()
    };
    let author = clean(author, 256);
    Some(CommitMetadata {
        hash: hash.into(),
        author: if author.is_empty() {
            "Unknown".into()
        } else {
            author
        },
        message: clean(message, 4096),
    })
}

fn parse_github(bytes: &[u8]) -> Result<Vec<CommitMetadata>, HistoryIssue> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| HistoryIssue::Unavailable)?;
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= 100)
        .ok_or(HistoryIssue::Unavailable)?;
    rows.iter()
        .map(|row| {
            metadata(
                row["sha"].as_str().ok_or(HistoryIssue::Unavailable)?,
                row["commit"]["author"]["name"]
                    .as_str()
                    .ok_or(HistoryIssue::Unavailable)?,
                row["commit"]["message"]
                    .as_str()
                    .ok_or(HistoryIssue::Unavailable)?,
            )
            .ok_or(HistoryIssue::Unavailable)
        })
        .collect()
}

fn read_manifest(path: &Path, expected_repository: &str) -> Option<Manifest> {
    let file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    let mut manifest: Manifest = serde_json::from_slice(&bytes).ok()?;
    if manifest.schema != 1
        || !manifest
            .repository
            .eq_ignore_ascii_case(expected_repository)
        || manifest.reference != "master"
        || manifest.entries.len() > MAX_ENTRIES
    {
        return None;
    }
    let mut seen = HashSet::new();
    for row in &mut manifest.entries {
        *row = metadata(&row.hash, &row.author, &row.message)?;
        if !seen.insert(row.hash.clone()) {
            return None;
        }
    }
    Some(manifest)
}

fn write_cache(path: &Path, manifest: &Manifest) {
    let Ok(bytes) = serde_json::to_vec(manifest) else {
        return;
    };
    if bytes.len() as u64 > MAX_BYTES {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temporary = parent.join(format!(".history-{}.tmp", uuid::Uuid::new_v4()));
    if fs::write(&temporary, bytes).is_ok() {
        let _ = fs::rename(&temporary, path);
    }
    let _ = fs::remove_file(temporary);
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn canonical_url(url: &str) -> String {
    url.trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase()
        .replace("git@github.com:", "https://github.com/")
        .replace("ssh://git@github.com/", "https://github.com/")
}

fn read_local(
    root: &Path,
    channel: UpdateChannel,
    limit: usize,
) -> Option<(Vec<CommitMetadata>, Option<String>, bool, bool)> {
    if root.as_os_str().is_empty() {
        return None;
    }
    let repo = git2::Repository::open_ext(
        root,
        git2::RepositoryOpenFlags::NO_SEARCH,
        std::iter::empty::<&Path>(),
    )
    .ok()?;
    let source = match channel {
        UpdateChannel::Stable => &constants::MAIN_REPO_SRC,
        UpdateChannel::Dev => &constants::MAIN_REPO_SRC_DEV,
    };
    let config = repo.config().ok()?;
    let delivery = config.get_string("baas.deliveryRepository").ok();
    let origin = repo
        .find_remote("origin")
        .ok()
        .and_then(|remote| remote.url().ok().map(str::to_string));
    let identity = delivery.or(origin)?;
    if !std::iter::once(source.main)
        .chain(source.proxy.iter().copied())
        .any(|url| canonical_url(url) == canonical_url(&identity))
    {
        return None;
    }
    let head_ref = repo.head().ok()?;
    let delivery_ref = config.get_string("baas.deliveryRef").ok();
    if head_ref.is_branch() {
        if head_ref.shorthand().ok() != Some("master") {
            return None;
        }
    } else if delivery_ref.as_deref() != Some("master") {
        // Detached feature/tag tips do not establish the selected branch's identity.
        return None;
    }
    if delivery_ref.is_some_and(|reference| reference != "master") {
        return None;
    }
    let head = head_ref.peel_to_commit().ok()?.id();
    let mut walk = repo.revwalk().ok()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .ok()?;
    walk.push(head).ok()?;
    let mut rows = Vec::new();
    let mut incomplete = repo.is_shallow();
    for oid in walk.take(limit + 1) {
        let commit = oid.and_then(|oid| repo.find_commit(oid));
        let Ok(commit) = commit else {
            incomplete = true;
            break;
        };
        let author = commit.author();
        let Some(row) = metadata(
            &commit.id().to_string(),
            author.name().unwrap_or_default(),
            commit.message().unwrap_or_default(),
        ) else {
            incomplete = true;
            continue;
        };
        rows.push(row);
    }
    let more = rows.len() > limit;
    rows.truncate(limit);
    Some((rows, Some(head.to_string()), incomplete, more))
}

/// Desktop HTTP boundary. Only the fixed GitHub URL generated above reaches it.
#[cfg(not(target_os = "android"))]
pub fn fetch_github(url: &str) -> Result<HistoryHttpResponse, HistoryIssue> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("BAAS-commit-history")
        .build()
        .map_err(|_| HistoryIssue::Offline)?;
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|_| HistoryIssue::Offline)?;
    let status = response.status().as_u16();
    let has_more = response
        .headers()
        .get("Link")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("rel=\"next\""));
    let mut body = Vec::new();
    response
        .take(MAX_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| HistoryIssue::Offline)?;
    Ok(HistoryHttpResponse {
        status,
        body,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, collections::BTreeMap, path::PathBuf};
    use tempfile::TempDir;

    fn entry(number: usize) -> CommitMetadata {
        CommitMetadata {
            hash: format!("{number:040x}"),
            author: "作者".into(),
            message: format!("Subject {number}"),
        }
    }
    fn offline(_: &str) -> Result<HistoryHttpResponse, HistoryIssue> {
        Err(HistoryIssue::Offline)
    }
    fn response(rows: &[CommitMetadata], has_more: bool) -> HistoryHttpResponse {
        HistoryHttpResponse { status: 200, has_more, body: serde_json::to_vec(&rows.iter().map(|row|
            serde_json::json!({"sha":row.hash,"commit":{"author":{"name":row.author,"email":"private@example.test"},"message":format!("{}\n\nPrivate body", row.message)},"files":[{"patch":"must never persist"}]})).collect::<Vec<_>>()).unwrap() }
    }
    fn manifest(root: &Path, repo: &str, rows: Vec<CommitMetadata>) {
        fs::write(
            root.join(MANIFEST_NAME),
            serde_json::to_vec(&Manifest {
                schema: 1,
                repository: repo.into(),
                reference: "master".into(),
                entries: rows,
                fetched_at: 0,
                has_more: false,
                partial: false,
            })
            .unwrap(),
        )
        .unwrap();
    }
    fn snapshot(path: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut result = BTreeMap::new();
        for child in fs::read_dir(path).unwrap() {
            let child = child.unwrap().path();
            if child.is_dir() {
                result.extend(snapshot(&child));
            } else {
                result.insert(child.clone(), fs::read(child).unwrap());
            }
        }
        result
    }
    fn local_repo(root: &Path, channel: UpdateChannel) -> git2::Repository {
        let repo = git2::Repository::init(root).unwrap();
        repo.remote(
            "origin",
            &format!("https://github.com/{}.git", repository(channel)),
        )
        .unwrap();
        let tree = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree).unwrap();
        let signature = git2::Signature::now("Local Author", "private@example.test").unwrap();
        let commit = repo
            .commit(
                Some("refs/heads/master"),
                &signature,
                &signature,
                "First subject\n\nPrivate body",
                &tree,
                &[],
            )
            .unwrap();
        repo.set_head("refs/heads/master").unwrap();
        drop(tree);
        assert_eq!(repo.head().unwrap().target(), Some(commit));
        repo
    }

    #[test]
    fn api_cache_only_keeps_three_metadata_fields_and_uses_ttl() {
        let temp = TempDir::new().unwrap();
        let rows = vec![entry(1), entry(2)];
        let report = get_commit_history(
            temp.path(),
            &temp.path().join("cache"),
            UpdateChannel::Dev,
            None,
            &HistoryRequest::default(),
            |url| {
                assert_eq!(
                    url,
                    "https://api.github.com/repos/Kiramei/baas-dev/commits?sha=master&per_page=100&page=1"
                );
                Ok(response(&rows, false))
            },
        );
        assert_eq!(report.entries, rows);
        assert_eq!(report.source, "github");
        let bytes = fs::read(temp.path().join("cache/dev-master.json")).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        for excluded in ["private@example.test", "Private body", "patch", "files"] {
            assert!(!text.contains(excluded));
        }
        let stored: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(stored["entries"][0].as_object().unwrap().len(), 3);
        let cached = get_commit_history(
            temp.path(),
            &temp.path().join("cache"),
            UpdateChannel::Dev,
            None,
            &HistoryRequest::default(),
            |_| panic!("fresh metadata must not refetch"),
        );
        assert_eq!(cached.source, "cache");
        assert!(!cached.stale);
    }

    #[test]
    fn shallow_local_history_does_not_modify_any_git_file() {
        let temp = TempDir::new().unwrap();
        let repo = local_repo(temp.path(), UpdateChannel::Dev);
        let head = repo.head().unwrap().target().unwrap().to_string();
        fs::write(repo.path().join("shallow"), format!("{head}\n")).unwrap();
        let before = snapshot(repo.path());
        let report = get_commit_history(
            temp.path(),
            &temp.path().join("cache"),
            UpdateChannel::Dev,
            None,
            &HistoryRequest::default(),
            offline,
        );
        assert_eq!(report.source, "local");
        assert!(report.partial);
        assert_eq!(report.current.as_deref(), Some(head.as_str()));
        assert_eq!(report.entries[0].message, "First subject");
        assert_eq!(before, snapshot(repo.path()));
    }

    #[test]
    fn does_not_read_a_parent_checkout_or_other_channel() {
        let temp = TempDir::new().unwrap();
        local_repo(temp.path(), UpdateChannel::Dev);
        let child = temp.path().join("not-a-checkout");
        fs::create_dir(&child).unwrap();
        for (root, channel) in [
            (child.as_path(), UpdateChannel::Dev),
            (temp.path(), UpdateChannel::Stable),
        ] {
            let report = get_commit_history(
                root,
                &temp.path().join("cache"),
                channel,
                None,
                &HistoryRequest::default(),
                offline,
            );
            assert!(report.entries.is_empty());
            assert!(report.current.is_none());
        }
    }

    #[test]
    fn gitless_bundle_supports_offline_and_rejects_wrong_scope_or_extra_fields() {
        let temp = TempDir::new().unwrap();
        manifest(temp.path(), repository(UpdateChannel::Dev), vec![entry(1)]);
        let load = |channel| {
            get_commit_history(
                temp.path(),
                &temp.path().join("cache"),
                channel,
                None,
                &HistoryRequest::default(),
                offline,
            )
        };
        let bundled = load(UpdateChannel::Dev);
        assert_eq!(bundled.source, "bundle");
        assert!(bundled.partial && bundled.stale);
        assert!(load(UpdateChannel::Stable).entries.is_empty());
        let path = temp.path().join(MANIFEST_NAME);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["entries"][0]["patch"] = "rejected".into();
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(load(UpdateChannel::Dev).entries.is_empty());
    }

    #[test]
    fn bounded_pagination_and_load_more_fetches_missing_rows() {
        let temp = TempDir::new().unwrap();
        let calls = Cell::new(0);
        let request = HistoryRequest {
            limit: Some(150),
            ..HistoryRequest::default()
        };
        let report = get_commit_history(
            temp.path(),
            &temp.path().join("cache"),
            UpdateChannel::Dev,
            None,
            &request,
            |_| {
                let page = calls.get();
                calls.set(page + 1);
                Ok(response(
                    &(page * 100..page * 100 + 100)
                        .map(entry)
                        .collect::<Vec<_>>(),
                    true,
                ))
            },
        );
        assert_eq!(calls.get(), 2);
        assert_eq!(report.entries.len(), 150);
        assert!(report.has_more);
        let report = get_commit_history(
            temp.path(),
            &temp.path().join("cache"),
            UpdateChannel::Dev,
            None,
            &HistoryRequest {
                limit: Some(99999),
                ..HistoryRequest::default()
            },
            |_| {
                let page = calls.get();
                calls.set(page + 1);
                Ok(response(
                    &(page * 100..page * 100 + 100)
                        .map(entry)
                        .collect::<Vec<_>>(),
                    true,
                ))
            },
        );
        assert_eq!(calls.get(), 7);
        assert_eq!(report.entries.len(), MAX_ENTRIES);
        let stored: Manifest =
            serde_json::from_slice(&fs::read(temp.path().join("cache/dev-master.json")).unwrap())
                .unwrap();
        assert_eq!(stored.entries.len(), MAX_ENTRIES);
    }

    #[test]
    fn rate_limit_falls_back_to_cache_and_refresh_cannot_destroy_it() {
        let temp = TempDir::new().unwrap();
        let cache = temp.path().join("cache");
        get_commit_history(
            temp.path(),
            &cache,
            UpdateChannel::Dev,
            None,
            &HistoryRequest::default(),
            |_| Ok(response(&[entry(1)], false)),
        );
        let before = fs::read(cache.join("dev-master.json")).unwrap();
        let report = get_commit_history(
            temp.path(),
            &cache,
            UpdateChannel::Dev,
            None,
            &HistoryRequest {
                refresh: true,
                ..HistoryRequest::default()
            },
            |_| {
                Ok(HistoryHttpResponse {
                    status: 429,
                    body: vec![],
                    has_more: false,
                })
            },
        );
        assert_eq!(report.entries, vec![entry(1)]);
        assert_eq!(report.issue, Some(HistoryIssue::RateLimited));
        assert!(report.stale);
        assert_eq!(before, fs::read(cache.join("dev-master.json")).unwrap());
    }

    #[test]
    fn malformed_or_oversized_cache_is_ignored_and_git_cache_is_rejected() {
        let temp = TempDir::new().unwrap();
        let cache = temp.path().join("cache");
        fs::create_dir(&cache).unwrap();
        for bytes in [b"not JSON".to_vec(), vec![b' '; MAX_BYTES as usize + 1]] {
            fs::write(cache.join("dev-master.json"), bytes).unwrap();
            let report = get_commit_history(
                temp.path(),
                &cache,
                UpdateChannel::Dev,
                None,
                &HistoryRequest::default(),
                offline,
            );
            assert!(report.entries.is_empty());
        }
        let forbidden = temp.path().join(".git/history");
        get_commit_history(
            temp.path(),
            &forbidden,
            UpdateChannel::Dev,
            None,
            &HistoryRequest::default(),
            |_| Ok(response(&[entry(1)], false)),
        );
        assert!(!forbidden.exists());
    }

    #[test]
    fn partial_api_page_survives_later_timeout_without_becoming_complete_cache() {
        let temp = TempDir::new().unwrap();
        let calls = Cell::new(0);
        let report = get_commit_history(
            temp.path(),
            &temp.path().join("cache"),
            UpdateChannel::Dev,
            None,
            &HistoryRequest {
                limit: Some(200),
                ..HistoryRequest::default()
            },
            |_| {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Ok(response(&(0..100).map(entry).collect::<Vec<_>>(), true))
                } else {
                    Err(HistoryIssue::Offline)
                }
            },
        );
        assert_eq!(report.entries.len(), 100);
        assert!(report.partial && report.has_more);
        assert_eq!(report.issue, Some(HistoryIssue::Offline));
        let stored: Manifest =
            serde_json::from_slice(&fs::read(temp.path().join("cache/dev-master.json")).unwrap())
                .unwrap();
        assert!(stored.partial && stored.has_more);
        let cached = get_commit_history(
            temp.path(),
            &temp.path().join("cache"),
            UpdateChannel::Dev,
            None,
            &HistoryRequest::default(),
            offline,
        );
        assert_eq!(cached.source, "cache");
        assert!(cached.partial && cached.stale);
    }

    #[test]
    fn rejects_local_history_from_another_branch() {
        let temp = TempDir::new().unwrap();
        let repo = local_repo(temp.path(), UpdateChannel::Dev);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        let report = get_commit_history(
            temp.path(),
            &temp.path().join("cache"),
            UpdateChannel::Dev,
            None,
            &HistoryRequest::default(),
            offline,
        );
        assert!(report.entries.is_empty());
        assert!(report.current.is_none());
    }

    #[test]
    fn newer_partial_page_invalidates_a_larger_fresh_cache() {
        let temp = TempDir::new().unwrap();
        let cache = temp.path().join("cache");
        let calls = Cell::new(0);
        let mut request = HistoryRequest {
            limit: Some(500),
            ..HistoryRequest::default()
        };
        get_commit_history(
            temp.path(),
            &cache,
            UpdateChannel::Dev,
            None,
            &request,
            |_| {
                let page = calls.get();
                calls.set(page + 1);
                Ok(response(
                    &(page * 100..page * 100 + 100)
                        .map(entry)
                        .collect::<Vec<_>>(),
                    true,
                ))
            },
        );
        calls.set(0);
        request.refresh = true;
        let report = get_commit_history(
            temp.path(),
            &cache,
            UpdateChannel::Dev,
            None,
            &request,
            |_| {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Ok(response(&(1000..1100).map(entry).collect::<Vec<_>>(), true))
                } else {
                    Err(HistoryIssue::Offline)
                }
            },
        );
        assert_eq!(report.entries.first().unwrap().hash, entry(1000).hash);
        assert_eq!(report.entries.len(), 100);
        assert!(report.partial);
        let stored: Manifest =
            serde_json::from_slice(&fs::read(cache.join("dev-master.json")).unwrap()).unwrap();
        assert_eq!(stored.entries.len(), 500);
        assert!(stored.partial);
        calls.set(0);
        get_commit_history(
            temp.path(),
            &cache,
            UpdateChannel::Dev,
            None,
            &HistoryRequest::default(),
            |_| {
                calls.set(calls.get() + 1);
                Err(HistoryIssue::Offline)
            },
        );
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn accepts_valid_empty_commit_subject() {
        let temp = TempDir::new().unwrap();
        let row = CommitMetadata {
            message: String::new(),
            ..entry(1)
        };
        let report = get_commit_history(
            temp.path(),
            &temp.path().join("cache"),
            UpdateChannel::Dev,
            None,
            &HistoryRequest::default(),
            |_| Ok(response(&[row.clone()], false)),
        );
        assert_eq!(report.entries, vec![row]);
        assert!(report.issue.is_none());
    }

    #[test]
    fn detached_history_requires_a_recorded_master_delivery() {
        let temp = TempDir::new().unwrap();
        let repo = local_repo(temp.path(), UpdateChannel::Dev);
        let head = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(head).unwrap();
        let load = || {
            get_commit_history(
                temp.path(),
                &temp.path().join("cache"),
                UpdateChannel::Dev,
                None,
                &HistoryRequest::default(),
                offline,
            )
        };
        assert!(load().entries.is_empty());
        repo.config()
            .unwrap()
            .set_str("baas.deliveryRef", "master")
            .unwrap();
        assert_eq!(load().entries.len(), 1);
    }

    #[test]
    fn missing_api_fields_are_unavailable_rather_than_fabricated() {
        let bytes = serde_json::to_vec(&serde_json::json!([{"sha":entry(1).hash}])).unwrap();
        assert_eq!(parse_github(&bytes), Err(HistoryIssue::Unavailable));
        assert_eq!(metadata(&entry(1).hash, "", "").unwrap().author, "Unknown");
    }

    #[test]
    fn malformed_api_does_not_persist_untrusted_fields() {
        let temp = TempDir::new().unwrap();
        let report = get_commit_history(
            temp.path(),
            &temp.path().join("cache"),
            UpdateChannel::Dev,
            Some("invalid".into()),
            &HistoryRequest::default(),
            |_| {
                Ok(HistoryHttpResponse {
                    status: 200,
                    body:
                        br#"[{"sha":"not-a-hash","commit":{"author":{"name":"x"},"message":"x"}}]"#
                            .to_vec(),
                    has_more: false,
                })
            },
        );
        assert!(report.entries.is_empty());
        assert!(report.current.is_none());
        assert_eq!(report.issue, Some(HistoryIssue::Unavailable));
        assert!(!temp.path().join("cache/dev-master.json").exists());
    }
}
