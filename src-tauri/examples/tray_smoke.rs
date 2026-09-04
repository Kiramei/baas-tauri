//! Isolated native smoke: production tray/window handlers, no singleton plugin or BAAS backend.
//! Run manually on a desktop: cargo run -p baas-tauri --example tray_smoke
#![allow(dead_code)]
#[path = "../src/behavior.rs"]
mod behavior;
mod system_logs {
    pub fn system_log(_level: &str, _scope: &str, message: impl AsRef<str>) {
        println!("{}", message.as_ref());
    }
}

#[cfg(not(mobile))]
fn main() {
    use std::time::{Duration, Instant};
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    // Bounded event pumping is intentional in this synchronous native smoke test.
    #[allow(deprecated)]
    fn pump(app: &mut tauri::App) {
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(500) {
            app.run_iteration(|_, _| {});
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let no_tray = std::env::args().any(|arg| arg == "--no-tray");
    let data_dir = tempfile::tempdir().expect("isolated WebView data");
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "org.baas.tray-smoke".into();
    context.config_mut().app.windows.clear();
    let mut app = tauri::Builder::default()
        .setup(move |app| {
            let menu = if no_tray {
                None
            } else {
                Some(behavior::inject_tray_icon(app)?)
            };
            app.manage(behavior::BehaviorState::with_tray_menu(menu));
            Ok(())
        })
        .on_window_event(behavior::handle_main_window_event)
        .build(context)
        .expect("native test app");
    let window = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("BAAS isolated tray smoke")
    .data_directory(data_dir.path().to_path_buf())
    .inner_size(420.0, 240.0)
    .build()
    .expect("native window");
    pump(&mut app);
    if no_tray {
        assert!(!behavior::set_minimize_to_tray(app.state(), true));
        window.minimize().unwrap();
        pump(&mut app);
        assert!(
            window.is_visible().unwrap(),
            "missing tray must not hide window"
        );
        println!("PASS: missing-tray fallback keeps the window reachable");
        window.destroy().unwrap();
        pump(&mut app);
        app.cleanup_before_exit();
        return;
    }
    assert!(behavior::set_minimize_to_tray(app.state(), true));
    window.minimize().unwrap();
    pump(&mut app);
    assert!(
        !window.is_visible().unwrap(),
        "enabled minimize must hide to tray"
    );
    behavior::show_main_window(app.handle());
    pump(&mut app);
    assert!(
        window.is_visible().unwrap() && !window.is_minimized().unwrap(),
        "tray restore"
    );
    behavior::toggle_main_window(app.handle());
    pump(&mut app);
    assert!(
        !window.is_visible().unwrap(),
        "tray click hides visible window"
    );
    behavior::toggle_main_window(app.handle());
    pump(&mut app);
    assert!(
        window.is_visible().unwrap(),
        "tray click restores hidden window"
    );
    behavior::set_minimize_to_tray(app.state(), false);
    window.minimize().unwrap();
    pump(&mut app);
    assert!(
        window.is_visible().unwrap() && window.is_minimized().unwrap(),
        "disabled preference keeps normal minimize"
    );
    behavior::show_main_window(app.handle());
    pump(&mut app);
    window.close().unwrap();
    pump(&mut app);
    assert!(
        !window.is_visible().unwrap(),
        "existing close-to-tray behavior is preserved"
    );
    behavior::show_main_window(app.handle());
    pump(&mut app);
    println!("PASS: minimize enabled/disabled, restore, toggle and close");
    window.destroy().unwrap();
    pump(&mut app);
    app.cleanup_before_exit();
}

#[cfg(mobile)]
fn main() {}
