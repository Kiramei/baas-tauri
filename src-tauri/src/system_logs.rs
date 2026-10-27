use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const LOG_FILE_NAME: &str = "baas-tauri.jsonl";
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const BACKUP_COUNT: usize = 5;
const MAX_MEMORY_ENTRIES: usize = 5000;
const MAX_MESSAGE_CHARS: usize = 32_000;
const MAX_FRONTEND_BATCH_ENTRIES: usize = 250;

static GLOBAL_LOG_STATE: OnceLock<SystemLogState> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLogEntry {
    pub source: String,
    pub timestamp_ms: u64,
    pub level: String,
    pub target: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLogSnapshotRequest {
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogBatch {
    pub entries: Vec<SystemLogEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLogSnapshot {
    pub path: PathBuf,
    pub entries: Vec<SystemLogEntry>,
    pub file_size: u64,
}

#[derive(Clone)]
pub struct SystemLogState {
    inner: Arc<SystemLogInner>,
}

struct SystemLogInner {
    path: PathBuf,
    entries: Mutex<VecDeque<SystemLogEntry>>,
    writer: Mutex<()>,
    frontend_writer: Arc<tokio::sync::Semaphore>,
}

impl SystemLogState {
    fn new(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let entries = load_entries(&path, MAX_MEMORY_ENTRIES);
        Ok(Self {
            inner: Arc::new(SystemLogInner {
                path,
                entries: Mutex::new(entries),
                writer: Mutex::new(()),
                frontend_writer: Arc::new(tokio::sync::Semaphore::new(1)),
            }),
        })
    }

    pub fn record(
        &self,
        source: &str,
        level: &str,
        target: &str,
        message: impl Into<String>,
        details: Option<Value>,
    ) {
        let entry = SystemLogEntry {
            source: source.to_string(),
            timestamp_ms: now_ms(),
            level: normalize_level(level),
            target: target.to_string(),
            message: truncate(message.into(), MAX_MESSAGE_CHARS),
            details,
        };
        self.append(entry);
    }

    fn append(&self, entry: SystemLogEntry) {
        let _ = self.append_batch(vec![entry]);
    }

    fn append_batch(&self, batch: Vec<SystemLogEntry>) -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        let batch: Vec<_> = batch
            .into_iter()
            .map(|mut entry| {
                entry.source = if entry.source == "frontend" {
                    "frontend".to_string()
                } else {
                    "tauri".to_string()
                };
                entry.level = normalize_level(&entry.level);
                entry.message = truncate(entry.message, MAX_MESSAGE_CHARS);
                if entry.timestamp_ms == 0 {
                    entry.timestamp_ms = now_ms();
                }
                entry
            })
            .collect();

        // Serialize writers and rotation, not readers. Snapshot's memory lock
        // must never wait for the slow filesystem work below.
        let _writer = self
            .inner
            .writer
            .lock()
            .map_err(|_| "system log writer lock poisoned".to_string())?;
        {
            let mut entries = self
                .inner
                .entries
                .lock()
                .map_err(|_| "system log memory lock poisoned".to_string())?;
            entries.extend(batch.iter().cloned());
            if entries.len() > MAX_MEMORY_ENTRIES {
                let excess = entries.len() - MAX_MEMORY_ENTRIES;
                entries.drain(..excess);
            }
        }
        // Preserve the in-memory error record on failure and reject the IPC
        // batch so the existing bounded frontend buffer can retry it.
        append_to_file(&self.inner.path, &batch)
    }

    fn snapshot(&self, limit: usize) -> SystemLogSnapshot {
        let limit = limit.clamp(1, MAX_MEMORY_ENTRIES);
        let entries = self
            .inner
            .entries
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .skip(entries.len().saturating_sub(limit))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let file_size = self
            .inner
            .path
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        SystemLogSnapshot {
            path: self.inner.path.clone(),
            entries,
            file_size,
        }
    }

    fn clear(&self) -> Result<(), String> {
        let _writer = self
            .inner
            .writer
            .lock()
            .map_err(|_| "system log writer lock poisoned".to_string())?;
        if let Ok(mut entries) = self.inner.entries.lock() {
            entries.clear();
        }
        File::create(&self.inner.path).map_err(|error| error.to_string())?;
        for index in 1..=BACKUP_COUNT {
            let _ = fs::remove_file(rotated_path(&self.inner.path, index));
        }
        Ok(())
    }
}

pub fn initialize_system_logs(app: &AppHandle) -> Result<SystemLogState, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    let state = SystemLogState::new(log_dir.join(LOG_FILE_NAME))?;
    let _ = GLOBAL_LOG_STATE.set(state.clone());
    state.record(
        "tauri",
        "INFO",
        "lifecycle",
        format!(
            "Tauri system logging initialized version={} os={} arch={} debug={}",
            app.package_info().version,
            std::env::consts::OS,
            std::env::consts::ARCH,
            cfg!(debug_assertions)
        ),
        None,
    );
    Ok(state)
}

pub fn install_panic_logging() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        system_log("ERROR", "panic", info.to_string());
        previous(info);
    }));
}

pub fn system_log(level: &str, target: &str, message: impl Into<String>) {
    if let Some(state) = GLOBAL_LOG_STATE.get() {
        state.record("tauri", level, target, message, None);
    }
}

#[tauri::command]
pub async fn system_logs_snapshot(
    request: Option<SystemLogSnapshotRequest>,
    state: State<'_, SystemLogState>,
) -> Result<SystemLogSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.snapshot(request.and_then(|value| value.limit).unwrap_or(4000))
    })
    .await
    .map_err(|error| format!("system log snapshot task failed: {error}"))
}

#[tauri::command]
pub async fn system_logs_clear(state: State<'_, SystemLogState>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.clear()?;
        state.record("tauri", "INFO", "system_logs", "System logs cleared", None);
        Ok(())
    })
    .await
    .map_err(|error| format!("system log clear task failed: {error}"))?
}

#[tauri::command]
pub async fn system_logs_ingest_frontend(
    request: FrontendLogBatch,
    state: State<'_, SystemLogState>,
) -> Result<(), String> {
    ingest_frontend_batch(state.inner().clone(), request).await
}

async fn ingest_frontend_batch(
    state: SystemLogState,
    request: FrontendLogBatch,
) -> Result<(), String> {
    if request.entries.len() > MAX_FRONTEND_BATCH_ENTRIES {
        return Err("frontend log batch exceeds 250 entries".to_string());
    }
    if request.entries.is_empty() {
        return Ok(());
    }
    // No fire-and-forget or unbounded writer queue. One batch is in flight;
    // callers get backpressure and retain their batch on any rejection.
    let permit = state
        .inner
        .frontend_writer
        .clone()
        .try_acquire_owned()
        .map_err(|_| "frontend log writer is busy; retry the batch".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        state.append_batch(
            request
                .entries
                .into_iter()
                .map(|entry| SystemLogEntry {
                    source: "frontend".to_string(),
                    ..entry
                })
                .collect(),
        )
    })
    .await
    .map_err(|error| format!("frontend log writer task failed: {error}"))?
}

fn append_to_file(path: &Path, entries: &[SystemLogEntry]) -> Result<(), String> {
    let mut length = path.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let mut writer: Option<BufWriter<File>> = None;
    for entry in entries {
        if length >= MAX_FILE_BYTES {
            // Close before rename for Windows, and flush only at rotation or
            // the end of the batch, rather than opening/flushing every line.
            if let Some(mut previous) = writer.take() {
                previous.flush().map_err(|error| error.to_string())?;
                drop(previous);
            }
            rotate_files(path)?;
            length = 0;
        }
        if writer.is_none() {
            writer = Some(BufWriter::with_capacity(
                64 * 1024,
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .map_err(|error| error.to_string())?,
            ));
        }
        let mut line = serde_json::to_vec(entry).map_err(|error| error.to_string())?;
        line.push(b'\n');
        writer
            .as_mut()
            .expect("opened log writer")
            .write_all(&line)
            .map_err(|error| error.to_string())?;
        length += line.len() as u64;
    }
    if let Some(mut writer) = writer {
        writer.flush().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn rotate_files(path: &Path) -> Result<(), String> {
    let _ = fs::remove_file(rotated_path(path, BACKUP_COUNT));
    for index in (1..BACKUP_COUNT).rev() {
        let source = rotated_path(path, index);
        if source.exists() {
            fs::rename(&source, rotated_path(path, index + 1))
                .map_err(|error| error.to_string())?;
        }
    }
    if path.exists() {
        fs::rename(path, rotated_path(path, 1)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn load_entries(path: &Path, limit: usize) -> VecDeque<SystemLogEntry> {
    let mut entries = VecDeque::with_capacity(limit);
    let paths = (1..=BACKUP_COUNT)
        .rev()
        .map(|index| rotated_path(path, index))
        .chain(std::iter::once(path.to_path_buf()));
    for candidate in paths {
        let Ok(file) = File::open(candidate) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(entry) = serde_json::from_str::<SystemLogEntry>(&line) else {
                continue;
            };
            entries.push_back(entry);
            while entries.len() > limit {
                entries.pop_front();
            }
        }
    }
    entries
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.display(), index))
}

fn normalize_level(level: &str) -> String {
    match level.trim().to_ascii_uppercase().as_str() {
        "TRACE" => "TRACE",
        "DEBUG" => "DEBUG",
        "WARN" | "WARNING" => "WARNING",
        "ERROR" | "CRITICAL" => "ERROR",
        _ => "INFO",
    }
    .to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn truncate(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    let mut truncated: String = value.chars().take(max_chars).collect();
    truncated.push_str("...<truncated>");
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use tempfile::tempdir;

    fn entry(message: impl Into<String>) -> SystemLogEntry {
        SystemLogEntry {
            source: "frontend".to_string(),
            timestamp_ms: 1,
            level: "error".to_string(),
            target: "window".to_string(),
            message: message.into(),
            details: None,
        }
    }

    #[test]
    fn persists_and_limits_entries() {
        let temp = tempdir().unwrap();
        let state = SystemLogState::new(temp.path().join("system.jsonl")).unwrap();
        state.record("tauri", "debug", "test", "first", None);
        state.record("tauri", "error", "test", "second", None);

        let snapshot = state.snapshot(1);
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].message, "second");

        let reloaded = SystemLogState::new(temp.path().join("system.jsonl")).unwrap();
        assert_eq!(reloaded.snapshot(10).entries.len(), 2);
    }

    #[test]
    fn frontend_source_is_preserved_but_other_sources_are_tauri() {
        let temp = tempdir().unwrap();
        let state = SystemLogState::new(temp.path().join("system.jsonl")).unwrap();
        state.append(SystemLogEntry {
            source: "frontend".to_string(),
            timestamp_ms: 1,
            level: "warn".to_string(),
            target: "window".to_string(),
            message: "frontend failure".to_string(),
            details: None,
        });
        assert_eq!(state.snapshot(10).entries[0].source, "frontend");
        assert_eq!(state.snapshot(10).entries[0].level, "WARNING");
    }

    #[tokio::test]
    async fn frontend_batch_keeps_normalization_and_reports_disk_errors() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("system.jsonl");
        let state = SystemLogState::new(path.clone()).unwrap();
        let mut record = entry("x".repeat(MAX_MESSAGE_CHARS + 2));
        record.source = "untrusted-source".to_string();
        record.timestamp_ms = 0;
        record.details = Some(serde_json::json!({"context":"retained"}));
        ingest_frontend_batch(
            state.clone(),
            FrontendLogBatch {
                entries: vec![record],
            },
        )
        .await
        .unwrap();
        let snapshot = state.snapshot(10);
        assert_eq!(snapshot.entries[0].source, "frontend");
        assert_eq!(snapshot.entries[0].level, "ERROR");
        assert_ne!(snapshot.entries[0].timestamp_ms, 0);
        assert!(snapshot.entries[0].message.ends_with("...<truncated>"));
        assert_eq!(
            snapshot.entries[0].details,
            Some(serde_json::json!({"context":"retained"}))
        );

        let failed_path = temp.path().join("not-a-file");
        let failed = SystemLogState::new(failed_path.clone()).unwrap();
        fs::create_dir(&failed_path).unwrap();
        assert!(ingest_frontend_batch(
            failed.clone(),
            FrontendLogBatch {
                entries: vec![entry("retain this error")]
            },
        )
        .await
        .is_err());
        assert_eq!(failed.snapshot(10).entries[0].message, "retain this error");
    }

    #[tokio::test]
    async fn frontend_writer_rejects_overload_without_a_background_queue() {
        let temp = tempdir().unwrap();
        let state = SystemLogState::new(temp.path().join("system.jsonl")).unwrap();
        let permit = state
            .inner
            .frontend_writer
            .clone()
            .try_acquire_owned()
            .unwrap();
        let batch = FrontendLogBatch {
            entries: vec![entry("retry this error")],
        };
        assert!(ingest_frontend_batch(state.clone(), batch.clone())
            .await
            .unwrap_err()
            .contains("busy"));
        assert!(state.snapshot(10).entries.is_empty());
        drop(permit);
        ingest_frontend_batch(state.clone(), batch).await.unwrap();
        assert_eq!(state.snapshot(10).entries[0].message, "retry this error");
        assert!(ingest_frontend_batch(
            state.clone(),
            FrontendLogBatch {
                entries: vec![entry("not silently truncated"); MAX_FRONTEND_BATCH_ENTRIES + 1]
            },
        )
        .await
        .unwrap_err()
        .contains("exceeds"));
        assert_eq!(state.snapshot(10).entries.len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn slow_log_io_does_not_block_async_dispatch_or_memory_snapshots() {
        let temp = tempdir().unwrap();
        let state = SystemLogState::new(temp.path().join("system.jsonl")).unwrap();
        let holder = state.clone();
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let _lock = holder.inner.writer.lock().unwrap();
            locked_tx.send(()).unwrap();
            // Fail safely rather than deadlocking if ingestion regresses to a
            // blocking call on the async dispatcher used by this test.
            let _ = release_rx.recv_timeout(Duration::from_secs(2));
        });
        locked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let pending_state = state.clone();
        let pending = tokio::spawn(async move {
            ingest_frontend_batch(
                pending_state,
                FrontendLogBatch {
                    entries: vec![entry("after slow IO")],
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while state.inner.frontend_writer.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("ingestion never yielded to the dispatcher");
        let started = Instant::now();
        assert!(state.snapshot(10).entries.is_empty());
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(
            !pending.is_finished(),
            "writer did not wait for the IO lock"
        );
        release_tx.send(()).unwrap();
        pending.await.unwrap().unwrap();
        thread.join().unwrap();
        assert_eq!(state.snapshot(10).entries[0].message, "after slow IO");
    }

    #[test]
    fn batches_bound_memory_and_preserve_disk_order_across_concurrent_writers() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("system.jsonl");
        let state = SystemLogState::new(path.clone()).unwrap();
        state
            .append_batch(
                (0..MAX_MEMORY_ENTRIES + 3)
                    .map(|index| entry(format!("initial-{index}")))
                    .collect(),
            )
            .unwrap();
        let snapshot = state.snapshot(MAX_MEMORY_ENTRIES);
        assert_eq!(snapshot.entries.len(), MAX_MEMORY_ENTRIES);
        assert_eq!(snapshot.entries[0].message, "initial-3");
        state.clear().unwrap();

        let threads: Vec<_> = (0..4)
            .map(|batch| {
                let writer = state.clone();
                std::thread::spawn(move || {
                    writer
                        .append_batch(
                            (0..20)
                                .map(|index| entry(format!("batch-{batch}-{index}")))
                                .collect(),
                        )
                        .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let in_memory: Vec<_> = state
            .snapshot(100)
            .entries
            .into_iter()
            .map(|entry| entry.message)
            .collect();
        let on_disk: Vec<_> = load_entries(&path, 100)
            .into_iter()
            .map(|entry| entry.message)
            .collect();
        assert_eq!(in_memory, on_disk);
        assert_eq!(on_disk.len(), 80);
        for chunk in on_disk.chunks_exact(20) {
            let batch = chunk[0].rsplit_once('-').unwrap().0;
            for (index, message) in chunk.iter().enumerate() {
                assert_eq!(message, &format!("{batch}-{index}"));
            }
        }
    }

    #[test]
    fn a_batch_rotates_at_the_original_entry_boundary_without_losing_lines() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("system.jsonl");
        let state = SystemLogState::new(path.clone()).unwrap();
        let mut old = vec![b' '; MAX_FILE_BYTES as usize - 1];
        *old.last_mut().unwrap() = b'\n';
        fs::write(&path, old).unwrap();
        for index in 1..=BACKUP_COUNT {
            fs::write(rotated_path(&path, index), format!("old-{index}\n")).unwrap();
        }
        state
            .append_batch(vec![entry("first"), entry("second"), entry("third")])
            .unwrap();
        assert!(fs::metadata(rotated_path(&path, 1)).unwrap().len() >= MAX_FILE_BYTES);
        assert_eq!(
            fs::read_to_string(rotated_path(&path, BACKUP_COUNT)).unwrap(),
            "old-4\n"
        );
        let reloaded: Vec<_> = load_entries(&path, 10)
            .into_iter()
            .map(|entry| entry.message)
            .collect();
        assert_eq!(reloaded, ["first", "second", "third"]);
    }
}
