use std::error::Error;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

#[derive(Default)]
pub struct BehaviorState {
    pub tray_enabled: bool,
}

#[tauri::command]
pub async fn splash_off(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        main.center().ok();
        main.show().ok();
        main.set_focus().ok();
    } else {
        eprintln!("⚠️ main window not found when calling splash_off()");
    }
}

pub fn inject_tray_icon(app: &mut App) -> Result<(), Box<dyn Error>> {
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

pub fn disable_f5_press_event(app: &mut App) {
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
}
