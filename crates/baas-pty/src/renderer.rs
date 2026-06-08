use crate::types::{
    DashboardLogPayload, RendererEvent, SessionFinishedPayload, TaskSpec, TaskStartedPayload,
    TaskStatusPayload,
};
use chrono::Utc;
use std::{
    collections::{HashMap, HashSet},
    sync::mpsc::Receiver,
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

fn renderer_loop(app: AppHandle, session_id: String, rx: Receiver<RendererEvent>) {
    let mut renderer = SessionRenderer::new();

    while let Ok(event) = rx.recv() {
        match event {
            RendererEvent::BufferRegions { region_ids } => {
                renderer.buffer_regions(region_ids);
            }
            RendererEvent::TaskStarted(spec) => {
                let started_at = Some(Utc::now().to_rfc3339());
                let _ = app.emit(
                    "updater:task-started",
                    TaskStartedPayload {
                        session_id: session_id.clone(),
                        task_id: spec.task_id.clone(),
                        region_id: spec.region_id.clone(),
                        step_index: spec.step_index,
                        step_total: spec.step_total,
                        name: spec.name.clone(),
                        command: spec.command.clone(),
                        status: "running".to_string(),
                    },
                );

                let chunk = renderer.start_region(&spec);
                let _ = app.emit(
                    "updater:dashboard-log",
                    DashboardLogPayload {
                        session_id: session_id.clone(),
                        chunk,
                    },
                );

                let _ = app.emit(
                    "updater:task-status",
                    TaskStatusPayload {
                        session_id: session_id.clone(),
                        task_id: spec.task_id,
                        region_id: spec.region_id,
                        status: "running".to_string(),
                        exit_code: None,
                        error: None,
                        started_at,
                        finished_at: None,
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
                    let _ = app.emit(
                        "updater:dashboard-log",
                        DashboardLogPayload {
                            session_id: session_id.clone(),
                            chunk: clean,
                        },
                    );
                }
            }
            RendererEvent::TaskFinished {
                task_id,
                region_id,
                status,
                exit_code,
                error,
            } => {
                let clean = renderer.finish_region(&task_id);
                if !clean.is_empty() {
                    let _ = app.emit(
                        "updater:dashboard-log",
                        DashboardLogPayload {
                            session_id: session_id.clone(),
                            chunk: clean,
                        },
                    );
                }
                let region_id = if region_id.is_empty() {
                    renderer.region_id_for(&task_id).unwrap_or_default()
                } else {
                    region_id
                };
                let _ = app.emit(
                    "updater:task-status",
                    TaskStatusPayload {
                        session_id: session_id.clone(),
                        task_id,
                        region_id,
                        status,
                        exit_code,
                        error,
                        started_at: None,
                        finished_at: Some(Utc::now().to_rfc3339()),
                    },
                );
            }
            RendererEvent::SessionFinished { success } => {
                let _ = app.emit(
                    "updater:session-finished",
                    SessionFinishedPayload {
                        session_id: session_id.clone(),
                        success,
                    },
                );
                break;
            }
            RendererEvent::FlushRegions { region_ids } => {
                let chunk = renderer.flush_regions(&region_ids);
                if !chunk.is_empty() {
                    let _ = app.emit(
                        "updater:dashboard-log",
                        DashboardLogPayload {
                            session_id: session_id.clone(),
                            chunk,
                        },
                    );
                }
            }
            RendererEvent::Shutdown => break,
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
            max_kept_lines: 2_000,
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
                    let spaces = 4 - (self.col % 4);
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

    fn tail_lines(&self, max_lines: usize) -> String {
        let mut lines = self.lines.clone();

        while lines.len() > 1 && lines.last().map(|line| line.is_empty()).unwrap_or(false) {
            lines.pop();
        }

        let start = lines.len().saturating_sub(max_lines);
        let mut output = String::new();

        for line in &lines[start..] {
            output.push_str(line);
            output.push_str("\x1b[0m\r\n");
        }

        output
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
}

impl SessionRenderer {
    fn new() -> Self {
        Self {
            regions: HashMap::new(),
            titles: HashMap::new(),
            task_regions: HashMap::new(),
            buffered_regions: HashSet::new(),
            region_order: Vec::new(),
        }
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

        self.render_dashboard_snapshot()
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

        self.render_dashboard_snapshot()
    }

    fn finish_region(&mut self, task_id: &str) -> String {
        let Some(region_id) = self.task_regions.get(task_id).cloned() else {
            return String::new();
        };

        if let Some(region) = self.regions.get_mut(&region_id) {
            region.finish();
        }

        self.render_dashboard_snapshot()
    }

    fn flush_regions(&mut self, region_ids: &[String]) -> String {
        for region_id in region_ids {
            if let Some(region) = self.regions.get_mut(region_id) {
                region.finish();
            }
            self.buffered_regions.remove(region_id);
        }

        self.render_dashboard_snapshot()
    }

    fn region_id_for(&self, task_id: &str) -> Option<String> {
        self.task_regions.get(task_id).cloned()
    }

    fn render_dashboard_snapshot(&self) -> String {
        let mut snapshot = String::from("\x1b[H\x1b[2J");
        for region_id in &self.region_order {
            let block = self.render_region(region_id);
            if block.is_empty() {
                continue;
            }
            if !snapshot.ends_with("\r\n") && !snapshot.ends_with("\x1b[2J") {
                snapshot.push_str("\r\n");
            }
            if !snapshot.ends_with("\x1b[2J") {
                snapshot.push_str("\r\n");
            }
            snapshot.push_str(&block);
        }
        snapshot
    }

    fn render_region(&self, region_id: &str) -> String {
        let title = self.titles.get(region_id).cloned().unwrap_or_default();
        let body = self
            .regions
            .get(region_id)
            .map(|region| region.tail_lines(4))
            .unwrap_or_default();

        if title.is_empty() && body.is_empty() {
            return String::new();
        }

        let mut output = String::new();
        if !title.is_empty() {
            output.push_str(&format!("\x1b[1;36m{title}\x1b[0m\r\n"));
        }

        output.push_str(&body);

        if !output.ends_with("\r\n") {
            output.push_str("\r\n");
        }
        output
    }
}
