#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

#[cfg(target_os = "android")]
mod android_backend_service;
#[cfg(target_os = "android")]
mod android_bootstrap_installer;
#[cfg(any(target_os = "android", test))]
mod android_client_update;
use baas_updater::mirrorc_credentials;
mod mirrorc_validation;
mod behavior;
mod client_version;
#[cfg(target_os = "linux")]
#[path = "platform/linux_package.rs"]
mod linux_package;
#[cfg(not(mobile))]
mod commands;
mod file_commands;
#[cfg(target_os = "android")]
mod mobile_commands;
#[cfg(any(target_os = "android", test))]
mod mobile_plugin_ack;
#[cfg(any(target_os = "android", test))]
mod mobile_update_query;
mod native_window_controls;
mod notifier_commands;
#[cfg(windows)]
#[path = "platform/windows/client_update.rs"]
mod portable_client_update;
mod pipe_commands;
mod shm_commands;
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
mod shm_native;
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
mod shm_protocol;
mod system_logs;

/// Runs the private portable updater before creating any window or WebView.
#[cfg(windows)]
pub fn handle_portable_update_helper() -> Option<i32> {
    portable_client_update::helper_mode()
}

#[cfg(target_os = "android")]
#[path = "platform/android.rs"]
mod platform;
#[cfg(not(mobile))]
#[path = "platform/desktop.rs"]
mod platform;

#[cfg(all(mobile, not(target_os = "android")))]
compile_error!("BAAS mobile builds currently support Android only.");

use crate::behavior::{set_backend_locale, set_minimize_to_tray, splash_off};
#[cfg(not(mobile))]
use crate::commands::{
    tauri_client_update_ready,
    android_cleanup_scrcpy_virtual_display, android_game_fullscreen, android_game_gesture,
    android_game_native_preview, android_game_preview, android_game_resume_automation,
    android_game_screenshot, android_game_stream_info, android_launch_game, android_list_games,
    android_open_shizuku, android_prepare_scrcpy_virtual_display,
    android_request_shizuku_permission, android_scrcpy_virtual_display_status,
    android_set_system_bars, android_shizuku_status, backend_transport_start, open_main_devtools,
    shortcut_apply_bindings, tauri_client_check_update, tauri_client_download_and_install,
    updater_abort_workflow, updater_check_version, updater_get_commit_history,
    updater_get_startup_state, updater_get_storage_state, updater_path_exists_non_empty,
    updater_reset_backend_auth_and_restart, updater_resize_term, updater_start_workflow,
    updater_terminal_snapshot, updater_test_sha_method, updater_test_sha_methods,
    updater_update_config, updater_validate_mirrorc_cdk,
};
use crate::file_commands::open_backend_config_folder;
#[cfg(target_os = "android")]
use crate::mobile_commands::{
    android_cleanup_scrcpy_virtual_display, android_game_fullscreen, android_game_gesture,
    android_game_native_preview, android_game_preview, android_game_resume_automation,
    android_game_screenshot, android_game_stream_info, android_launch_game, android_list_games,
    android_list_profile_folder, android_pick_profile_folder,
    android_open_shizuku, android_prepare_scrcpy_virtual_display,
    android_request_shizuku_permission, android_scrcpy_virtual_display_status,
    android_set_system_bars, android_shizuku_status, backend_transport_start, open_main_devtools,
    shortcut_apply_bindings, tauri_client_check_update, tauri_client_download_and_install,
    updater_abort_workflow, updater_check_version, updater_get_commit_history,
    updater_get_startup_state, updater_get_storage_state, updater_path_exists_non_empty,
    updater_reset_backend_auth_and_restart, updater_resize_term, updater_restart_backend,
    updater_select_channel, updater_start_workflow, updater_terminal_snapshot,
    updater_test_sha_method, updater_test_sha_methods, updater_update_config,
    updater_validate_mirrorc_cdk,
};
use crate::native_window_controls::{
    native_window_controls_set_blocked, native_window_controls_state,
};
use crate::notifier_commands::baas_notify;
use crate::pipe_commands::{
    backend_pipe_close, backend_pipe_close_all, backend_pipe_open, backend_pipe_send_bytes,
    backend_pipe_send_json,
};
use crate::shm_commands::{
    backend_shm_close, backend_shm_close_all, backend_shm_open, backend_shm_send_bytes,
    backend_shm_send_json,
};
use crate::system_logs::{
    install_panic_logging, system_logs_clear, system_logs_ingest_frontend, system_logs_snapshot,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    platform::trace("rust_entry");
    install_panic_logging();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(baas_notifier::init_plugin())
        .invoke_handler(tauri::generate_handler![
            baas_notify,
            native_window_controls_state,
            native_window_controls_set_blocked,
            splash_off,
            set_backend_locale,
            open_backend_config_folder,
            set_minimize_to_tray,
            updater_get_storage_state,
            updater_get_startup_state,
            updater_path_exists_non_empty,
            updater_update_config,
            updater_validate_mirrorc_cdk,
            tauri_client_check_update,
            tauri_client_download_and_install,
            #[cfg(not(mobile))]
            tauri_client_update_ready,
            updater_check_version,
            updater_get_commit_history,
            updater_test_sha_method,
            updater_test_sha_methods,
            updater_start_workflow,
            #[cfg(target_os = "android")]
            updater_select_channel,
            #[cfg(target_os = "android")]
            updater_restart_backend,
            updater_reset_backend_auth_and_restart,
            backend_transport_start,
            backend_pipe_open,
            backend_pipe_send_json,
            backend_pipe_send_bytes,
            backend_pipe_close,
            backend_pipe_close_all,
            backend_shm_open,
            backend_shm_send_json,
            backend_shm_send_bytes,
            backend_shm_close,
            backend_shm_close_all,
            updater_abort_workflow,
            updater_terminal_snapshot,
            updater_resize_term,
            shortcut_apply_bindings,
            open_main_devtools,
            android_prepare_scrcpy_virtual_display,
            android_cleanup_scrcpy_virtual_display,
            android_scrcpy_virtual_display_status,
            #[cfg(target_os = "android")]
            android_pick_profile_folder,
            #[cfg(target_os = "android")]
            android_list_profile_folder,
            android_list_games,
            android_launch_game,
            android_game_preview,
            android_game_native_preview,
            android_game_fullscreen,
            android_game_resume_automation,
            android_game_stream_info,
            android_game_screenshot,
            android_game_gesture,
            android_shizuku_status,
            android_request_shizuku_permission,
            android_open_shizuku,
            android_set_system_bars,
            system_logs_snapshot,
            system_logs_clear,
            system_logs_ingest_frontend
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    platform::run(builder);
}
