//! Native GTK caption controls over the application's HTML title bar.
//!
//! GTK owns the buttons, theme, actions, and accessibility. The webview only
//! receives their measured bounds so its menus can leave room for them.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowControlsState {
    available: bool,
    start_width: i32,
    end_width: i32,
    height: i32,
}

impl Default for NativeWindowControlsState {
    fn default() -> Self {
        Self {
            available: false,
            start_width: 0,
            end_width: 0,
            height: 44,
        }
    }
}

#[derive(Clone, Default)]
struct SharedMetrics(Arc<Mutex<NativeWindowControlsState>>);

pub fn initialize(app: &AppHandle) {
    app.manage(SharedMetrics::default());
    #[cfg(target_os = "linux")]
    if let Err(error) = linux::initialize(app) {
        crate::system_logs::system_log("WARNING", "native_window_controls", error);
    }
}

#[tauri::command]
pub fn native_window_controls_state(app: AppHandle) -> NativeWindowControlsState {
    app.try_state::<SharedMetrics>()
        .and_then(|state| state.inner().0.lock().ok().map(|metrics| *metrics))
        .unwrap_or_default()
}

#[tauri::command]
pub fn native_window_controls_set_blocked(app: AppHandle, blocked: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return app
        .run_on_main_thread(move || linux::set_blocked(blocked))
        .map_err(|error| error.to_string());

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, blocked);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
#[path = "platform/linux/window_controls.rs"]
mod linux;
