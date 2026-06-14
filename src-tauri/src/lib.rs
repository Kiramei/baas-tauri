#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod behavior;
mod commands;

use crate::{
    behavior::{disable_f5_press_event, inject_tray_icon, splash_off, BehaviorState},
    commands::{
        ensure_default_config, updater_abort_workflow, updater_get_startup_state,
        updater_reset_backend_auth_and_restart, updater_resize_term, updater_start_workflow,
        updater_terminal_snapshot, updater_update_config, updater_validate_mirrorc_cdk,
        BackendProcessManager,
    },
};

use tauri::{Manager, RunEvent, WindowEvent};

use baas_updater::app::UpdaterTermManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            splash_off,
            updater_get_startup_state,
            updater_update_config,
            updater_validate_mirrorc_cdk,
            updater_start_workflow,
            updater_reset_backend_auth_and_restart,
            updater_abort_workflow,
            updater_terminal_snapshot,
            updater_resize_term
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Add tray icon to the app
            let tray_enabled = inject_tray_icon(app).is_ok();
            app.manage(BehaviorState { tray_enabled });

            let config_manager =
                ensure_default_config(app.handle()).map_err(std::io::Error::other)?;
            app.manage(UpdaterTermManager::default());
            let backend = BackendProcessManager::default();
            let _ = backend.stop_for_config(&config_manager.config);
            let _ = backend.remember_config(&config_manager.config);
            app.manage(backend);
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                let updater = app.state::<UpdaterTermManager>();
                let _ = updater.abort(Default::default());
                let backend = app.state::<BackendProcessManager>();
                let _ = backend.stop_all();
            }
            _ => {}
        });
}
