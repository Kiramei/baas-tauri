use tauri::{AppHandle, State};
use baas_term::TermManager;
use baas_term::types::SessionMetadata;

#[tauri::command]
pub fn start_term_demo(
    app: AppHandle,
    manager: State<'_, TermManager>,
) -> Result<SessionMetadata, String> {
    manager.start(app)
}

#[tauri::command]
pub fn resize_term(
    manager: State<'_, TermManager>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    manager.resize(rows, cols)
}