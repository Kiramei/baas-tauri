use crate::{
    android_backend_service,
    behavior::{disable_f5_press_event, BehaviorState},
    mobile_commands,
    pipe_commands::BackendPipeManager,
    shm_commands::BackendShmManager,
    system_logs::{initialize_system_logs, system_log},
};
use baas_updater::android::AndroidUpdaterTermManager;
use tauri::{Builder, Manager, Wry};

pub(crate) fn trace(stage: &str) {
    #[link(name = "log")]
    unsafe extern "C" {
        fn __android_log_write(
            priority: i32,
            tag: *const std::ffi::c_char,
            text: *const std::ffi::c_char,
        ) -> i32;
    }
    if let Ok(text) = std::ffi::CString::new(stage) {
        unsafe {
            __android_log_write(4, c"BAASStartup".as_ptr(), text.as_ptr());
        }
    }
}

pub(crate) fn run(builder: Builder<Wry>) {
    let builder = builder.plugin(android_backend_service::init());
    trace("context_start");
    let context = tauri::generate_context!();
    trace("context_ready");
    let app = builder
        .setup(|app| {
            let log_state = initialize_system_logs(app.handle()).map_err(std::io::Error::other)?;
            app.manage(log_state);
            system_log("INFO", "lifecycle", "Mobile setup started");
            app.manage(BehaviorState);
            app.manage(AndroidUpdaterTermManager::default());
            mobile_commands::start_android_bootstrap_installer(app.handle())
                .map_err(std::io::Error::other)?;
            app.manage(BackendPipeManager::default());
            app.manage(BackendShmManager::default());
            disable_f5_press_event(app);
            system_log("INFO", "lifecycle", "Mobile setup completed");
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application");

    app.run(|_app, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            system_log("INFO", "lifecycle", "Mobile Tauri exit requested");
        }
    });
}
