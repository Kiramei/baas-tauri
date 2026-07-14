use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
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

    fn append(&self, mut entry: SystemLogEntry) {
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

        if let Ok(mut entries) = self.inner.entries.lock() {
            entries.push_back(entry.clone());
            while entries.len() > MAX_MEMORY_ENTRIES {
                entries.pop_front();
            }
        }
        let _ = append_to_file(&self.inner.path, &entry);
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
pub fn system_logs_snapshot(
    request: Option<SystemLogSnapshotRequest>,
    state: State<'_, SystemLogState>,
) -> SystemLogSnapshot {
    state.snapshot(request.and_then(|value| value.limit).unwrap_or(4000))
}

#[tauri::command]
pub fn system_logs_clear(state: State<'_, SystemLogState>) -> Result<(), String> {
    state.clear()?;
    state.record("tauri", "INFO", "system_logs", "System logs cleared", None);
    Ok(())
}

#[tauri::command]
pub fn system_logs_ingest_frontend(
    request: FrontendLogBatch,
    state: State<'_, SystemLogState>,
) -> Result<(), String> {
    for entry in request.entries.into_iter().take(250) {
        state.append(SystemLogEntry {
            source: "frontend".to_string(),
            ..entry
        });
    }
    Ok(())
}

fn append_to_file(path: &Path, entry: &SystemLogEntry) -> Result<(), String> {
    if path.metadata().map(|metadata| metadata.len()).unwrap_or(0) >= MAX_FILE_BYTES {
        rotate_files(path)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut file, entry).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())
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
    use tempfile::tempdir;

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
}
