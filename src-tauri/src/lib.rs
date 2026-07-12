#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod behavior;
#[cfg(not(mobile))]
mod commands;
#[cfg(target_os = "android")]
mod mobile_commands;
mod notifier_commands;
mod system_logs;

#[cfg(all(mobile, not(target_os = "android")))]
compile_error!("BAAS mobile builds currently support Android only.");

use crate::behavior::{disable_f5_press_event, set_backend_locale, splash_off, BehaviorState};
#[cfg(target_os = "android")]
use crate::mobile_commands::{
    android_cleanup_scrcpy_virtual_display, android_prepare_scrcpy_virtual_display,
    android_scrcpy_virtual_display_status, open_main_devtools, shortcut_apply_bindings,
    tauri_client_check_update, updater_abort_workflow, updater_check_version,
    updater_get_startup_state, updater_get_storage_state, updater_path_exists_non_empty,
    updater_reset_backend_auth_and_restart, updater_resize_term, updater_start_workflow,
    updater_terminal_snapshot, updater_test_sha_method, updater_test_sha_methods,
    updater_update_config, updater_validate_mirrorc_cdk,
};
use crate::notifier_commands::baas_notify;
use crate::system_logs::{
    initialize_system_logs, install_panic_logging, system_log, system_logs_clear,
    system_logs_ingest_frontend, system_logs_snapshot,
};
#[cfg(not(mobile))]
use crate::{
    behavior::inject_tray_icon,
    commands::{
        android_cleanup_scrcpy_virtual_display, android_prepare_scrcpy_virtual_display,
        android_scrcpy_virtual_display_status, configure_portable_working_dir,
        ensure_default_config, open_main_devtools, shortcut_apply_bindings,
        tauri_client_check_update, updater_abort_workflow, updater_check_version,
        updater_get_startup_state, updater_get_storage_state, updater_path_exists_non_empty,
        updater_reset_backend_auth_and_restart, updater_resize_term, updater_start_workflow,
        updater_terminal_snapshot, updater_test_sha_method, updater_test_sha_methods,
        updater_update_config, updater_validate_mirrorc_cdk, BackendProcessManager,
    },
};

#[cfg(not(mobile))]
use baas_shortcut::{install_global_shortcut_plugin, ShortcutRegistry};
#[cfg(target_os = "android")]
use baas_updater::android::AndroidUpdaterTermManager;
#[cfg(not(mobile))]
use baas_updater::app::UpdaterTermManager;
#[cfg(mobile)]
use tauri::Manager;
#[cfg(not(mobile))]
use tauri::{Manager, RunEvent, WindowEvent};

/// Performs the run operation.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_logging();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(baas_notifier::init_plugin())
        .invoke_handler(tauri::generate_handler![
            baas_notify,
            splash_off,
            set_backend_locale,
            updater_get_storage_state,
            updater_get_startup_state,
            updater_path_exists_non_empty,
            updater_update_config,
            updater_validate_mirrorc_cdk,
            tauri_client_check_update,
            updater_check_version,
            updater_test_sha_method,
            updater_test_sha_methods,
            updater_start_workflow,
            updater_reset_backend_auth_and_restart,
            updater_abort_workflow,
            updater_terminal_snapshot,
            updater_resize_term,
            shortcut_apply_bindings,
            open_main_devtools,
            android_prepare_scrcpy_virtual_display,
            android_cleanup_scrcpy_virtual_display,
            android_scrcpy_virtual_display_status,
            system_logs_snapshot,
            system_logs_clear,
            system_logs_ingest_frontend
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(not(mobile))]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            system_log(
                "INFO",
                "single_instance",
                "Existing application instance activated",
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let log_state = initialize_system_logs(app.handle()).map_err(std::io::Error::other)?;
            app.manage(log_state);
            system_log("INFO", "lifecycle", "Desktop setup started");
            configure_portable_working_dir().map_err(std::io::Error::other)?;
            app.manage(ShortcutRegistry::default());
            install_global_shortcut_plugin(app.handle()).map_err(std::io::Error::other)?;

            // Add tray icon to the app
            let tray_menu = inject_tray_icon(app).ok();
            app.manage(BehaviorState::with_tray_menu(tray_menu));

            let config_manager =
                ensure_default_config(app.handle()).map_err(std::io::Error::other)?;
            app.manage(UpdaterTermManager::default());
            let backend = BackendProcessManager::default();
            let _ = backend.stop_for_config(&config_manager.config);
            let _ = backend.remember_config(&config_manager.config);
            app.manage(backend);
            disable_f5_press_event(app);
            system_log("INFO", "lifecycle", "Desktop setup completed");
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
                system_log(
                    "INFO",
                    "window",
                    "Main window close requested; hiding to tray",
                );
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(mobile)]
    let builder = builder
        .setup(|app| {
            let log_state = initialize_system_logs(app.handle()).map_err(std::io::Error::other)?;
            app.manage(log_state);
            system_log("INFO", "lifecycle", "Mobile setup started");
            app.manage(BehaviorState::default());
            #[cfg(target_os = "android")]
            app.manage(AndroidUpdaterTermManager::default());
            disable_f5_press_event(app);
            system_log("INFO", "lifecycle", "Mobile setup completed");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(not(mobile))]
    builder.run(|app, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            system_log(
                "INFO",
                "lifecycle",
                "Tauri exit requested; stopping managed processes",
            );
            let updater = app.state::<UpdaterTermManager>();
            let _ = updater.abort(Default::default());
            let backend = app.state::<BackendProcessManager>();
            let _ = backend.stop_all();
        }
        _ => {}
    });

    #[cfg(mobile)]
    builder.run(|_app, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            system_log("INFO", "lifecycle", "Mobile Tauri exit requested");
        }
    });
}
