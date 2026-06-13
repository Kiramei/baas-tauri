//! Terminal-dashboard renderer.
//!
//! The renderer consumes task events, maintains per-region terminal buffers,
//! clips output to the configured viewport, and emits Tauri events containing
//! rendered dashboard snapshots.

use crate::constants::{
    ANSI_DASHBOARD_RESET, ANSI_RESET, EVENT_TERM_CHUNK, EVENT_TERM_SESSION_FINISHED,
    EVENT_TERM_TASK_STARTED, EVENT_TERM_TASK_STATUS, EVENT_TERM_WORKFLOW_PLANNED,
    EVENT_UPDATER_BACKEND_READY, MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS, REGION_MAX_KEPT_LINES,
    RUNNING_REGION_MAX_LINES, STATUS_RUNNING, TAB_WIDTH,
};
use crate::types::{
    BackendReadyPayload, DashboardLogPayload, RendererEvent, SessionFinishedPayload, TaskSpec,
    TaskStartedPayload, TaskStatusPayload, WorkflowPlannedPayload,
};
use chrono::{DateTime, Utc};
use std::{
    collections::{HashMap, HashSet},
    sync::mpsc::{Receiver, RecvTimeoutError},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

fn is_csi_final(ch: char) -> bool {
    matches!(ch, '\u{40}'..='\u{7e}')
}

fn csi_param(params: &str, index: usize, default: usize) -> usize {
    let cleaned = params
        .trim_start_matches('?')
        .split(';')
        .nth(index)
        .unwrap_or_default();

    if cleaned.is_empty() {
        return default;
    }

    cleaned.parse::<usize>().unwrap_or(default)
}

fn fit_ansi_line(line: &str, cols: usize) -> String {
    let mut fitted = truncate_ansi_line_to_visible_width(line, cols);
    fitted.push_str(ANSI_RESET);
    fitted
}

fn visible_width(text: &str) -> usize {
    let mut width = 0;
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            consume_ansi_sequence(&mut chars);
        } else {
            width += 1;
        }
    }

    width
}

fn truncate_ansi_line_to_visible_width(text: &str, max_width: usize) -> String {
    let mut output = String::new();
    let mut width = 0;
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            output.push(ch);
            collect_ansi_sequence(&mut chars, &mut output);
            continue;
        }

        if width >= max_width {
            break;
        }

        output.push(ch);
        width += 1;
    }

    output
}

fn ansi_line_suffix_from_visible_width(text: &str, start_width: usize) -> String {
    let mut output = String::new();
    let mut width = 0;
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            consume_ansi_sequence(&mut chars);
            continue;
        }

        if width >= start_width {
            output.push(ch);
        }

        width += 1;
    }

    output
}

fn consume_ansi_sequence<I>(chars: &mut std::iter::Peekable<I>)
where
    I: Iterator<Item = char>,
{
    let Some(ch) = chars.next() else {
        return;
    };

    match ch {
        '[' => {
            for ch in chars.by_ref() {
                if is_csi_final(ch) {
                    break;
                }
            }
        }
        ']' => {
            let mut saw_esc = false;
            for ch in chars.by_ref() {
                if ch == '\u{7}' {
                    break;
                }
                if saw_esc && ch == '\\' {
                    break;
                }
                saw_esc = ch == '\x1b';
            }
        }
        _ => {}
    }
}

fn collect_ansi_sequence<I>(chars: &mut std::iter::Peekable<I>, output: &mut String)
where
    I: Iterator<Item = char>,
{
    let Some(ch) = chars.next() else {
        return;
    };

    output.push(ch);

    match ch {
        '[' => {
            for ch in chars.by_ref() {
                output.push(ch);
                if is_csi_final(ch) {
                    break;
                }
            }
        }
        ']' => {
            let mut saw_esc = false;
            for ch in chars.by_ref() {
                output.push(ch);
                if ch == '\u{7}' {
                    break;
                }
                if saw_esc && ch == '\\' {
                    break;
                }
                saw_esc = ch == '\x1b';
            }
        }
        _ => {}
    }
}

fn emit_dashboard_chunk(app: &AppHandle, session_id: &str, pending_chunk: &mut String) {
    if pending_chunk.is_empty() {
        return;
    }
    let chunk = std::mem::take(pending_chunk);
    let _ = app.emit(
        EVENT_TERM_CHUNK,
        DashboardLogPayload {
            session_id: session_id.to_string(),
            chunk,
        },
    );
}

/// Runs the renderer event loop for a single session.
///
/// The loop receives [`RendererEvent`] values, updates the in-memory dashboard,
/// and emits serialized Tauri events such as `"term:chunk"` and
/// `"term:task-status"`. It exits when the session finishes, the sender closes,
/// or a shutdown event is received.
pub fn renderer_loop(
    app: AppHandle,
    session_id: String,
    rx: Receiver<RendererEvent>,
    rows: u16,
    cols: u16,
) {
    let mut renderer = SessionRenderer::new(rows, cols);
    let mut task_started_at = HashMap::<String, DateTime<Utc>>::new();
    let mut pending_chunk = String::new();

    loop {
        let event = if pending_chunk.is_empty() {
            match rx.recv() {
                Ok(event) => event,
                Err(_) => break,
            }
        } else {
            match rx.recv_timeout(Duration::from_millis(16)) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) => {
                    emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        };
        match event {
            RendererEvent::WorkflowPlanned(plan) => {
                emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                let _ = app.emit(
                    EVENT_TERM_WORKFLOW_PLANNED,
                    WorkflowPlannedPayload {
                        session_id: session_id.clone(),
                        nodes: plan.nodes,
                        edges: plan.edges,
                    },
                );
            }
            RendererEvent::BufferRegions { region_ids } => {
                renderer.buffer_regions(region_ids);
            }
            RendererEvent::TaskStarted(spec) => {
                emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                let started = Utc::now();
                let started_at = Some(started.to_rfc3339());
                task_started_at.insert(spec.task_id.clone(), started);
                let _ = app.emit(
                    EVENT_TERM_TASK_STARTED,
                    TaskStartedPayload {
                        session_id: session_id.clone(),
                        task_id: spec.task_id.clone(),
                        region_id: spec.region_id.clone(),
                        step_index: spec.step_index,
                        step_total: spec.step_total,
                        name: spec.name.clone(),
                        command: spec.command.clone(),
                        status: STATUS_RUNNING.to_string(),
                    },
                );

                let chunk = renderer.start_region(&spec);
                pending_chunk.push_str(&chunk);

                let _ = app.emit(
                    EVENT_TERM_TASK_STATUS,
                    TaskStatusPayload {
                        session_id: session_id.clone(),
                        task_id: spec.task_id,
                        region_id: spec.region_id,
                        status: STATUS_RUNNING.to_string(),
                        exit_code: None,
                        error: None,
                        started_at,
                        finished_at: None,
                        duration_ms: None,
                    },
                );
            }
            RendererEvent::Output {
                task_id,
                region_id,
                chunk,
            } => {
                let clean = renderer.push_output(&task_id, &region_id, &chunk);
                if !clean.is_empty() {
                    pending_chunk.push_str(&clean);
                    if pending_chunk.len() >= 65_536 {
                        emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                    }
                }
            }
            RendererEvent::TaskFinished {
                task_id,
                region_id,
                status,
                exit_code,
                error,
            } => {
                emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                let clean = renderer.finish_region(&task_id);
                if !clean.is_empty() {
                    pending_chunk.push_str(&clean);
                    emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                }
                let region_id = if region_id.is_empty() {
                    renderer.region_id_for(&task_id).unwrap_or_default()
                } else {
                    region_id
                };
                let finished = Utc::now();
                let started_at = task_started_at.remove(&task_id);
                let duration_ms = started_at
                    .and_then(|started| (finished - started).to_std().ok())
                    .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64);
                let _ = app.emit(
                    EVENT_TERM_TASK_STATUS,
                    TaskStatusPayload {
                        session_id: session_id.clone(),
                        task_id,
                        region_id,
                        status,
                        exit_code,
                        error,
                        started_at: None,
                        finished_at: Some(finished.to_rfc3339()),
                        duration_ms,
                    },
                );
            }
            RendererEvent::SessionFinished { success } => {
                emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                let _ = app.emit(
                    EVENT_TERM_SESSION_FINISHED,
                    SessionFinishedPayload {
                        session_id: session_id.clone(),
                        success,
                    },
                );
                let chunk = renderer.render_completed_snapshot();
                if !chunk.is_empty() {
                    pending_chunk.push_str(&chunk);
                    emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                }
                break;
            }
            RendererEvent::BackendReady {
                base_backend_addr,
                base_backend_port,
            } => {
                emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                let _ = app.emit(
                    EVENT_UPDATER_BACKEND_READY,
                    BackendReadyPayload {
                        base_backend_addr,
                        base_backend_port,
                    },
                );
            }
            RendererEvent::FlushRegions { region_ids } => {
                let chunk = renderer.flush_regions(&region_ids);
                if !chunk.is_empty() {
                    pending_chunk.push_str(&chunk);
                    emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                }
            }
            RendererEvent::Resize { rows, cols } => {
                renderer.resize(rows, cols);
            }
            RendererEvent::Shutdown => {
                emit_dashboard_chunk(&app, &session_id, &mut pending_chunk);
                break;
            }
        }
    }
}

#[derive(Debug)]
enum EscapeBuffer {
    Esc,
    Csi(String),
    Osc { saw_esc: bool },
}

struct RegionBuffer {
    lines: Vec<String>,
    row: usize,
    col: usize,
    escape_buffer: Option<EscapeBuffer>,
    max_kept_lines: usize,
}

impl RegionBuffer {
    fn new() -> Self {
        Self {
            lines: vec![String::new()],
            row: 0,
            col: 0,
            escape_buffer: None,
            max_kept_lines: REGION_MAX_KEPT_LINES,
        }
    }

    fn push(&mut self, text: &str) {
        for ch in text.chars() {
            if self.consume_escape(ch) {
                continue;
            }

            match ch {
                '\x1b' => {
                    self.escape_buffer = Some(EscapeBuffer::Esc);
                }
                '\r' => {
                    self.col = 0;
                }
                '\n' => {
                    self.row += 1;
                    self.col = 0;
                    self.ensure_cursor();
                    self.truncate_history();
                }
                '\u{8}' => {
                    if self.col > 0 {
                        self.col -= 1;
                        self.truncate_current_line_to_col();
                    }
                }
                '\t' => {
                    let spaces = TAB_WIDTH - (self.col % TAB_WIDTH);
                    for _ in 0..spaces {
                        self.write_char(' ');
                    }
                }
                ch if ch.is_control() => {}
                _ => {
                    self.write_char(ch);
                }
            }
        }
    }

    fn finish(&mut self) {
        self.escape_buffer = None;
    }

    fn render_lines(&self, max_lines: Option<usize>, cols: usize) -> Vec<String> {
        let mut lines = self.lines.clone();

        while lines.len() > 1 && lines.last().map(|line| line.is_empty()).unwrap_or(false) {
            lines.pop();
        }

        let start = max_lines
            .map(|max_lines| lines.len().saturating_sub(max_lines))
            .unwrap_or(0);

        lines[start..]
            .iter()
            .map(|line| fit_ansi_line(line, cols))
            .collect()
    }

    fn consume_escape(&mut self, ch: char) -> bool {
        let Some(buffer) = self.escape_buffer.take() else {
            return false;
        };

        match buffer {
            EscapeBuffer::Esc => match ch {
                '[' => {
                    self.escape_buffer = Some(EscapeBuffer::Csi(String::new()));
                }
                ']' => {
                    self.escape_buffer = Some(EscapeBuffer::Osc { saw_esc: false });
                }
                '\x1b' => {
                    self.escape_buffer = Some(EscapeBuffer::Esc);
                }
                _ => {}
            },
            EscapeBuffer::Csi(mut sequence) => {
                sequence.push(ch);
                if is_csi_final(ch) {
                    self.apply_csi(&sequence);
                } else {
                    self.escape_buffer = Some(EscapeBuffer::Csi(sequence));
                }
            }
            EscapeBuffer::Osc { saw_esc } => {
                if ch == '\u{7}' {
                    return true;
                }

                if saw_esc && ch == '\\' {
                    return true;
                }

                self.escape_buffer = Some(EscapeBuffer::Osc {
                    saw_esc: ch == '\x1b',
                });
            }
        }

        true
    }

    fn apply_csi(&mut self, sequence: &str) {
        let Some(command) = sequence.chars().last() else {
            return;
        };

        let params = &sequence[..sequence.len().saturating_sub(command.len_utf8())];

        match command {
            'A' => {
                let amount = csi_param(params, 0, 1);
                self.row = self.row.saturating_sub(amount);
                self.ensure_cursor();
            }
            'B' => {
                let amount = csi_param(params, 0, 1);
                self.row += amount;
                self.ensure_cursor();
            }
            'C' => {
                let amount = csi_param(params, 0, 1);
                self.col += amount;
                self.ensure_cursor();
            }
            'D' => {
                let amount = csi_param(params, 0, 1);
                self.col = self.col.saturating_sub(amount);
                self.ensure_cursor();
            }
            'E' => {
                let amount = csi_param(params, 0, 1);
                self.row += amount;
                self.col = 0;
                self.ensure_cursor();
            }
            'F' => {
                let amount = csi_param(params, 0, 1);
                self.row = self.row.saturating_sub(amount);
                self.col = 0;
                self.ensure_cursor();
            }
            'G' => {
                let column = csi_param(params, 0, 1);
                self.col = column.saturating_sub(1);
                self.ensure_cursor();
            }
            'H' | 'f' => {
                let row = csi_param(params, 0, 1);
                let column = csi_param(params, 1, 1);
                self.row = row.saturating_sub(1);
                self.col = column.saturating_sub(1);
                self.ensure_cursor();
            }
            'J' => {
                self.erase_display(params);
            }
            'K' => {
                self.erase_line(params);
            }
            'm' => {
                self.push_sgr(sequence);
            }
            _ => {}
        }

        self.truncate_history();
    }

    fn erase_display(&mut self, params: &str) {
        let mode = csi_param(params, 0, 0);

        match mode {
            0 => {
                self.erase_line_from_cursor();
                for index in (self.row + 1)..self.lines.len() {
                    self.lines[index].clear();
                }
            }
            1 => {
                for index in 0..self.row {
                    self.lines[index].clear();
                }
                self.erase_line_to_cursor();
            }
            2 | 3 => {
                self.lines.clear();
                self.lines.push(String::new());
                self.row = 0;
                self.col = 0;
            }
            _ => {}
        }

        self.ensure_cursor();
    }

    fn erase_line(&mut self, params: &str) {
        let mode = csi_param(params, 0, 0);

        match mode {
            0 => self.erase_line_from_cursor(),
            1 => self.erase_line_to_cursor(),
            2 => {
                self.ensure_cursor();
                self.lines[self.row].clear();
            }
            _ => {}
        }
    }

    fn erase_line_from_cursor(&mut self) {
        self.ensure_cursor();
        let line = &mut self.lines[self.row];
        *line = truncate_ansi_line_to_visible_width(line, self.col);
    }

    fn erase_line_to_cursor(&mut self) {
        self.ensure_cursor();
        let line = &mut self.lines[self.row];
        let suffix = ansi_line_suffix_from_visible_width(line, self.col);
        *line = suffix;
        self.col = 0;
    }

    fn push_sgr(&mut self, sequence: &str) {
        self.ensure_cursor();
        self.lines[self.row].push_str("\x1b[");
        self.lines[self.row].push_str(sequence);
    }

    fn write_char(&mut self, ch: char) {
        self.ensure_cursor();

        let visible_width = visible_width(&self.lines[self.row]);
        if self.col < visible_width {
            let prefix = truncate_ansi_line_to_visible_width(&self.lines[self.row], self.col);
            self.lines[self.row] = prefix;
        } else if self.col > visible_width {
            let padding = self.col - visible_width;
            self.lines[self.row].push_str(&" ".repeat(padding));
        }

        self.lines[self.row].push(ch);
        self.col += 1;
    }

    fn truncate_current_line_to_col(&mut self) {
        self.ensure_cursor();
        let line = &mut self.lines[self.row];
        *line = truncate_ansi_line_to_visible_width(line, self.col);
    }

    fn ensure_cursor(&mut self) {
        if self.lines.is_empty() {
            self.lines.push(String::new());
            self.row = 0;
            self.col = 0;
        }

        while self.row >= self.lines.len() {
            self.lines.push(String::new());
        }
    }

    fn truncate_history(&mut self) {
        if self.lines.len() <= self.max_kept_lines {
            return;
        }

        let overflow = self.lines.len() - self.max_kept_lines;
        self.lines.drain(0..overflow);
        self.row = self.row.saturating_sub(overflow);
    }
}

struct SessionRenderer {
    regions: HashMap<String, RegionBuffer>,
    titles: HashMap<String, String>,
    task_regions: HashMap<String, String>,
    buffered_regions: HashSet<String>,
    region_order: Vec<String>,
    rows: usize,
    cols: usize,
}

impl SessionRenderer {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            regions: HashMap::new(),
            titles: HashMap::new(),
            task_regions: HashMap::new(),
            buffered_regions: HashSet::new(),
            region_order: Vec::new(),
            rows: usize::from(rows.max(MIN_TERMINAL_ROWS)),
            cols: usize::from(cols.max(MIN_TERMINAL_COLS)),
        }
    }

    fn resize(&mut self, rows: u16, cols: u16) {
        self.rows = usize::from(rows.max(MIN_TERMINAL_ROWS));
        self.cols = usize::from(cols.max(MIN_TERMINAL_COLS));
    }

    fn buffer_regions(&mut self, region_ids: Vec<String>) {
        for region_id in region_ids {
            self.buffered_regions.insert(region_id);
        }
    }

    fn start_region(&mut self, spec: &TaskSpec) -> String {
        let title = format!(
            "[{:02}/{:02}] {}",
            spec.step_index, spec.step_total, spec.name
        );
        self.regions
            .entry(spec.region_id.clone())
            .or_insert_with(RegionBuffer::new);
        self.titles.insert(spec.region_id.clone(), title);
        self.task_regions
            .insert(spec.task_id.clone(), spec.region_id.clone());
        if !self.region_order.contains(&spec.region_id) {
            self.region_order.push(spec.region_id.clone());
        }

        self.render_running_snapshot()
    }

    fn push_output(&mut self, task_id: &str, region_id: &str, bytes: &[u8]) -> String {
        let text = String::from_utf8_lossy(bytes);

        let Some(region) = self.regions.get_mut(region_id) else {
            return String::new();
        };

        region.push(&text);

        self.task_regions
            .entry(task_id.to_string())
            .or_insert_with(|| region_id.to_string());

        self.render_running_snapshot()
    }

    fn finish_region(&mut self, task_id: &str) -> String {
        let Some(region_id) = self.task_regions.get(task_id).cloned() else {
            return String::new();
        };

        if let Some(region) = self.regions.get_mut(&region_id) {
            region.finish();
        }

        self.render_running_snapshot()
    }

    fn flush_regions(&mut self, region_ids: &[String]) -> String {
        for region_id in region_ids {
            if let Some(region) = self.regions.get_mut(region_id) {
                region.finish();
            }
            self.buffered_regions.remove(region_id);
        }

        self.render_running_snapshot()
    }

    fn region_id_for(&self, task_id: &str) -> Option<String> {
        self.task_regions.get(task_id).cloned()
    }

    fn render_running_snapshot(&self) -> String {
        self.render_dashboard_snapshot(true)
    }

    fn render_completed_snapshot(&self) -> String {
        self.render_dashboard_snapshot(false)
    }

    fn render_dashboard_snapshot(&self, clip_to_view: bool) -> String {
        let mut lines = Vec::new();
        for region_id in &self.region_order {
            let block = self.render_region_lines(region_id, clip_to_view);
            if block.is_empty() {
                continue;
            }
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.extend(block);
        }

        if clip_to_view && lines.len() > self.rows {
            lines = lines.split_off(lines.len() - self.rows);
        }

        let mut snapshot = String::from(ANSI_DASHBOARD_RESET);
        if !lines.is_empty() {
            snapshot.push_str(&lines.join("\r\n"));
            if !clip_to_view || lines.len() < self.rows {
                snapshot.push_str("\r\n");
            }
        }
        snapshot
    }

    fn render_region_lines(&self, region_id: &str, running: bool) -> Vec<String> {
        let title = self.titles.get(region_id).cloned().unwrap_or_default();
        let body = self
            .regions
            .get(region_id)
            .map(|region| {
                region.render_lines(
                    if running {
                        Some(RUNNING_REGION_MAX_LINES)
                    } else {
                        None
                    },
                    self.cols,
                )
            })
            .unwrap_or_default();

        if title.is_empty() && body.is_empty() {
            return Vec::new();
        }

        let mut output = Vec::new();
        if !title.is_empty() {
            output.push(fit_ansi_line(
                &format!("\x1b[1;36m{title}\x1b[0m"),
                self.cols,
            ));
        }

        output.extend(body);
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::DEMO_STEP_TOTAL;

    fn spec(task_id: &str, region_id: &str, step_index: u8, name: &str) -> TaskSpec {
        TaskSpec {
            task_id: task_id.to_string(),
            region_id: region_id.to_string(),
            step_index,
            step_total: DEMO_STEP_TOTAL,
            name: name.to_string(),
            command: "run".to_string(),
            program: "program".to_string(),
            args: Vec::new(),
            cwd: ".".to_string(),
            env: Vec::new(),
        }
    }

    #[test]
    fn csi_param_parses_defaults_and_private_prefixes() {
        assert_eq!(csi_param("", 0, 1), 1);
        assert_eq!(csi_param("?25;7", 0, 1), 25);
        assert_eq!(csi_param("?25;7", 1, 1), 7);
        assert_eq!(csi_param("bad", 0, 9), 9);
    }

    #[test]
    fn visible_width_ignores_csi_and_osc_sequences() {
        assert_eq!(visible_width("\x1b[31mred\x1b[0m"), 3);
        assert_eq!(visible_width("a\x1b]0;title\u{7}b"), 2);
    }

    #[test]
    fn truncate_preserves_ansi_sequences_while_limiting_visible_width() {
        assert_eq!(
            truncate_ansi_line_to_visible_width("\x1b[31mabcdef\x1b[0m", 3),
            "\x1b[31mabc"
        );
        assert_eq!(fit_ansi_line("\x1b[31mabcdef", 3), "\x1b[31mabc\x1b[0m");
    }

    #[test]
    fn suffix_from_visible_width_ignores_ansi_sequences() {
        assert_eq!(
            ansi_line_suffix_from_visible_width("\x1b[31mabcdef\x1b[0m", 3),
            "def"
        );
    }

    #[test]
    fn region_buffer_handles_newlines_tabs_backspace_and_carriage_return() {
        let mut buffer = RegionBuffer::new();
        buffer.push("ab\tc\rZ\nxy\u{8}z");

        assert_eq!(buffer.render_lines(None, 80), vec!["Z\x1b[0m", "xz\x1b[0m"]);
    }

    #[test]
    fn region_buffer_applies_cursor_movement_and_erase_line_modes() {
        let mut buffer = RegionBuffer::new();
        buffer.push("abcdef\x1b[3D\x1b[K");

        assert_eq!(buffer.render_lines(None, 80), vec!["abc\x1b[0m"]);

        let mut buffer = RegionBuffer::new();
        buffer.push("abcdef\x1b[3D\x1b[1K");

        assert_eq!(buffer.render_lines(None, 80), vec!["def\x1b[0m"]);

        let mut buffer = RegionBuffer::new();
        buffer.push("abcdef\x1b[2K");

        assert_eq!(buffer.render_lines(None, 80), vec!["\x1b[0m"]);
    }

    #[test]
    fn region_buffer_applies_cursor_position_and_display_erase_modes() {
        let mut buffer = RegionBuffer::new();
        buffer.push("one\ntwo\nthree\x1b[1;1Htop\x1b[J");

        assert_eq!(buffer.render_lines(None, 80), vec!["top\x1b[0m"]);

        let mut buffer = RegionBuffer::new();
        buffer.push("one\ntwo\x1b[2Jdone");

        assert_eq!(buffer.render_lines(None, 80), vec!["done\x1b[0m"]);
    }

    #[test]
    fn region_buffer_preserves_sgr_and_drops_incomplete_escape_on_finish() {
        let mut buffer = RegionBuffer::new();
        buffer.push("\x1b[31mred\x1b[0m\x1b[");
        buffer.finish();

        assert_eq!(
            buffer.render_lines(None, 80),
            vec!["\x1b[31mred\x1b[0m\x1b[0m"]
        );
    }

    #[test]
    fn region_buffer_trims_history_to_max_kept_lines() {
        let mut buffer = RegionBuffer::new();
        buffer.max_kept_lines = 3;
        buffer.push("1\n2\n3\n4\n5");

        assert_eq!(buffer.lines.len(), 3);
        assert_eq!(
            buffer.render_lines(None, 80),
            vec!["3\x1b[0m", "4\x1b[0m", "5\x1b[0m"]
        );
    }

    #[test]
    fn session_renderer_clamps_size_and_resizes() {
        let mut renderer = SessionRenderer::new(0, 0);
        assert_eq!(renderer.rows, 1);
        assert_eq!(renderer.cols, 1);

        renderer.resize(32, 120);
        assert_eq!(renderer.rows, 32);
        assert_eq!(renderer.cols, 120);
    }

    #[test]
    fn session_renderer_renders_regions_in_start_order_and_clips_running_view() {
        let mut renderer = SessionRenderer::new(20, 80);
        renderer.start_region(&spec("task-a", "region-a", 1, "Alpha"));
        renderer.push_output("task-a", "region-a", b"a1\na2\na3\na4\na5\na6");
        renderer.start_region(&spec("task-b", "region-b", 2, "Beta"));
        renderer.push_output("task-b", "region-b", b"b1");

        let snapshot = renderer.render_running_snapshot();

        assert!(snapshot.starts_with("\x1b[H\x1b[2J"));
        assert!(snapshot.contains("[01/04] Alpha"));
        assert!(snapshot.contains("[02/04] Beta"));
        assert!(snapshot.contains("a6"));
        assert!(!snapshot.contains("a1"));
    }

    #[test]
    fn session_renderer_ignores_output_for_unknown_regions() {
        let mut renderer = SessionRenderer::new(24, 80);

        assert_eq!(renderer.push_output("task", "missing", b"hello"), "");
        assert_eq!(renderer.finish_region("missing"), "");
        assert_eq!(renderer.region_id_for("missing"), None);
    }

    #[test]
    fn session_renderer_tracks_buffered_regions_and_flushes_them() {
        let mut renderer = SessionRenderer::new(24, 80);
        renderer.buffer_regions(vec!["region".to_string()]);
        renderer.start_region(&spec("task", "region", 1, "Buffered"));
        renderer.push_output("task", "region", b"hello");

        assert!(renderer.buffered_regions.contains("region"));
        let flushed = renderer.flush_regions(&["region".to_string()]);

        assert!(!renderer.buffered_regions.contains("region"));
        assert!(flushed.contains("[01/04] Buffered"));
        assert!(flushed.contains("hello"));
    }

    #[test]
    fn completed_snapshot_includes_full_region_history() {
        let mut renderer = SessionRenderer::new(3, 80);
        renderer.start_region(&spec("task", "region", 1, "History"));
        renderer.push_output("task", "region", b"1\n2\n3\n4");

        let snapshot = renderer.render_completed_snapshot();

        assert!(snapshot.contains("1"));
        assert!(snapshot.contains("4"));
    }
}
