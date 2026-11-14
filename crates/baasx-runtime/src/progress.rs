//! Convert the shared desktop terminal workflow into bounded, repaintable task events.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replace: Option<bool>,
}

impl Progress {
    pub fn new(task: &str, message: impl Into<String>) -> Self {
        Self {
            stage: phase(task).into(),
            task_id: Some(task.into()),
            message: message.into(),
            ..Self::default()
        }
    }

    pub fn status(task: &str, message: impl Into<String>, status: &str) -> Self {
        let mut event = Self::new(task, message);
        event.status = Some(status.into());
        if status == "complete" {
            event.percent = Some(100);
        }
        event
    }
}

fn phase(task: &str) -> &str {
    match task {
        "updater-config" => "configuration",
        "main-repository" => "backend",
        "cpp-repository" => "ocr",
        "git-record-sha" => "versions",
        "uv-install" => "uv",
        "cpython-source-ranking" => "python-source",
        "uv-python-install" => "python",
        "uv-venv" => "virtual-environment",
        "uv-requirements" | "uv-compile" => "dependency-lock",
        "pypi-source-ranking" => "dependency-source",
        "uv-sync" | "dependencies" => "dependencies",
        "uv-cache-clean" => "cache",
        "launch-backend" => "launch",
        other => other,
    }
}

#[derive(Default)]
enum Escape {
    #[default]
    Text,
    Start,
    Csi,
    String,
    StringEscape,
}

/// One task owns one live line. UTF-8, CSI and OSC sequences may span chunks.
#[derive(Default)]
pub(crate) struct TaskOutput {
    pending: Vec<u8>,
    escape: Escape,
    line: String,
    repaint: bool,
    after_cr: bool,
    cr_line: Option<(String, bool)>,
    last_live: String,
}

impl TaskOutput {
    pub fn feed(&mut self, task: &str, bytes: &[u8]) -> Vec<Progress> {
        self.pending.extend_from_slice(bytes);
        let mut decoded = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    decoded.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    decoded.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    self.pending.drain(..valid);
                    if let Some(length) = error.error_len() {
                        self.pending.drain(..length);
                        decoded.push('\u{fffd}');
                    } else {
                        break;
                    }
                }
            }
        }
        let mut events = Vec::new();
        for ch in decoded.chars() {
            match self.escape {
                Escape::Start => {
                    self.escape = match ch {
                        '[' => Escape::Csi,
                        ']' | 'P' | '^' | '_' => Escape::String,
                        _ => Escape::Text,
                    };
                    continue;
                }
                Escape::Csi => {
                    if ('@'..='~').contains(&ch) {
                        if matches!(ch, 'K' | 'J' | 'F' | 'A' | 'G' | 'H') {
                            self.repaint = true;
                            self.line.clear();
                        }
                        self.escape = Escape::Text;
                    }
                    continue;
                }
                Escape::String => {
                    if ch == '\u{7}' || ch == '\u{9c}' {
                        self.escape = Escape::Text;
                    } else if ch == '\u{1b}' {
                        self.escape = Escape::StringEscape;
                    }
                    continue;
                }
                Escape::StringEscape => {
                    self.escape = if ch == '\\' || ch == '\u{7}' || ch == '\u{9c}' {
                        Escape::Text
                    } else {
                        Escape::String
                    };
                    continue;
                }
                Escape::Text => {}
            }
            match ch {
                '\u{1b}' => self.escape = Escape::Start,
                '\r' => {
                    if let Some((previous, _)) = self.cr_line.take() {
                        self.line = previous;
                        self.push(task, true, &mut events);
                    }
                    self.cr_line = Some((self.line.clone(), self.repaint));
                    self.line.clear();
                    self.repaint = true;
                    self.after_cr = true;
                }
                '\n' => {
                    if let Some((previous, repaint)) = self.cr_line.take() {
                        self.line = previous;
                        self.push(task, repaint, &mut events);
                    } else if !self.after_cr {
                        self.push(task, self.repaint, &mut events);
                    }
                    self.line.clear();
                    self.repaint = false;
                    self.after_cr = false;
                    self.last_live.clear();
                }
                '\u{8}' => {
                    self.line.pop();
                    self.repaint = true;
                }
                value if !value.is_control() || value == '\t' => {
                    if let Some((previous, _)) = self.cr_line.take() {
                        self.line = previous;
                        self.push(task, true, &mut events);
                        self.line.clear();
                    }
                    self.after_cr = false;
                    if self.line.len() < 8192 {
                        self.line.push(value);
                    }
                }
                _ => {}
            }
        }
        if let Some((previous, _)) = &self.cr_line {
            self.line = previous.clone();
            self.push(task, true, &mut events);
            self.line.clear();
        } else {
            self.push(task, true, &mut events);
        }
        events
    }

    fn push(&mut self, task: &str, replace: bool, events: &mut Vec<Progress>) {
        let text = self.line.trim();
        if text.is_empty() || (replace && text == self.last_live) {
            return;
        }
        let mut event = Progress::new(task, text);
        event.status = Some("running".into());
        event.current_line = Some(text.into());
        metrics(&mut event);
        event.replace = Some(replace || event.percent.is_some());
        if event.replace == Some(true) {
            self.last_live = text.into();
        }
        events.push(event);
    }
}

fn metrics(event: &mut Progress) {
    let text = &event.message;
    if let Some(index) = text.find('%') {
        let digits: String = text[..index]
            .chars()
            .rev()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        event.percent = digits.parse::<u8>().ok().filter(|value| *value <= 100);
    }
    for (index, ch) in text.char_indices() {
        if ch != '/' {
            continue;
        }
        let left: String = text[..index]
            .trim_end()
            .chars()
            .rev()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        let right: String = text[index + 1..]
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let (Ok(current), Ok(total)) = (left.parse::<u64>(), right.parse::<u64>()) else {
            continue;
        };
        if total == 0 || current > total {
            continue;
        }
        event.current = Some(current);
        event.total = Some(total);
        let lower = text.to_ascii_lowercase();
        let unit = if lower.contains("objects") || lower.contains("git2 transfer") {
            "objects"
        } else if event.stage == "uv"
            || lower.contains("download")
            || lower.contains("kib")
            || lower.contains("mib")
            || lower.contains("gib")
        {
            "bytes"
        } else {
            "items"
        };
        event.unit = Some(unit.into());
        if unit == "bytes" {
            event.downloaded_bytes = Some(current);
            event.total_bytes = Some(total);
        }
        if event.percent.is_none() {
            event.percent = Some(((current as u128 * 100) / total as u128) as u8);
        }
        break;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carriage_return_repaints_the_same_task_and_exposes_real_metrics() {
        let mut output = TaskOutput::default();
        let events = output.feed(
            "uv-install",
            b"asset  25%  25/100\r\x1b[2Kasset  50%  50/100",
        );
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|event| event.replace == Some(true)));
        assert!(
            events
                .iter()
                .all(|event| event.task_id.as_deref() == Some("uv-install"))
        );
        assert_eq!(events[1].stage, "uv");
        assert_eq!(events[1].percent, Some(50));
        assert_eq!(events[1].downloaded_bytes, Some(50));
        assert_eq!(events[1].total_bytes, Some(100));
    }

    #[test]
    fn split_utf8_and_terminal_strings_are_not_exposed() {
        let mut output = TaskOutput::default();
        let bytes = "中文进度".as_bytes();
        assert!(output.feed("uv-sync", &bytes[..1]).is_empty());
        let event = output.feed("uv-sync", &bytes[1..]).pop().unwrap();
        assert_eq!(event.message, "中文进度");
        let events = output.feed("uv-sync", b"\r\x1b]52;c;clipboard-secret\x07ok\n");
        assert!(events.iter().all(|event| !event.message.contains("secret")));
        assert_eq!(events.last().unwrap().message, "ok");
    }

    #[test]
    fn normal_lines_commit_once_and_git_objects_are_not_bytes() {
        let mut output = TaskOutput::default();
        let events = output.feed(
            "main-repository",
            b"Receiving objects: 40% (20/50)\rready\r\n",
        );
        assert_eq!(events[0].unit.as_deref(), Some("objects"));
        assert_eq!(events[0].percent, Some(40));
        assert_eq!(events[0].current, Some(20));
        assert_eq!(events[0].downloaded_bytes, None);
        assert_eq!(
            events
                .iter()
                .filter(|event| event.message == "ready")
                .count(),
            1
        );
        let events = output.feed("main-repository", b"one\ntwo\n");
        assert!(events.iter().all(|event| event.replace == Some(false)));
        let events = output.feed("main-repository", b"normal Windows newline\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].replace, Some(false));
    }
}
