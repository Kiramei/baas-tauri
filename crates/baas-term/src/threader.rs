//! In-process task helpers and terminal output primitives.
//!
//! Thread tasks are ordinary Rust closures that report terminal-like output
//! through [`ThreadOutput`](crate::threader::ThreadOutput). The helpers in this
//! module provide styled lines, repaint regions, spinners, and progress bars
//! without requiring callers to hand-write ANSI control sequences.

use std::{
    panic::{self, AssertUnwindSafe},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::Sender,
    },
    thread,
    time::Duration,
};

use crate::constants::{
    ANSI_CLEAR_LINE, ANSI_RESET, DEMO_STEP_TOTAL, PROGRESS_PERCENT_MAX, STATUS_FAILED,
    STATUS_STOPPED, STATUS_SUCCESS, THREAD_PROGRESS_LABEL_WIDTH, THREAD_SPINNER_TICK_MS,
};
use crate::types::{RendererEvent, TaskCompletion, TaskHandle, TaskSpec, TermState};

/// Builds a [`TaskSpec`] for an in-process thread task.
///
/// The task uses the provided display command and leaves process-specific
/// fields empty because no external program is spawned.
pub fn create_thread_task(
    task_id: &str,
    region_id: &str,
    step_index: u8,
    name: &str,
    command: &str,
) -> TaskSpec {
    create_thread_task_with_total(
        task_id,
        region_id,
        step_index,
        DEMO_STEP_TOTAL,
        name,
        command,
    )
}

/// Builds a [`TaskSpec`] for an in-process thread task with an explicit total.
pub fn create_thread_task_with_total(
    task_id: &str,
    region_id: &str,
    step_index: u8,
    step_total: u8,
    name: &str,
    command: &str,
) -> TaskSpec {
    TaskSpec {
        task_id: task_id.to_string(),
        region_id: region_id.to_string(),
        step_index,
        step_total,
        name: name.to_string(),
        command: command.to_string(),
        program: String::new(),
        args: Vec::new(),
        cwd: String::new(),
        env: Vec::new(),
        detached: false,
        detached_pid_file: None,
        after: Vec::new(),
        running_region_max_lines: None,
        running_region_unlimited: false,
    }
}

/// Spawns a thread task and forwards its output to the term renderer.
///
/// `spec` defines the dashboard task metadata, `args` is moved into the worker
/// function, and `job` receives `(output, cancellation_token, args)`. Returns
/// [`Ok(())`] after the worker thread is spawned, or an error if the session is
/// stale or the start event cannot be sent.
pub fn spawn_thread_task<F, A>(
    inner: &Arc<Mutex<TermState>>,
    session_id: &str,
    spec: TaskSpec,
    renderer_tx: &Sender<RendererEvent>,
    completion_tx: &Sender<TaskCompletion>,
    args: A,
    job: F,
) -> Result<(), String>
where
    F: FnOnce(ThreadOutput, Arc<AtomicBool>, A) -> Result<(), String> + Send + 'static,
    A: Send + 'static,
{
    {
        let state = inner.lock().map_err(|_| "term manager lock poisoned")?;
        if state.current_session_id.as_deref() != Some(session_id) {
            return Err("stale term session".to_string());
        }
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let handle = Arc::new(TaskHandle::Thread {
        cancel: Arc::clone(&cancel),
    });

    {
        let mut state = inner.lock().map_err(|_| "term manager lock poisoned")?;
        state.tasks.insert(spec.task_id.clone(), handle);
    }

    renderer_tx
        .send(RendererEvent::TaskStarted(spec.clone()))
        .map_err(|error| error.to_string())?;

    let thread_inner = Arc::clone(inner);
    let thread_tx = renderer_tx.clone();
    let thread_completion_tx = completion_tx.clone();
    let thread_task_id = spec.task_id.clone();
    let thread_region_id = spec.region_id.clone();
    thread::spawn(move || {
        let output = ThreadOutput {
            task_id: thread_task_id.clone(),
            region_id: thread_region_id.clone(),
            tx: thread_tx.clone(),
        };
        let result =
            panic::catch_unwind(AssertUnwindSafe(|| job(output, Arc::clone(&cancel), args)))
                .unwrap_or_else(|_| Err("thread task panicked".to_string()));
        let cancelled = cancel.load(Ordering::Relaxed);

        if let Ok(mut state) = thread_inner.lock() {
            state.tasks.remove(&thread_task_id);
        }

        let (status, error) = if cancelled {
            (STATUS_STOPPED.to_string(), None)
        } else {
            match result {
                Ok(()) => (STATUS_SUCCESS.to_string(), None),
                Err(error) => (STATUS_FAILED.to_string(), Some(error)),
            }
        };
        let success = status == STATUS_SUCCESS;

        let _ = thread_tx.send(RendererEvent::TaskFinished {
            task_id: thread_task_id.clone(),
            region_id: thread_region_id,
            status,
            exit_code: None,
            error,
        });
        let _ = thread_completion_tx.send(TaskCompletion {
            task_id: thread_task_id,
            success,
        });
    });

    Ok(())
}

#[derive(Clone)]
/// Output sink bound to a single thread task and renderer region.
pub struct ThreadOutput {
    /// Stable task identifier attached to emitted output events.
    pub task_id: String,
    /// Renderer region receiving output events.
    pub region_id: String,
    /// Sender used to forward output events to the renderer.
    pub tx: Sender<RendererEvent>,
}

impl ThreadOutput {
    /// Writes raw terminal text to the renderer for this thread task.
    ///
    /// `chunk` is the complete text chunk to append. It may contain CRLF,
    /// carriage returns, or ANSI control sequences generated by higher-level
    /// helpers. Returns nothing; send failures are intentionally ignored
    /// because they mean the terminal session was already closed.
    pub fn write(&self, chunk: &str) {
        self.write_bytes(chunk.as_bytes());
    }

    /// Writes raw terminal bytes to the renderer for this thread task.
    ///
    /// `chunk` is forwarded unchanged to the term renderer. Use this only for
    /// low-level integration points; prefer `log`, `spinner`, or `progress_bar`
    /// for normal thread UI output. Returns nothing; send failures are ignored.
    pub fn write_bytes(&self, chunk: &[u8]) {
        let _ = self.tx.send(RendererEvent::Output {
            task_id: self.task_id.clone(),
            region_id: self.region_id.clone(),
            chunk: chunk.to_vec(),
        });
    }

    /// Creates a structured log writer for this thread task.
    ///
    /// The returned `ThreadLog` writes normal lines and reusable repaint areas
    /// without exposing ANSI escape sequences to callers.
    pub fn log(&self) -> ThreadLog {
        ThreadLog {
            output: self.clone(),
        }
    }

    /// Creates a spinner renderer bound to this thread task.
    ///
    /// `label` is the stable text shown after the spinner frame. The returned
    /// `ThreadSpinner` owns its animation state and writes one repainting line.
    pub fn spinner(&self, label: impl Into<String>) -> ThreadSpinner {
        ThreadSpinner::new(self.clone(), label)
    }

    /// Creates a progress bar renderer bound to this thread task.
    ///
    /// `label` is the stable text shown before the bar, `total` is the maximum
    /// progress value, and `width` is the number of character cells in the bar.
    /// The returned `ThreadProgressBar` owns current progress and repaint state.
    pub fn progress_bar(
        &self,
        label: impl Into<String>,
        total: u64,
        width: usize,
    ) -> ThreadProgressBar {
        ThreadProgressBar::new(self.clone(), label, total, width)
    }

    /// Runs a closure while a spinner is animated in the background.
    ///
    /// `label` is the stable spinner label, `success_message` is rendered when
    /// the closure returns `Ok`, and `run` contains the long-running work. The
    /// closure receives a `ThreadSpinnerGuard` that can update transient detail
    /// text. Returns the closure result and always stops the spinner before
    /// returning.
    pub fn with_spinner<T, F>(
        &self,
        label: impl Into<String>,
        success_message: impl Into<String>,
        run: F,
    ) -> Result<T, String>
    where
        F: FnOnce(&ThreadSpinnerGuard) -> Result<T, String>,
    {
        let mut spinner = ThreadSpinnerGuard::start(self.clone(), label);
        let result = run(&spinner);

        match &result {
            Ok(_) => spinner.finish(ThreadLogStyle::Success, success_message.into()),
            Err(error) => spinner.finish(scope_error_style(error), error),
        }

        result
    }

    /// Runs a closure with a progress bar that is finalized automatically.
    ///
    /// `label`, `total`, and `width` configure the progress bar; `success_message`
    /// is rendered when the closure returns `Ok`. The closure receives a mutable
    /// `ThreadProgressBar` and should call `set` or `inc` as work advances.
    /// Returns the closure result and always finishes the progress line.
    pub fn with_progress_bar<T, F>(
        &self,
        label: impl Into<String>,
        total: u64,
        width: usize,
        success_message: impl Into<String>,
        run: F,
    ) -> Result<T, String>
    where
        F: FnOnce(&mut ThreadProgressBar) -> Result<T, String>,
    {
        let mut progress_bar = self.progress_bar(label, total, width);
        let result = run(&mut progress_bar);

        match &result {
            Ok(_) => progress_bar.finish(ThreadLogStyle::Success, success_message.into()),
            Err(error) => progress_bar.finish(scope_error_style(error), error),
        }

        result
    }
}

const SPINNER_FRAMES: [&str; 4] = ["-", "\\", "|", "/"];

#[derive(Clone, Copy)]
/// Visual style used by thread-output helpers.
pub enum ThreadLogStyle {
    /// No ANSI styling.
    Plain,
    /// Informational cyan text.
    Info,
    /// Success green text.
    Success,
    /// Warning yellow text.
    Warning,
    /// Error red text.
    Error,
    /// Accent magenta text.
    Accent,
    /// Muted bright-black text.
    Muted,
}

impl ThreadLogStyle {
    fn ansi_code(self) -> Option<&'static str> {
        match self {
            ThreadLogStyle::Plain => None,
            ThreadLogStyle::Info => Some("\x1b[36m"),
            ThreadLogStyle::Success => Some("\x1b[32m"),
            ThreadLogStyle::Warning => Some("\x1b[33m"),
            ThreadLogStyle::Error => Some("\x1b[31m"),
            ThreadLogStyle::Accent => Some("\x1b[35m"),
            ThreadLogStyle::Muted => Some("\x1b[90m"),
        }
    }
}

#[derive(Clone)]
/// Structured line-oriented logger for a [`ThreadOutput`].
pub struct ThreadLog {
    output: ThreadOutput,
}

impl ThreadLog {
    /// Writes a single styled log line and terminates it with CRLF.
    ///
    /// `style` controls the visual treatment of the line, and `message` is the
    /// text to render. Returns nothing.
    pub fn line(&self, style: ThreadLogStyle, message: impl AsRef<str>) {
        self.output
            .write(&format!("{}\r\n", style_text(style, message.as_ref())));
    }

    /// Writes multiple styled log lines and terminates each line with CRLF.
    ///
    /// `style` controls the visual treatment of every line, and `lines` is the
    /// ordered set of messages to render. Returns nothing.
    pub fn lines<'a>(&self, style: ThreadLogStyle, lines: impl IntoIterator<Item = &'a str>) {
        for line in lines {
            self.line(style, line);
        }
    }

    /// Creates a single-line repaint area.
    ///
    /// The returned `ThreadLineRepaint` rewrites one terminal line in place
    /// until `finish` is called.
    pub fn line_repaint(&self) -> ThreadLineRepaint {
        ThreadLineRepaint {
            output: self.output.clone(),
            rendered: false,
        }
    }

    /// Creates a multi-line repaint area.
    ///
    /// The returned `ThreadBlockRepaint` rewrites the same group of terminal
    /// lines in place and tracks how many lines were rendered previously.
    pub fn block_repaint(&self) -> ThreadBlockRepaint {
        ThreadBlockRepaint {
            output: self.output.clone(),
            rendered_lines: 0,
        }
    }
}

/// Repaints one terminal line in place.
pub struct ThreadLineRepaint {
    output: ThreadOutput,
    rendered: bool,
}

impl ThreadLineRepaint {
    /// Repaints the current single-line area without adding a newline.
    ///
    /// `style` controls the visual treatment of the line, and `message` is the
    /// complete line content. Returns nothing.
    pub fn render(&mut self, style: ThreadLogStyle, message: impl AsRef<str>) {
        let prefix = if self.rendered { ANSI_CLEAR_LINE } else { "" };
        self.output
            .write(&format!("{prefix}{}", style_text(style, message.as_ref())));
        self.rendered = true;
    }

    /// Repaints the line one final time and moves the cursor to the next line.
    ///
    /// `style` controls the final visual treatment, and `message` is the final
    /// line content. Returns nothing.
    pub fn finish(&mut self, style: ThreadLogStyle, message: impl AsRef<str>) {
        self.render(style, message);
        self.output.write("\r\n");
        self.rendered = false;
    }
}

/// Repaints a multi-line terminal block in place.
pub struct ThreadBlockRepaint {
    output: ThreadOutput,
    rendered_lines: usize,
}

impl ThreadBlockRepaint {
    /// Repaints a multi-line block in place.
    ///
    /// `style` controls the visual treatment of each line, and `lines` is the
    /// complete block content for this frame. Returns nothing.
    pub fn render<'a>(&mut self, style: ThreadLogStyle, lines: impl IntoIterator<Item = &'a str>) {
        self.rewind_previous_frame();

        let mut rendered_lines = 0;
        for line in lines {
            self.output
                .write(&format!("{}\r\n", style_text(style, line)));
            rendered_lines += 1;
        }

        self.rendered_lines = rendered_lines;
    }

    /// Leaves the current block visible and starts future output below it.
    ///
    /// This method intentionally preserves the last rendered block. It returns
    /// nothing and resets repaint bookkeeping.
    pub fn finish(&mut self) {
        self.rendered_lines = 0;
    }

    /// Rewinds the cursor to the beginning of the previously rendered block.
    ///
    /// This is exposed for advanced callers that need to compose custom
    /// multi-line repaint behavior.
    pub fn rewind_previous_frame(&self) {
        if self.rendered_lines == 0 {
            return;
        }

        self.output
            .write(&format!("\x1b[{}F\x1b[J", self.rendered_lines));
    }
}

/// Single-line spinner renderer.
///
/// Create values with [`ThreadOutput::spinner`]. The low-level tick/finalize
/// methods are intentionally crate-private; public callers usually use
/// [`ThreadOutput::with_spinner`].
pub struct ThreadSpinner {
    output: ThreadOutput,
    label: String,
    frame_index: usize,
    rendered: bool,
}

impl ThreadSpinner {
    /// Creates a spinner that renders into a single repainting terminal line.
    ///
    /// `output` is the target thread output sink, and `label` is the stable text
    /// shown beside the spinner frame. Returns a new `ThreadSpinner`.
    fn new(output: ThreadOutput, label: impl Into<String>) -> Self {
        Self {
            output,
            label: label.into(),
            frame_index: 0,
            rendered: false,
        }
    }

    /// Advances the spinner by one frame and repaints its line.
    ///
    /// `detail` is optional transient text shown after the label. Returns
    /// nothing.
    fn tick(&mut self, detail: impl AsRef<str>) {
        let frame = SPINNER_FRAMES[self.frame_index % SPINNER_FRAMES.len()];
        self.frame_index += 1;

        let detail = detail.as_ref();
        let detail = if detail.is_empty() {
            String::new()
        } else {
            format!(" {detail}")
        };
        let prefix = if self.rendered { ANSI_CLEAR_LINE } else { "" };

        self.output.write(&format!(
            "{prefix}{} {}{}",
            style_text(ThreadLogStyle::Info, frame),
            self.label,
            detail
        ));
        self.rendered = true;
    }

    /// Repaints the spinner one final time and moves to the next line.
    ///
    /// `style` controls the final status color, and `message` is the final line
    /// content. Returns nothing.
    #[allow(dead_code)]
    fn finish(&mut self, style: ThreadLogStyle, message: impl AsRef<str>) {
        let prefix = if self.rendered { ANSI_CLEAR_LINE } else { "" };
        self.output.write(&format!(
            "{prefix}{}\r\n",
            style_text(style, message.as_ref())
        ));
        self.rendered = false;
    }
}

/// Guard that owns a background spinner worker.
pub struct ThreadSpinnerGuard {
    output: ThreadOutput,
    stop: Arc<AtomicBool>,
    detail: Arc<Mutex<String>>,
    worker: Option<thread::JoinHandle<()>>,
    finished: bool,
}

impl ThreadSpinnerGuard {
    /// Starts a background spinner for long-running scoped work.
    ///
    /// `output` is the target thread output sink, and `label` is the stable text
    /// shown beside the animated spinner. Returns a guard that stops the worker
    /// when `finish` or `drop` runs.
    pub fn start(output: ThreadOutput, label: impl Into<String>) -> Self {
        let label = label.into();
        let stop = Arc::new(AtomicBool::new(false));
        let detail = Arc::new(Mutex::new(String::new()));
        let worker_output = output.clone();
        let worker_stop = Arc::clone(&stop);
        let worker_detail = Arc::clone(&detail);

        let worker = thread::spawn(move || {
            let mut spinner = worker_output.spinner(label);
            while !worker_stop.load(Ordering::Relaxed) {
                let detail = worker_detail
                    .lock()
                    .map(|detail| detail.clone())
                    .unwrap_or_default();
                spinner.tick(detail);
                thread::sleep(Duration::from_millis(THREAD_SPINNER_TICK_MS));
            }
        });

        Self {
            output,
            stop,
            detail,
            worker: Some(worker),
            finished: false,
        }
    }

    /// Updates the transient text rendered beside the spinner.
    ///
    /// `detail` is replaced atomically for the background spinner loop. Returns
    /// nothing.
    pub fn set_detail(&self, detail: impl Into<String>) {
        if let Ok(mut current) = self.detail.lock() {
            *current = detail.into();
        }
    }

    /// Stops the spinner and renders a final status line.
    ///
    /// `style` controls the final status color, and `message` is the final line
    /// content. Returns nothing.
    pub fn finish(&mut self, style: ThreadLogStyle, message: impl AsRef<str>) {
        self.stop_worker();
        self.output.write(&format!(
            "{ANSI_CLEAR_LINE}{}\r\n",
            style_text(style, message.as_ref())
        ));
        self.finished = true;
    }

    /// Stops the background spinner worker without rendering a final line.
    ///
    /// Prefer [`finish`](Self::finish) for normal use so the terminal is left
    /// with an explicit final status.
    pub fn stop_worker(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for ThreadSpinnerGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }

        self.stop_worker();
        self.output.write(&format!(
            "{ANSI_CLEAR_LINE}{}\r\n",
            style_text(ThreadLogStyle::Warning, "spinner interrupted")
        ));
        self.finished = true;
    }
}

/// Single-line progress bar renderer.
pub struct ThreadProgressBar {
    output: ThreadOutput,
    label: String,
    total: u64,
    width: usize,
    current: u64,
    rendered: bool,
}

impl ThreadProgressBar {
    /// Creates a progress bar that renders into a single repainting line.
    ///
    /// `output` is the target thread output sink, `label` is shown before the
    /// bar, `total` is the completed value, and `width` is the visual bar width.
    /// Returns a new `ThreadProgressBar`.
    pub fn new(output: ThreadOutput, label: impl Into<String>, total: u64, width: usize) -> Self {
        Self {
            output,
            label: label.into(),
            total: total.max(1),
            width: width.max(1),
            current: 0,
            rendered: false,
        }
    }

    /// Sets the current progress value and repaints the bar.
    ///
    /// `current` is clamped to `total`, and `detail` is optional transient text
    /// shown after the percentage. Returns nothing.
    pub fn set(&mut self, current: u64, detail: impl AsRef<str>) {
        self.current = current.min(self.total);
        self.render(detail.as_ref());
    }

    /// Increments the current progress value and repaints the bar.
    ///
    /// `delta` is added to the previous value and clamped to `total`; `detail`
    /// is optional transient text shown after the percentage. Returns nothing.
    pub fn inc(&mut self, delta: u64, detail: impl AsRef<str>) {
        self.set(self.current.saturating_add(delta), detail);
    }

    /// Completes the progress bar and moves to the next line.
    ///
    /// `style` controls the final status color, and `message` is the final line
    /// content. Returns nothing.
    pub fn finish(&mut self, style: ThreadLogStyle, message: impl AsRef<str>) {
        self.current = self.total;
        let prefix = if self.rendered { ANSI_CLEAR_LINE } else { "" };
        self.output.write(&format!(
            "{prefix}{}\r\n",
            style_text(style, message.as_ref())
        ));
        self.rendered = false;
    }

    /// Renders the current progress state without changing it.
    ///
    /// `detail` is optional transient text shown after the count. Most callers
    /// should use [`set`](Self::set) or [`inc`](Self::inc), which update progress
    /// before rendering.
    pub fn render(&mut self, detail: &str) {
        let filled =
            (((self.current as usize) * self.width) / (self.total as usize)).min(self.width);
        let percent = (self.current * PROGRESS_PERCENT_MAX) / self.total;
        let detail = if detail.is_empty() {
            String::new()
        } else {
            format!(" {}", style_text(ThreadLogStyle::Muted, detail))
        };
        let prefix = if self.rendered { ANSI_CLEAR_LINE } else { "" };
        let (done, todo) = progress_bar_segments(filled, self.width);

        self.output.write(&format!(
            "{prefix}{} {}  {} {}  {}/{}{}",
            style_text(
                ThreadLogStyle::Accent,
                &format!(
                    "{:<width$}",
                    self.label,
                    width = THREAD_PROGRESS_LABEL_WIDTH
                ),
            ),
            style_text(ThreadLogStyle::Info, &format!("{percent:>3}%")),
            style_text(ThreadLogStyle::Accent, &done),
            style_text(ThreadLogStyle::Muted, &todo),
            style_text(ThreadLogStyle::Info, &format!("{:>3}", self.current)),
            style_text(ThreadLogStyle::Muted, &self.total.to_string()),
            detail
        ));
        self.rendered = true;
    }
}

impl Drop for ThreadProgressBar {
    fn drop(&mut self) {
        if self.rendered {
            self.output.write(&format!(
                "{ANSI_CLEAR_LINE}{}\r\n",
                style_text(ThreadLogStyle::Warning, "progress interrupted")
            ));
            self.rendered = false;
        }
    }
}

fn progress_bar_segments(filled: usize, width: usize) -> (String, String) {
    ("━".repeat(filled), "─".repeat(width.saturating_sub(filled)))
}

fn style_text(style: ThreadLogStyle, text: &str) -> String {
    match style.ansi_code() {
        Some(code) => format!("{code}{text}{ANSI_RESET}"),
        None => text.to_string(),
    }
}

fn scope_error_style(error: &str) -> ThreadLogStyle {
    if error.to_ascii_lowercase().contains("cancel") {
        ThreadLogStyle::Warning
    } else {
        ThreadLogStyle::Error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    fn output() -> (ThreadOutput, mpsc::Receiver<RendererEvent>) {
        let (tx, rx) = mpsc::channel();
        (
            ThreadOutput {
                task_id: "task".to_string(),
                region_id: "region".to_string(),
                tx,
            },
            rx,
        )
    }

    fn active_state() -> Arc<Mutex<TermState>> {
        Arc::new(Mutex::new(TermState {
            current_session_id: Some("session".to_string()),
            ..TermState::default()
        }))
    }

    fn recv_output(rx: &mpsc::Receiver<RendererEvent>) -> String {
        match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            RendererEvent::Output { chunk, .. } => String::from_utf8(chunk).unwrap(),
            _ => panic!("expected output event"),
        }
    }

    fn recv_finished(rx: &mpsc::Receiver<RendererEvent>) -> (String, Option<String>) {
        loop {
            if let RendererEvent::TaskFinished { status, error, .. } =
                rx.recv_timeout(Duration::from_secs(2)).unwrap()
            {
                return (status, error);
            }
        }
    }

    #[test]
    fn create_thread_task_uses_display_command_and_empty_process_fields() {
        let spec = create_thread_task("task", "region", 3, "Thread", "run in process");

        assert_eq!(spec.task_id, "task");
        assert_eq!(spec.region_id, "region");
        assert_eq!(spec.step_index, 3);
        assert_eq!(spec.step_total, 4);
        assert_eq!(spec.name, "Thread");
        assert_eq!(spec.command, "run in process");
        assert!(spec.program.is_empty());
        assert!(spec.args.is_empty());
    }

    #[test]
    fn thread_output_forwards_raw_text_and_bytes() {
        let (output, rx) = output();

        output.write("hello");
        output.write_bytes(b" bytes");

        assert_eq!(recv_output(&rx), "hello");
        assert_eq!(recv_output(&rx), " bytes");
    }

    #[test]
    fn thread_log_writes_styled_lines() {
        let (output, rx) = output();
        let log = output.log();

        log.line(ThreadLogStyle::Success, "done");
        log.lines(ThreadLogStyle::Plain, ["a", "b"]);

        assert_eq!(recv_output(&rx), "\x1b[32mdone\x1b[0m\r\n");
        assert_eq!(recv_output(&rx), "a\r\n");
        assert_eq!(recv_output(&rx), "b\r\n");
    }

    #[test]
    fn line_repaint_clears_previous_line_after_first_render() {
        let (output, rx) = output();
        let mut repaint = output.log().line_repaint();

        repaint.render(ThreadLogStyle::Plain, "first");
        repaint.finish(ThreadLogStyle::Warning, "second");

        assert_eq!(recv_output(&rx), "first");
        assert_eq!(recv_output(&rx), "\r\x1b[2K\x1b[33msecond\x1b[0m");
        assert_eq!(recv_output(&rx), "\r\n");
    }

    #[test]
    fn block_repaint_rewinds_previous_frame() {
        let (output, rx) = output();
        let mut repaint = output.log().block_repaint();

        repaint.render(ThreadLogStyle::Plain, ["a", "b"]);
        repaint.render(ThreadLogStyle::Info, ["c"]);
        repaint.finish();

        assert_eq!(recv_output(&rx), "a\r\n");
        assert_eq!(recv_output(&rx), "b\r\n");
        assert_eq!(recv_output(&rx), "\x1b[2F\x1b[J");
        assert_eq!(recv_output(&rx), "\x1b[36mc\x1b[0m\r\n");
    }

    #[test]
    fn progress_bar_clamps_total_width_and_current() {
        let (output, rx) = output();
        let mut bar = ThreadProgressBar::new(output, "progress", 0, 0);

        bar.set(5, "detail");
        bar.finish(ThreadLogStyle::Success, "done");

        let rendered = recv_output(&rx);
        assert!(rendered.contains("\x1b[36m100%\x1b[0m"));
        assert!(rendered.contains("\x1b[35m━\x1b[0m"));
        assert!(rendered.contains("\x1b[90mdetail\x1b[0m"));
        assert_eq!(recv_output(&rx), "\r\x1b[2K\x1b[32mdone\x1b[0m\r\n");
    }

    #[test]
    fn progress_bar_drop_marks_interrupted_when_rendered() {
        let (output, rx) = output();

        {
            let mut bar = ThreadProgressBar::new(output, "progress", 10, 4);
            bar.set(2, "");
        }

        let _ = recv_output(&rx);
        assert_eq!(
            recv_output(&rx),
            "\r\x1b[2K\x1b[33mprogress interrupted\x1b[0m\r\n"
        );
    }

    #[test]
    fn scoped_progress_bar_finishes_success_and_error() {
        let (output, rx) = output();

        let ok = output.with_progress_bar("progress", 10, 4, "done", |bar| {
            bar.inc(10, "");
            Ok::<_, String>(42)
        });
        assert_eq!(ok.unwrap(), 42);
        let _ = recv_output(&rx);
        assert_eq!(recv_output(&rx), "\r\x1b[2K\x1b[32mdone\x1b[0m\r\n");

        let err = output.with_progress_bar("progress", 10, 4, "done", |bar| {
            bar.inc(1, "");
            Err::<(), _>("cancelled by user".to_string())
        });
        assert_eq!(err.unwrap_err(), "cancelled by user");
        let _ = recv_output(&rx);
        assert_eq!(
            recv_output(&rx),
            "\r\x1b[2K\x1b[33mcancelled by user\x1b[0m\r\n"
        );
    }

    #[test]
    fn scoped_spinner_finishes_success_and_error() {
        let (output, rx) = output();

        let ok = output.with_spinner("spin", "done", |spinner| {
            spinner.set_detail("working");
            Ok::<_, String>(7)
        });
        assert_eq!(ok.unwrap(), 7);
        let final_line = recv_output(&rx);
        assert!(final_line.contains("\x1b[32mdone\x1b[0m"));

        let err = output.with_spinner("spin", "done", |_spinner| {
            Err::<(), _>("failed".to_string())
        });
        assert_eq!(err.unwrap_err(), "failed");
        let final_line = recv_output(&rx);
        assert!(final_line.contains("\x1b[31mfailed\x1b[0m"));
    }

    #[test]
    fn spawn_thread_task_completes_successfully() {
        let inner = active_state();
        let (renderer_tx, renderer_rx) = mpsc::channel();
        let (completion_tx, completion_rx) = mpsc::channel();
        let spec = create_thread_task("task", "region", 1, "Thread", "thread");

        spawn_thread_task(
            &inner,
            "session",
            spec,
            &renderer_tx,
            &completion_tx,
            (),
            |output, _cancel, ()| {
                output.write("ok");
                Ok(())
            },
        )
        .unwrap();

        assert!(matches!(
            renderer_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            RendererEvent::TaskStarted(_)
        ));
        let completion = completion_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(completion.task_id, "task");
        assert!(completion.success);
        assert!(inner.lock().unwrap().tasks.is_empty());
        let (status, error) = recv_finished(&renderer_rx);
        assert_eq!(status, "success");
        assert_eq!(error, None);
    }

    #[test]
    fn spawn_thread_task_reports_failures_panics_and_cancellations() {
        type TestJob =
            Box<dyn FnOnce(ThreadOutput, Arc<AtomicBool>, ()) -> Result<(), String> + Send>;

        let cases: Vec<(&str, bool, TestJob)> = vec![
            (
                "failed",
                true,
                Box::new(|_output, _cancel, ()| Err("boom".to_string())),
            ),
            (
                "failed",
                true,
                Box::new(|_output, _cancel, ()| panic!("boom")),
            ),
            (
                "stopped",
                false,
                Box::new(|_output, cancel, ()| {
                    cancel.store(true, Ordering::Relaxed);
                    Ok(())
                }),
            ),
        ];

        for (expected_status, expect_error, job) in cases {
            let inner = active_state();
            let (renderer_tx, renderer_rx) = mpsc::channel();
            let (completion_tx, completion_rx) = mpsc::channel();
            let spec = create_thread_task("task", "region", 1, "Thread", "thread");

            spawn_thread_task(
                &inner,
                "session",
                spec,
                &renderer_tx,
                &completion_tx,
                (),
                job,
            )
            .unwrap();

            let completion = completion_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(!completion.success);
            let (status, error) = recv_finished(&renderer_rx);
            assert_eq!(status, expected_status);
            if expect_error {
                assert!(error.is_some());
            } else {
                assert_eq!(error, None);
            }
        }
    }

    #[test]
    fn spawn_thread_task_rejects_stale_sessions() {
        let inner = Arc::new(Mutex::new(TermState::default()));
        let (renderer_tx, renderer_rx) = mpsc::channel();
        let (completion_tx, _completion_rx) = mpsc::channel();
        let spec = create_thread_task("task", "region", 1, "Thread", "thread");

        let error = spawn_thread_task(
            &inner,
            "session",
            spec,
            &renderer_tx,
            &completion_tx,
            (),
            |_output, _cancel, ()| Ok(()),
        )
        .unwrap_err();

        assert_eq!(error, "stale term session");
        assert!(renderer_rx.try_recv().is_err());
        assert!(inner.lock().unwrap().tasks.is_empty());
    }
}
