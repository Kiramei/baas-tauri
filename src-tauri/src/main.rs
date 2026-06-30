// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

/// Handles the main workflow.
fn main() {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext;
        use windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2;
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).ok();
        }
    }
    #[cfg(target_os = "linux")]
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        // std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
    baas_tauri_lib::run()
}
