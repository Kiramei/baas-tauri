#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, AppHandle};

// greet 示例
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// 关闭启动页、显示主窗口
#[tauri::command]
async fn splash_off(app: AppHandle) {
    // use tauri::{Size, LogicalSize};

    if let Some(main) = app.get_webview_window("main") {
        // 1️⃣ 获取系统缩放系数（跨平台）
        // Incompatible with the Frontend
        // let scale = main.scale_factor().unwrap_or(1.0);

        // let base_width = 1280.0;
        // let base_height = 800.0;

        // 2️⃣ 自适应系统缩放调整窗口尺寸
        // let width = base_width / scale;
        // let height = base_height / scale;
        // main.set_size(Size::Logical(LogicalSize { width, height })).ok();

        // 3️⃣ 居中窗口，防止多屏偏移
        main.center().ok();

        // 4️⃣ 显示窗口并聚焦
        main.show().ok();
        main.set_focus().ok();

        // 5️⃣ 控制台日志方便调试
        // println!("✅ main window shown at {:.1}×{:.1} (scale {:.2})", width, height, scale);
    } else {
        eprintln!("⚠️ main window not found when calling splash_off()");
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet, splash_off]) // ✅ 合并成一行
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
