use crate::system_logs::system_log;
#[cfg(not(mobile))]
use baas_i18n::{tray_menu_labels, Language};
#[cfg(not(mobile))]
use std::{
    error::Error,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
#[cfg(not(mobile))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{App, AppHandle, Manager, State};

#[cfg(not(mobile))]
#[derive(Default)]
pub struct BehaviorState {
    pub tray_enabled: bool,
    pub minimize_to_tray: AtomicBool,
    tray_menu: Mutex<Option<TrayMenuItems>>,
}

#[cfg(mobile)]
#[derive(Default)]
pub struct BehaviorState;

#[cfg(not(mobile))]
pub struct TrayMenuItems {
    language: Language,
    show_item: MenuItem<tauri::Wry>,
    hide_item: MenuItem<tauri::Wry>,
    quit_item: MenuItem<tauri::Wry>,
}

#[cfg(not(mobile))]
impl BehaviorState {
    /// Handles the with tray menu workflow.
    pub fn with_tray_menu(tray_menu: Option<TrayMenuItems>) -> Self {
        Self {
            tray_enabled: tray_menu.is_some(),
            minimize_to_tray: AtomicBool::new(false),
            tray_menu: Mutex::new(tray_menu),
        }
    }

    /// Performs the set language operation.
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
        menu.hide_item
            .set_text(labels.hide_main_window)
            .map_err(|error| error.to_string())?;

        Ok(())
    }
}

/// Frontend persists this preference and reapplies it after startup.
#[tauri::command]
pub fn set_minimize_to_tray(state: State<'_, BehaviorState>, enabled: bool) -> bool {
    #[cfg(not(mobile))]
    {
        state.minimize_to_tray.store(enabled, Ordering::Relaxed);
        state.tray_enabled
    }
    #[cfg(mobile)]
    {
        let _ = (state, enabled);
        false
    }
}

#[cfg(not(mobile))]
pub fn handle_main_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let state = window.state::<BehaviorState>();
    if !state.tray_enabled {
        return;
    }
    if matches!(event, tauri::WindowEvent::Resized(_))
        && state.minimize_to_tray.load(Ordering::Relaxed)
        && window.is_minimized().unwrap_or(false)
    {
        let _ = window.hide();
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        system_log(
            "INFO",
            "window",
            "Main window close requested; hiding to tray",
        );
        // If hiding fails, leave the original close operation available.
        if window.hide().is_ok() {
            api.prevent_close();
        }
    }
}

#[cfg(not(mobile))]
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(not(mobile))]
pub fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

/// Handles the splash off workflow.
#[tauri::command]
pub async fn splash_off(app: AppHandle) {
    system_log("DEBUG", "window", "Splash close requested");
    if let Some(main) = app.get_webview_window("main") {
        // This causes `create webview window` malfunction.
        // main.center().ok();
        main.show().ok();
        main.set_focus().ok();
    } else {
        eprintln!("⚠️ main window not found when calling splash_off()");
    }
}

/// Performs the set backend locale operation.
#[cfg(not(mobile))]
#[tauri::command]
pub fn set_backend_locale(state: State<'_, BehaviorState>, lang: String) -> Result<(), String> {
    system_log(
        "INFO",
        "locale",
        format!("Backend locale change requested lang={lang}"),
    );
    state.set_language(Language::parse(&lang))
}

/// Performs the set backend locale operation.
#[cfg(mobile)]
#[tauri::command]
pub fn set_backend_locale(_state: State<'_, BehaviorState>, _lang: String) -> Result<(), String> {
    system_log(
        "DEBUG",
        "locale",
        "Backend locale command ignored on mobile",
    );
    Ok(())
}

/// Handles the inject tray icon workflow.
#[cfg(not(mobile))]
pub fn inject_tray_icon(app: &mut App) -> Result<TrayMenuItems, Box<dyn Error>> {
    let language = Language::default();
    let labels = tray_menu_labels(language);
    let show_i = MenuItem::with_id(app, "show", labels.show_main_window, true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", labels.exit, true, None::<&str>)?;
    let hide_i = MenuItem::with_id(app, "hide", labels.hide_main_window, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

    TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .ok_or("Missing application tray icon")?
                .clone(),
        )
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                show_main_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
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
                toggle_main_window(app);
            }
        })
        .build(app)?;
    Ok(TrayMenuItems {
        language,
        show_item: show_i,
        hide_item: hide_i,
        quit_item: quit_i,
    })
}

/// Handles the disable f5 press event workflow.
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
                      if (window.__BAAS_ALLOW_RELOAD__) {
                        return;
                      }
                      e.preventDefault();
                      e.returnValue = '';
                    }, { capture: true });
                  })();
                "#;
        _win.eval(harden_js).ok();
    }
}
