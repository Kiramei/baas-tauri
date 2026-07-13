//! Terminal session orchestration for BAAS updater output.
//!
//! The crate owns the lower-level terminal primitives used by updater session
//! managers: process tasks, thread tasks, renderer events, and shared state.

/// Shared session and task-completion helpers.
pub mod common;
/// Shared constants controlling session, task, and renderer behavior.
pub mod constants;
/// PTY-backed process task support.
pub mod processor;
/// Terminal dashboard rendering support.
pub mod renderer;
/// In-process task and terminal-output helpers.
pub mod threader;
/// Shared task, renderer, and event payload types.
pub mod types;
/// Workflow graph declaration helpers.
pub mod workflow;
