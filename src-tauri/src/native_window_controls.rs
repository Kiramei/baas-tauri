//! Native GTK caption controls over the application's HTML title bar.
//!
//! GTK owns the buttons, theme, actions, and accessibility. The webview only
//! receives their measured bounds so its menus can leave room for them.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowControlsState {
    available: bool,
    start_width: i32,
    end_width: i32,
    height: i32,
}

impl Default for NativeWindowControlsState {
    fn default() -> Self {
        Self {
            available: false,
            start_width: 0,
            end_width: 0,
            height: 44,
        }
    }
}

#[derive(Clone, Default)]
struct SharedMetrics(Arc<Mutex<NativeWindowControlsState>>);

pub fn initialize(app: &AppHandle) {
    app.manage(SharedMetrics::default());
    #[cfg(target_os = "linux")]
    if let Err(error) = linux::initialize(app) {
        crate::system_logs::system_log("WARNING", "native_window_controls", error);
    }
}

#[tauri::command]
pub fn native_window_controls_state(app: AppHandle) -> NativeWindowControlsState {
    app.try_state::<SharedMetrics>()
        .and_then(|state| state.inner().0.lock().ok().map(|metrics| *metrics))
        .unwrap_or_default()
}

#[tauri::command]
pub fn native_window_controls_set_blocked(app: AppHandle, blocked: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return app
        .run_on_main_thread(move || linux::set_blocked(blocked))
        .map_err(|error| error.to_string());

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, blocked);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{NativeWindowControlsState, SharedMetrics};
    use gtk::{gdk, glib, prelude::*};
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };
    use tauri::{AppHandle, Emitter, Manager};

    const METRICS_EVENT: &str = "native-window-controls-changed";
    const TITLEBAR_HEIGHT: i32 = 44;

    thread_local! {
        // GTK objects never enter Tauri's Send + Sync application state.
        static CONTROLS: RefCell<Option<Rc<NativeControls>>> = const { RefCell::new(None) };
    }

    struct NativeControls {
        app: AppHandle,
        metrics: SharedMetrics,
        start: gtk::HeaderBar,
        end: gtk::HeaderBar,
        settings: gtk::Settings,
        settings_signals: RefCell<Vec<glib::SignalHandlerId>>,
        fullscreen: Cell<bool>,
        has_start: Cell<bool>,
        has_end: Cell<bool>,
    }

    impl NativeControls {
        fn refresh_layout(&self) {
            let layout = self
                .settings
                .gtk_decoration_layout()
                .unwrap_or_else(|| ":minimize,maximize,close".into());
            let (start, end) = layout.split_once(':').unwrap_or((&layout, ""));
            // App menus already live in HTML; these widgets provide only the
            // system's caption buttons, retaining their order and chosen side.
            let caption_buttons = |side: &str| {
                side.split(',')
                    .map(str::trim)
                    .filter(|button| matches!(*button, "minimize" | "maximize" | "close"))
                    .collect::<Vec<_>>()
                    .join(",")
            };
            let start = caption_buttons(start);
            let end = caption_buttons(end);
            self.has_start.set(!start.is_empty());
            self.has_end.set(!end.is_empty());
            self.start.set_decoration_layout(Some(&format!("{start}:")));
            self.end.set_decoration_layout(Some(&format!(":{end}")));
            self.apply_visibility();
            self.start.queue_resize();
            self.end.queue_resize();
            if let Some(overlay) = self.start.parent() {
                overlay.queue_resize();
            }
            self.publish_metrics();
        }

        fn apply_visibility(&self) {
            self.start
                .set_visible(self.has_start.get() && !self.fullscreen.get());
            self.end
                .set_visible(self.has_end.get() && !self.fullscreen.get());
        }

        fn publish_metrics(&self) {
            let measure = |bar: &gtk::HeaderBar| {
                if !bar.is_visible() {
                    return (0, TITLEBAR_HEIGHT);
                }
                // A newly shown widget has not received its first allocation.
                // Later size-allocate signals replace this initial estimate
                // with the actual native allocation, including theme padding.
                let width = match bar.allocated_width() {
                    width if width > 1 => width,
                    _ => bar.preferred_width().1,
                };
                let height = bar.allocated_height().max(bar.preferred_height().1);
                (width, height.max(TITLEBAR_HEIGHT))
            };
            let (start_width, start_height) = measure(&self.start);
            let (end_width, end_height) = measure(&self.end);
            let next = NativeWindowControlsState {
                available: true,
                start_width,
                end_width,
                height: start_height.max(end_height),
            };
            let changed = self.metrics.0.lock().is_ok_and(|mut metrics| {
                if *metrics == next {
                    return false;
                }
                *metrics = next;
                true
            });
            if changed {
                let _ = self.app.emit_to("main", METRICS_EVENT, next);
            }
        }
    }

    impl Drop for NativeControls {
        fn drop(&mut self) {
            for signal in self.settings_signals.get_mut().drain(..) {
                self.settings.disconnect(signal);
            }
        }
    }

    fn header_bar(align: gtk::Align, provider: &gtk::CssProvider) -> gtk::HeaderBar {
        let bar = gtk::HeaderBar::new();
        bar.set_show_close_button(true);
        bar.set_has_subtitle(false);
        bar.set_custom_title(Some(&gtk::Box::new(gtk::Orientation::Horizontal, 0)));
        bar.set_halign(align);
        bar.set_valign(gtk::Align::Start);
        bar.set_size_request(-1, TITLEBAR_HEIGHT);
        bar.set_no_show_all(true);
        let context = bar.style_context();
        context.add_class("titlebar");
        context.add_class("default-decoration");
        context.add_class("baas-native-window-controls");
        context.add_provider(provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        bar
    }

    pub(super) fn initialize(app: &AppHandle) -> Result<(), String> {
        let main = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window is unavailable".to_string())?;
        let app = app.clone();
        let target = main.clone();
        main.with_webview(move |webview| {
            // Obtain and rearrange all GTK objects together on the GTK thread.
            // No native widget is captured by this Send callback.
            if let Err(error) = attach(&app, &target, webview.inner().upcast::<gtk::Widget>()) {
                crate::system_logs::system_log("WARNING", "native_window_controls", error);
            }
        })
        .map_err(|error| error.to_string())
    }

    fn attach(
        app: &AppHandle,
        main: &tauri::WebviewWindow,
        webview: gtk::Widget,
    ) -> Result<(), String> {
        let window = main.gtk_window().map_err(|error| error.to_string())?;
        let vbox = main.default_vbox().map_err(|error| error.to_string())?;
        if webview.parent().as_ref() != Some(vbox.upcast_ref::<gtk::Widget>())
            || window.child().as_ref() != Some(vbox.upcast_ref::<gtk::Widget>())
        {
            return Err(
                "Unexpected GTK webview hierarchy; native controls were not attached".into(),
            );
        }
        let initial_size = window.size();
        let fullscreen = main.is_fullscreen().unwrap_or(false);
        let restore_size = !window.is_maximized() && !fullscreen;
        let settings = window
            .settings()
            .ok_or_else(|| "GTK settings are unavailable".to_string())?;
        let provider = gtk::CssProvider::new();
        // Only the hosting container is transparent. GTK's titlebutton/image
        // nodes keep every style and icon supplied by the current system theme.
        provider
            .load_from_data(
                b"headerbar.baas-native-window-controls {\
                    min-height: 0; padding: 0 6px; margin: 0;\
                    background: transparent; border: none; box-shadow: none;\
                }",
            )
            .map_err(|error| error.to_string())?;
        let start = header_bar(gtk::Align::Start, &provider);
        let end = header_bar(gtk::Align::End, &provider);
        let overlay = gtk::Overlay::new();
        // Tauri's GTK undecorated mouse/touch handlers require the webview's
        // grandparent to be the GtkWindow. Keep that exact depth by making the
        // webview the first full-size overlay child, rather than nesting its
        // original vbox beneath an additional overlay. The original vbox stays
        // as the main child for Tauri's native references and window constraints.
        // Detach the webview first so even the intermediate hierarchy cannot
        // reach the runtime's unchecked GtkWindow downcast with an extra layer.
        vbox.remove(&webview);
        window.remove(&vbox);
        overlay.add(&vbox);
        webview.set_halign(gtk::Align::Fill);
        webview.set_valign(gtk::Align::Fill);
        webview.set_hexpand(true);
        webview.set_vexpand(true);
        overlay.add_overlay(&webview);
        overlay.add_overlay(&start);
        overlay.add_overlay(&end);
        window.add(&overlay);
        overlay.show();
        webview.show();
        if restore_size {
            window.resize(initial_size.0, initial_size.1);
        }

        let controls = Rc::new(NativeControls {
            app: app.clone(),
            metrics: app.state::<SharedMetrics>().inner().clone(),
            start,
            end,
            settings,
            settings_signals: RefCell::new(Vec::new()),
            fullscreen: Cell::new(fullscreen),
            has_start: Cell::new(false),
            has_end: Cell::new(false),
        });

        for bar in [&controls.start, &controls.end] {
            let weak = Rc::downgrade(&controls);
            bar.connect_size_allocate(move |_, _| {
                if let Some(controls) = weak.upgrade() {
                    controls.publish_metrics();
                }
            });
            let weak = Rc::downgrade(&controls);
            bar.connect_style_updated(move |_| {
                if let Some(controls) = weak.upgrade() {
                    controls.publish_metrics();
                }
            });
        }

        let weak = Rc::downgrade(&controls);
        let layout_signal = controls
            .settings
            .connect_gtk_decoration_layout_notify(move |_| {
                if let Some(controls) = weak.upgrade() {
                    controls.refresh_layout();
                }
            });
        let weak = Rc::downgrade(&controls);
        let theme_signal = controls.settings.connect_gtk_theme_name_notify(move |_| {
            if let Some(controls) = weak.upgrade() {
                controls.refresh_layout();
            }
        });
        let weak = Rc::downgrade(&controls);
        let icon_signal = controls
            .settings
            .connect_gtk_icon_theme_name_notify(move |_| {
                if let Some(controls) = weak.upgrade() {
                    controls.refresh_layout();
                }
            });
        controls
            .settings_signals
            .borrow_mut()
            .extend([layout_signal, theme_signal, icon_signal]);

        let weak = Rc::downgrade(&controls);
        window.connect_window_state_event(move |_, event| {
            if let Some(controls) = weak.upgrade() {
                controls.fullscreen.set(
                    event
                        .new_window_state()
                        .contains(gdk::WindowState::FULLSCREEN),
                );
                controls.apply_visibility();
                controls.publish_metrics();
            }
            glib::Propagation::Proceed
        });
        // An overlay HeaderBar is not GtkWindow's designated titlebar, so also
        // refresh when native window capabilities change at runtime.
        let weak = Rc::downgrade(&controls);
        window.connect_resizable_notify(move |_| {
            if let Some(controls) = weak.upgrade() {
                controls.refresh_layout();
            }
        });
        let weak = Rc::downgrade(&controls);
        window.connect_deletable_notify(move |_| {
            if let Some(controls) = weak.upgrade() {
                controls.refresh_layout();
            }
        });
        window.connect_destroy(|_| {
            CONTROLS.with(|controls| {
                controls.borrow_mut().take();
            });
        });
        controls.refresh_layout();
        CONTROLS.with(|slot| slot.replace(Some(controls)));
        crate::system_logs::system_log(
            "INFO",
            "native_window_controls",
            "GTK system-themed caption controls attached to the main window",
        );
        Ok(())
    }

    pub(super) fn set_blocked(blocked: bool) {
        CONTROLS.with(|slot| {
            if let Some(controls) = slot.borrow().as_ref() {
                for bar in [&controls.start, &controls.end] {
                    bar.set_sensitive(!blocked);
                    bar.set_opacity(if blocked { 0.4 } else { 1.0 });
                }
            }
        });
    }
}
