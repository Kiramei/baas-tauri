//! Shared constants for terminal session orchestration and rendering.
//!
//! These values define public-facing behavior or cross-module timing/terminal
//! semantics. Demo-only sample data intentionally stays in `demo.rs`.

/// Default terminal row count used when a session starts before any resize.
pub const DEFAULT_TERMINAL_ROWS: u16 = 32;

/// Default terminal column count used when a session starts before any resize.
pub const DEFAULT_TERMINAL_COLS: u16 = 120;

/// Minimum row count accepted by the renderer viewport.
pub const MIN_TERMINAL_ROWS: u16 = 1;

/// Minimum column count accepted by the renderer viewport.
pub const MIN_TERMINAL_COLS: u16 = 1;

/// Pixel width passed to PTY resize calls when cell dimensions are unknown.
pub const PTY_PIXEL_WIDTH: u16 = 0;

/// Pixel height passed to PTY resize calls when cell dimensions are unknown.
pub const PTY_PIXEL_HEIGHT: u16 = 0;

/// Number of steps shown by the built-in demo flow.
pub const DEMO_STEP_TOTAL: u8 = 4;

/// Maximum number of recent output lines shown per region while tasks run.
pub const RUNNING_REGION_MAX_LINES: usize = 3;

/// Maximum number of historical lines retained per renderer region.
pub const REGION_MAX_KEPT_LINES: usize = 2_000;

/// Number of columns advanced by a tab character.
pub const TAB_WIDTH: usize = 4;

/// Read-buffer size used by PTY reader threads.
pub const PROCESS_READ_BUFFER_BYTES: usize = 4096;

/// Poll interval for checking process completion.
pub const PROCESS_WAIT_POLL_MS: u64 = 50;

/// Short delay after process exit before the final renderer event is sent.
pub const PROCESS_FINISH_SETTLE_MS: u64 = 80;

/// Interval between background spinner frames.
pub const THREAD_SPINNER_TICK_MS: u64 = 100;

/// Percentage value displayed for completed progress bars.
pub const PROGRESS_PERCENT_MAX: u64 = 100;

/// Fixed label column width used by thread progress bars.
pub const THREAD_PROGRESS_LABEL_WIDTH: usize = 18;

/// Terminal device-status-report request sequence.
pub const DEVICE_STATUS_REPORT_REQUEST: &[u8] = b"\x1b[6n";

/// Synthetic cursor-position response sent to commands that request DSR.
pub const DEVICE_STATUS_REPORT_RESPONSE: &[u8] = b"\x1b[1;1R";

/// Number of bytes to keep so split DSR requests can be detected.
pub const DEVICE_STATUS_REPORT_TAIL_BYTES: usize = DEVICE_STATUS_REPORT_REQUEST.len() - 1;

/// ANSI sequence that moves the cursor home and clears the dashboard.
pub const ANSI_DASHBOARD_RESET: &str = "\x1b[H\x1b[2J";

/// ANSI reset sequence appended to fitted renderer lines.
pub const ANSI_RESET: &str = "\x1b[0m";

/// ANSI sequence that returns to the line start and clears the current line.
pub const ANSI_CLEAR_LINE: &str = "\r\x1b[2K";

/// Status string for running sessions and tasks.
pub const STATUS_RUNNING: &str = "running";

/// Status string for successful tasks.
pub const STATUS_SUCCESS: &str = "success";

/// Status string for failed tasks.
pub const STATUS_FAILED: &str = "failed";

/// Status string for stopped tasks.
pub const STATUS_STOPPED: &str = "stopped";

/// Tauri event emitted when a session starts.
pub const EVENT_BUILD_SESSION_STARTED: &str = "build:session-started";

/// Tauri event emitted when a task starts.
pub const EVENT_TERM_TASK_STARTED: &str = "term:task-started";

/// Tauri event carrying rendered terminal chunks.
pub const EVENT_TERM_CHUNK: &str = "term:chunk";

/// Tauri event emitted when task status changes.
pub const EVENT_TERM_TASK_STATUS: &str = "term:task-status";

/// Tauri event emitted when the session finishes.
pub const EVENT_TERM_SESSION_FINISHED: &str = "term:session-finished";

/// Tauri event emitted when the updater backend is ready.
pub const EVENT_UPDATER_BACKEND_READY: &str = "updater://backend-ready";
