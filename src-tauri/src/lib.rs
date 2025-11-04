#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod file;

use tauri::{AppHandle, Manager};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            splash_off,
            file::export_log_for_profile
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
