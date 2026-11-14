use crate::{
    behavior::{self, disable_f5_press_event, inject_tray_icon, BehaviorState},
    commands::{configure_portable_working_dir, ensure_default_config, BackendProcessManager},
    native_window_controls,
    pipe_commands::BackendPipeManager,
    shm_commands::BackendShmManager,
    system_logs::{initialize_system_logs, system_log},
};
#[cfg(windows)]
#[path = "windows/window_material.rs"]
mod window_material;
use baas_shortcut::{install_global_shortcut_plugin, ShortcutRegistry};
use baas_updater::app::UpdaterTermManager;
use tauri::{Builder, Manager, RunEvent, Wry};

pub(crate) fn run(builder: Builder<Wry>) {
    let app = builder
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
            native_window_controls::initialize(app.handle());
            #[cfg(windows)]
            window_material::initialize(app.handle());
            configure_portable_working_dir().map_err(std::io::Error::other)?;
            app.manage(ShortcutRegistry::default());
            install_global_shortcut_plugin(app.handle()).map_err(std::io::Error::other)?;

            // Add tray icon to the app
            let tray_menu = inject_tray_icon(app).ok();
            app.manage(BehaviorState::with_tray_menu(tray_menu));

            let config_manager =
                ensure_default_config(app.handle()).map_err(std::io::Error::other)?;
            app.manage(BackendPipeManager::default());
            app.manage(BackendShmManager::default());
            app.manage(UpdaterTermManager::default());
            let backend = BackendProcessManager::default();
            let _ = backend.stop_for_config(&config_manager.config);
            let _ = backend.remember_config(&config_manager.config);
            app.manage(backend);
            disable_f5_press_event(app);
            system_log("INFO", "lifecycle", "Desktop setup completed");
            Ok(())
        })
        .on_window_event(behavior::handle_main_window_event)
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
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
            let pipe = app.state::<BackendPipeManager>();
            let _ = pipe.close_all();
            let shm = app.state::<BackendShmManager>();
            let _ = shm.close_all();
        }
        _ => {}
    });
}
