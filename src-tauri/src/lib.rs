#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod behavior;
mod commands;
mod installer;

use crate::{
    behavior::{disable_f5_press_event, inject_tray_icon, splash_off, BehaviorState},
    commands::{resize_term, start_term_demo},
    installer::{
        manager::{get_default_config, get_default_path, start_installer},
        InstallerManager,
    },
};

use std::sync::Arc;
use tauri::{Manager, WindowEvent};
use tokio::sync::Mutex;

use baas_term::TermManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TermManager::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            splash_off,
            start_installer,
            get_default_path,
            get_default_config,
            start_term_demo,
            resize_term
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Add tray icon to the app
            let tray_enabled = inject_tray_icon(app).is_ok();
            app.manage(BehaviorState { tray_enabled });

            let handle = app.handle().clone();
            let installer_manager = InstallerManager::new(handle);
            app.manage(Arc::new(Mutex::new(installer_manager)));
            disable_f5_press_event(app);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let state = window.state::<BehaviorState>();
            if !state.tray_enabled {
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
