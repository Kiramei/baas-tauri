#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod behavior;
mod commands;

use crate::{
    behavior::{disable_f5_press_event, inject_tray_icon, splash_off, BehaviorState},
    commands::{
        ensure_default_config, updater_abort_workflow, updater_get_startup_state,
        updater_resize_term, updater_start_workflow, updater_update_config,
        updater_validate_mirrorc_cdk,
    },
};

use tauri::{Manager, WindowEvent};

use baas_updater::app::UpdaterTermManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            splash_off,
            updater_get_startup_state,
            updater_update_config,
            updater_validate_mirrorc_cdk,
            updater_start_workflow,
            updater_abort_workflow,
            updater_resize_term
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Add tray icon to the app
            let tray_enabled = inject_tray_icon(app).is_ok();
            app.manage(BehaviorState { tray_enabled });

            ensure_default_config().map_err(std::io::Error::other)?;
            app.manage(UpdaterTermManager::default());
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
