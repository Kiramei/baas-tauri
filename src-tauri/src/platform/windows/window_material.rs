//! Windows compositor preferences and verification for the custom window frame.
//! Acrylic itself is requested through Tauri's Windows window-effects config.

use crate::system_logs::system_log;
use std::mem::size_of;
use tauri::{AppHandle, Manager};
use windows::Win32::{
    Foundation::HWND,
    Graphics::Dwm::{
        DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DWMWINDOWATTRIBUTE,
    },
};

/// Request compositor rounding and record the actual native material settings.
/// Older Windows versions may reject these preferences; startup still succeeds.
pub fn initialize(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        system_log("WARNING", "window_material", "Main window is unavailable");
        return;
    };
    let hwnd = match window.hwnd() {
        Ok(hwnd) => HWND(hwnd.0),
        Err(error) => {
            system_log(
                "WARNING",
                "window_material",
                format!("Cannot access the main window handle: {error}"),
            );
            return;
        }
    };
    let preference = DWMWCP_ROUND;
    // SAFETY: hwnd belongs to the live main window, and the attribute value is
    // a DWM_WINDOW_CORNER_PREFERENCE whose address remains valid for this call.
    if let Err(error) = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&preference).cast(),
            size_of::<i32>() as u32,
        )
    } {
        system_log(
            "WARNING",
            "window_material",
            format!("DWM rounded-corner preference is unavailable: {error}"),
        );
    }

    let backdrop = read_attribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, "system backdrop");
    let corners = read_attribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, "corner preference");
    system_log(
        "INFO",
        "window_material",
        format!(
            "DWM material verification backdrop_type={backdrop:?} (3=acrylic) \
             corner_preference={corners:?} (2=round)"
        ),
    );
}

fn read_attribute(hwnd: HWND, attribute: DWMWINDOWATTRIBUTE, name: &str) -> Option<i32> {
    let mut value = 0_i32;
    // SAFETY: these DWM attributes each return a 32-bit enum value. The output
    // points to initialized, correctly sized storage for the duration of call.
    match unsafe {
        DwmGetWindowAttribute(
            hwnd,
            attribute,
            (&mut value as *mut i32).cast(),
            size_of::<i32>() as u32,
        )
    } {
        Ok(()) => Some(value),
        Err(error) => {
            system_log(
                "WARNING",
                "window_material",
                format!("Cannot read DWM {name}: {error}"),
            );
            None
        }
    }
}
