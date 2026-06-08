#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod file;
mod installer;

use std::error::Error;
use crate::installer::InstallerManager;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, WindowEvent,
};
use tokio::sync::Mutex;

#[tauri::command]
async fn splash_off(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        main.center().ok();
        main.show().ok();
        main.set_focus().ok();
    } else {
        eprintln!("⚠️ main window not found when calling splash_off()");
    }
}

fn inject_tray_icon(app: &mut App) -> Result<(), Box<dyn Error>> {
    let show_i = MenuItem::with_id(app, "show", "Show Main Window", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();

                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            splash_off,
            file::export_log_for_profile,
            installer::manager::start_installer,
            installer::manager::get_default_path,
            installer::manager::get_default_config
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Add tray icon to the app
            inject_tray_icon(app)?;

            let handle = app.handle().clone();
            let installer_manager = InstallerManager::new(handle);
            app.manage(Arc::new(Mutex::new(installer_manager)));
            let _win = app
                .get_webview_window("main")
                .expect("window 'main' not found");

            // Disable F5 Refresh
            #[cfg(not(debug_assertions))]
            {
                let harden_js = r#"
                  (function () {
                    addEventListener('keydown', function (e) {
                      const key = e.key && e.key.toLowerCase();
                      const isReload = (e.key === 'F5') ||
                                       (e.ctrlKey && key === 'r') ||
                                       (e.metaKey && key === 'r');
                      if (isReload) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        e.stopPropagation();
                        console.log('[prod] reload blocked');
                      }
                    }, { capture: true });

                    addEventListener('beforeunload', function (e) {
                      e.preventDefault();
                      e.returnValue = '';
                    }, { capture: true });
                  })();
                "#;
                _win.eval(harden_js).ok();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
