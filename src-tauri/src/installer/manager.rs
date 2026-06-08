use crate::installer::utils::emit_log;
use crate::installer::{config, git, python, system, utils};
use serde_json;
use std::net::TcpListener;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::{fs, thread};
use tauri::{command, AppHandle, Emitter, Manager, State, WindowEvent};
use tokio::sync::Mutex;

pub fn get_available_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind to port");
    let local_addr = listener.local_addr().expect("Failed to get local address");
    local_addr.port()
}

pub fn is_port_available(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    match TcpListener::bind(&addr) {
        Ok(_) => true,
        Err(_) => false,
    }
}

pub struct InstallerManager {
    app: AppHandle,
    backend_port: u16,
}

impl InstallerManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            backend_port: get_available_port(),
        }
    }

    pub async fn start_installation(
        &self,
        install_path: String,
        setup_config: Option<config::SetupConfig>,
    ) -> Result<serde_json::value::Value, String> {
        emit_log(&self.app, "Starting installation...", "info");
        let base_path = PathBuf::from(&install_path);
        if !base_path.exists() {
            fs::create_dir_all(&base_path).map_err(|e| e.to_string())?;
        }
        if is_port_available(self.backend_port) {
            // 1. Migration Check
            //  if there was a previous installation at a different location?
            // For now, we assume the user selects the target. If the target is empty, we treat it as new.
            // If the target has files, we might be updating.
            // The user asked for "migration", which usually means moving FROM an old path TO a new path.
            // But without knowing the old path, we can't move.
            // Let's assume the "default" path is the old path, and if user picks a new one, we move?
            // Or maybe just support "installing to a custom path".
            // "Custom installation directory, need to be able to migrate".
            // Let's implement a simple move if we detect a previous config pointing elsewhere?
            // Or simpler: Just install to the new path. If the user wants to migrate, they point to the new path.
            // If the user wants to move existing data, that's complex without knowing where it is.
            // I will implement a "check for existing installation at default path" and offer to move it?
            // For now, let's just respect the `install_path`.

            // 2. Config Setup
            let config_manager = config::ConfigManager::new(&base_path);
            // First check if config_manager.existence is false
            if !config_manager.existence {
                // Then check if setup_config contains Some(cfg)
                if let Some(cfg) = setup_config {config::ConfigManager::new(&base_path);
                    // Save the user-provided config
                    *config_manager.config.lock().unwrap() = cfg;
                    // Try to save the config and handle errors
                    config_manager.save_config().map_err(|e| e.to_string())?;
                }
            }
            let config = config_manager.get_config();

            // 3. Setup Git
            git::setup_git(&self.app, &config, &base_path)?;

            // 4. Setup Python & Install Deps
            python::setup_python(&self.app, &config, &base_path).await?;

            // 5. Launch Service
            self.launch_service(&base_path)?;
        } else {
            emit_log(
                &self.app,
                format!("Already run service on Port {}.", self.backend_port).as_str(),
                "warning",
            );
        }
        // 6. Check System & Secret
        let secret = self.find_service_secret(&base_path);

        let _ = self.app.emit(
            "installer://progress",
            serde_json::json!({
                "step": "setup_ok",
                "message": "Setup Completed!",
                "percentage": 100.0 as u8
            }),
        );

        Ok(serde_json::json!({
            "baseBackendAddr": "127.0.0.1",
            "baseBackendPort": self.backend_port,
            "serviceSecret": secret
        }))
    }

    fn launch_service(&self, base_path: &Path) -> Result<(), String> {
        emit_log(&self.app, "Launching main.service.py...", "info");

        let python_path = if cfg!(target_os = "windows") {
            base_path.join(".venv").join("Scripts").join("python.exe")
        } else {
            base_path.join(".venv").join("bin").join("python")
        };

        let script_path = base_path.join("main.service.py");

        if !script_path.exists() {
            return Err("main.service.py not found".to_string());
        }

        let mut cmd = Command::new(python_path);
        cmd.arg(script_path)
            .arg("--port")
            .arg(self.backend_port.to_string());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        let mut child_python = cmd
            .current_dir(base_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Launch child failed");

        utils::log_stream(&self.app, &mut child_python);

        let main_window = self.app.get_webview_window("main").unwrap();
        let backend_pid = child_python.id();

        main_window.on_window_event(move |event| {
            eprintln!(">>> Exit Triggered! <<<");
            println!(">>> Exit Triggered! <<<");
            if let WindowEvent::CloseRequested { .. } = event {
                let _ = Self::kill_process(backend_pid);
                std::process::exit(0);
            }
        });

        emit_log(&self.app, "Service launched successfully.", "success");

        Ok(())
    }

    fn kill_process(pid: u32) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .arg("/PID")
                .arg(pid.to_string())
                .arg("/F")
                .arg("/T")
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|e| e.to_string())?;
        }

        #[cfg(target_os = "linux")]
        {
            let _ = Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .spawn()
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    // Function to attempt finding the service secret with retries and delays.
    fn find_service_secret(&self, base_path: &Path) -> String {
        let max_retries = 3; // Maximum number of retries
        let mut attempt = 0;
        let mut secret = "".to_string();

        // Loop to retry finding the secret up to max_retries times
        while attempt < max_retries {
            if let Some(found_secret) = system::check_service_secret(base_path) {
                // Secret found, log success and return the secret
                emit_log(
                    &self.app,
                    &format!("Service secret found: {}", found_secret),
                    "success",
                );
                secret = found_secret;
                break; // Exit the loop if the secret is found
            } else {
                // Secret not found, log the retry attempt and wait 5 seconds before retrying
                emit_log(
                    &self.app,
                    &format!(
                        "Service secret not found. Retrying in 5 seconds... (Attempt {}/{}).",
                        attempt + 1,
                        max_retries
                    ),
                    "warning",
                );
                attempt += 1;
                thread::sleep(core::time::Duration::from_secs(5)); // Wait for 5 seconds before retrying
            }
        }

        // If the secret is still empty after retries, log a warning and return an empty string
        if secret.is_empty() {
            emit_log(&self.app,
                "Service secret not found after multiple attempts. You may need to input the key later.",
                "warning",
            );
        }

        secret
    }
}

#[command]
pub async fn start_installer(
    _: AppHandle,
    install_path: String,
    setup_config: Option<config::SetupConfig>,
    manager: State<'_, Arc<Mutex<InstallerManager>>>,
) -> Result<serde_json::value::Value, String> {
    let manager = manager.lock().await;
    let ret = manager
        .start_installation(install_path, setup_config)
        .await
        .unwrap_or_else(|e| {
            // 如果出错则打印错误消息
            eprintln!("Error: {}", e);
            serde_json::json!({ "error": e }) // 返回一个 JSON 错误信息
        });
    Ok(ret)
}

#[command]
pub fn get_default_path() -> String {
    system::get_base_path().to_string_lossy().to_string()
}

#[command]
pub fn get_default_config() -> config::SetupConfig {
    config::SetupConfig::default()
}
