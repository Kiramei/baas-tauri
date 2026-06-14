use baas_i18n::{tray_menu_labels, Language};
use std::{error::Error, sync::Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, State,
};

#[derive(Default)]
pub struct BehaviorState {
    pub tray_enabled: bool,
    tray_menu: Mutex<Option<TrayMenuItems>>,
}

pub struct TrayMenuItems {
    language: Language,
    show_item: MenuItem<tauri::Wry>,
    quit_item: MenuItem<tauri::Wry>,
}

impl BehaviorState {
    pub fn with_tray_menu(tray_menu: Option<TrayMenuItems>) -> Self {
        Self {
            tray_enabled: tray_menu.is_some(),
            tray_menu: Mutex::new(tray_menu),
        }
    }

    fn set_language(&self, language: Language) -> Result<(), String> {
        let mut guard = self
            .tray_menu
            .lock()
            .map_err(|_| "tray menu state lock poisoned".to_string())?;
        let Some(menu) = guard.as_mut() else {
            return Ok(());
        };
        if menu.language == language {
            return Ok(());
        }

        let labels = tray_menu_labels(language);
        menu.show_item
            .set_text(labels.show_main_window)
            .map_err(|error| error.to_string())?;
        menu.quit_item
            .set_text(labels.exit)
            .map_err(|error| error.to_string())?;
        menu.language = language;

        Ok(())
    }
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

#[tauri::command]
pub fn set_backend_locale(state: State<'_, BehaviorState>, lang: String) -> Result<(), String> {
    state.set_language(Language::parse(&lang))
}

pub fn inject_tray_icon(app: &mut App) -> Result<TrayMenuItems, Box<dyn Error>> {
    let language = Language::default();
    let labels = tray_menu_labels(language);
    let show_i = MenuItem::with_id(app, "show", labels.show_main_window, true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", labels.exit, true, None::<&str>)?;
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
    Ok(TrayMenuItems {
        language,
        show_item: show_i,
        quit_item: quit_i,
    })
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
