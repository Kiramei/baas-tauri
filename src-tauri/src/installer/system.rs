use std::path::{Path, PathBuf};
use std::{env, fs};

// pub fn get_os_info() -> (String, String) {
//     let os = env::consts::OS.to_string();
//     let arch = env::consts::ARCH.to_string();
//     (os, arch)
// }

pub fn get_base_path() -> PathBuf {
    if cfg!(target_os = "windows") {
        env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        directories::BaseDirs::new()
            .map(|dirs| dirs.home_dir().join(".baas"))
            .unwrap_or_else(|| PathBuf::from(".baas"))
    }
}

pub fn check_service_secret(base_path: &Path) -> Option<String> {
    let secret_path = base_path.join("config").join("service.secret");

    if secret_path.exists() {
        match fs::read_to_string(secret_path) {
            Ok(content) => Some(content),
            Err(_) => Some("".to_string()),
        }
    } else {
        None
    }
}
// pub fn is_python_installed() -> bool {
//     std::process::Command::new("python")
//         .arg("--version")
//         .output()
//         .is_ok()
//         || std::process::Command::new("python3")
//             .arg("--version")
//             .output()
//             .is_ok()
// }
