use crate::installer::config::SetupConfig;
use crate::installer::utils::{emit_log, log_stream};
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use reqwest::header::CONTENT_LENGTH;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Cursor, Read};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};
use zip::ZipArchive;

pub async fn setup_python(
    app: &AppHandle,
    config: &SetupConfig,
    base_path: &Path,
) -> Result<(), String> {
    emit_log(app, "Setting up Python environment...", "info");

    // 1. Install uv
    let uv_path = install_uv(app, base_path).await?;

    let _ = app.emit(
        "installer://progress",
        serde_json::json!({
            "step": "setup_uv",
            "message": "UV Setup Completed.",
            "percentage": 50.0 as u8
        }),
    );

    // 2. Create venv
    create_venv(app, &uv_path, base_path)?;

    let _ = app.emit(
        "installer://progress",
        serde_json::json!({
            "step": "setup_venv",
            "message": "Venv Setup Completed.",
            "percentage": 55.0 as u8
        }),
    );

    // 3. Install dependencies
    install_dependencies(app, &uv_path, base_path, config)?;

    let _ = app.emit(
        "installer://progress",
        serde_json::json!({
            "step": "setup_dep",
            "message": "Dependencies Prepared.",
            "percentage": 90.0 as u8
        }),
    );

    // 4. Apply Env Patch (if needed)
    // apply_env_patch(app, config, base_path).await?;
    //
    // let _ = app.emit(
    //     "installer://progress",
    //     serde_json::json!({
    //         "step": "setup_patch",
    //         "message": "Venv Patch Completed.",
    //         "percentage": 95.0 as u8
    //     }),
    // );

    Ok(())
}

async fn install_uv(app: &AppHandle, base_path: &Path) -> Result<std::path::PathBuf, String> {
    let uv_dir = base_path.join("toolkit").join("uv");
    fs::create_dir_all(&uv_dir).map_err(|e| e.to_string())?;

    let uv_executable = if cfg!(target_os = "windows") {
        uv_dir.join("uv.exe")
    } else {
        uv_dir.join("uv")
    };

    if uv_executable.exists() {
        emit_log(app, "uv is already installed.", "success");
        return Ok(uv_executable);
    }

    emit_log(app, "Downloading uv...", "info");

    // Refined URL selection based on Arch
    // let url = match (std::env::consts::OS, std::env::consts::ARCH) {
    //     ("windows", _) => "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
    //     ("macos", "aarch64") => "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz",
    //     ("macos", "x86_64") => "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz",
    //     ("linux", "aarch64") => "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-unknown-linux-gnu.tar.gz",
    //     ("linux", _) => "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz",
    //     _ => return Err("Unsupported platform for uv auto-download".to_string()),
    // };
    let url = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", _) => "https://gitee.com/kiramei/blue_archive_auto_script_assets/releases/download/UVDownload/uv-x86_64-pc-windows-msvc.zip",
        ("macos", "aarch64") => "https://gitee.com/kiramei/blue_archive_auto_script_assets/releases/download/UVDownload/uv-aarch64-apple-darwin.tar.gz",
        ("macos", "x86_64") => "https://gitee.com/kiramei/blue_archive_auto_script_assets/releases/download/UVDownload/uv-x86_64-apple-darwin.tar.gz",
        ("linux", "aarch64") => "https://gitee.com/kiramei/blue_archive_auto_script_assets/releases/download/UVDownload/uv-x86_64-unknown-linux-gnu.tar.gz",
        ("linux", _) => "https://gitee.com/kiramei/blue_archive_auto_script_assets/releases/download/UVDownload/uv-x86_64-unknown-linux-gnu.tar.gz",
        _ => return Err("Unsupported platform for uv auto-download".to_string()),
    };

    let response = reqwest::get(url).await.map_err(|e| e.to_string())?;
    let content_length = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let mut bytes_downloaded = 0;
    let mut reader = response.bytes_stream();

    // Download the file in chunks and track progress
    let mut full_bytes = Vec::new(); // This will hold the entire file content
    while let Some(chunk) = reader.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        bytes_downloaded += chunk.len() as u64;

        // Calculate progress percentage (normalized between 40 and 50)
        let progress = if content_length > 0 {
            ((bytes_downloaded * 5) / content_length) + 40
        } else {
            40 // Default to 40% if no content length is provided
        };

        // Calculate progress percentage (Real Download progress)
        let _progress = if content_length > 0 {
            bytes_downloaded * 100 / content_length
        } else {
            0 // Default to 0% if no content length is provided
        };

        // Emit progress to the app
        let _ = app.emit(
            "installer://progress",
            serde_json::json!({
                "step": "setup_uv",
                "message": format!("UV Downloading... {:.2}%", _progress),
                "percentage": progress as u8
            }),
        );

        // Append to full_bytes
        full_bytes.extend_from_slice(&chunk);
    }

    // Now use the downloaded bytes to handle extraction
    let bytes = full_bytes; // Move full_bytes into the next block for extraction

    // Handle the extraction
    if url.ends_with(".zip") {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
        archive.extract(&uv_dir).map_err(|e| e.to_string())?;
    } else if url.ends_with(".tar.gz") {
        let tar = GzDecoder::new(Cursor::new(bytes));
        let mut archive = tar::Archive::new(tar);
        archive.unpack(&uv_dir).map_err(|e| e.to_string())?;
    }

    // Simple fix: find 'uv' or 'uv.exe' in uv_dir and move it to uv_dir root if not there.
    let found_path = find_file(
        &uv_dir,
        if cfg!(target_os = "windows") {
            "uv.exe"
        } else {
            "uv"
        },
    );
    if let Some(p) = found_path {
        if p != uv_executable {
            fs::rename(p, &uv_executable).map_err(|e| e.to_string())?;
        }
    }

    emit_log(app, "Installing python 3.9.0 ...", "info");

    let _ = app.emit(
        "installer://progress",
        serde_json::json!({
            "step": "setup_uv",
            "message": "Python 3.9.0 Downloading ...",
            "percentage": 45.0 as u8
        }),
    );

    let mut cmd = Command::new(uv_executable.clone());
    cmd.arg("python").arg("install").arg("3.9.0");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let mut child = cmd
        .env(
            "UV_PYTHON_INSTALL_MIRROR",
            "https://gitee.com/kiramei/blue_archive_auto_script_assets/releases/download",
        )
        .stdout(Stdio::piped()) // Capture stdout
        .stderr(Stdio::piped()) // Capture stderr
        .spawn()
        .map_err(|e| e.to_string())?;

    log_stream(app, &mut child);

    child.wait().map_err(|e| e.to_string())?;

    emit_log(app, "Python 3.9.0 installed.", "info");

    let _ = app.emit(
        "installer://progress",
        serde_json::json!({
            "step": "setup_uv",
            "message": "Python 3.9.0 Downloaded.",
            "percentage": 50.0 as u8
        }),
    );

    // chmod +x on unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&uv_executable)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&uv_executable, perms).map_err(|e| e.to_string())?;
    }

    emit_log(app, "uv installed successfully.", "success");
    Ok(uv_executable)
}

fn find_file(dir: &Path, filename: &str) -> Option<std::path::PathBuf> {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(p) = find_file(&path, filename) {
                    return Some(p);
                }
            } else if path.file_name().and_then(|s| s.to_str()) == Some(filename) {
                return Some(path);
            }
        }
    }
    None
}

fn create_venv(app: &AppHandle, uv_path: &Path, base_path: &Path) -> Result<(), String> {
    emit_log(app, "Creating virtual environment...", "info");
    let venv_path = base_path.join(".venv");

    // check the existence
    if venv_path.exists() {
        emit_log(app, "Created VENV found!", "success");
        return Ok(());
    }
    // Start the command process and capture its output
    let mut cmd = Command::new(uv_path);
    cmd.arg("venv").arg(&venv_path).arg("--python").arg("3.9.0");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let mut child = cmd
        .stdout(Stdio::piped()) // Capture stdout
        .stderr(Stdio::piped()) // Capture stderr
        .spawn()
        .map_err(|e| e.to_string())?;

    log_stream(app, &mut child);

    // Wait for the command to finish
    let output = child.wait().map_err(|e| e.to_string())?;

    if !output.success() {
        return Err("Failed to create venv".to_string());
    }

    emit_log(app, "Virtual environment created.", "success");
    Ok(())
}

// Function to generate the hash of a file (using SHA256)
fn generate_file_hash(file_path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(file_path)?; // Open the file
    let mut hasher = Sha256::new(); // Create a new SHA256 hasher
    let mut buffer = Vec::new();

    file.read_to_end(&mut buffer)?; // Read the entire file into the buffer
    hasher.update(&buffer); // Update the hasher with the file content

    // Return the hash as a hexadecimal string
    let digest = hasher.finalize();
    Ok(digest
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>())
}

fn install_dependencies(
    app: &AppHandle,
    uv_path: &Path,
    base_path: &Path,
    config: &SetupConfig,
) -> Result<(), String> {
    emit_log(app, "Installing dependencies...", "info");
    let uv_dir = base_path.join("toolkit").join("uv");
    let req_base_path = base_path.join("deploy").join("service");
    #[cfg(target_os = "windows")]
    let req_path = base_path.join("requirements.service.windows.txt");
    #[cfg(target_os = "linux")]
    let req_path = req_base_path.join("requirements.service.linux.txt");

    // Check if the 'requirements.service.txt' file exists
    if !req_path.exists() {
        return Err("requirements.service.txt not found in repository.".to_string());
    }

    let req_lock_path = base_path.join("requirements.service.lock");
    let hash_file_path = base_path.join("requirements.service.hash");

    // Generate the current hash of the 'requirements.service.txt' file
    let current_hash = generate_file_hash(&req_path).map_err(|e| e.to_string())?;

    // Initialize an empty string to hold the last saved hash
    let mut last_hash = String::new();

    // If the hash file exists, read the previously saved hash value
    if hash_file_path.exists() {
        last_hash = fs::read_to_string(&hash_file_path).map_err(|e| e.to_string())?;
    }

    let dep_need_update = current_hash != last_hash;
    // Compare the current hash with the saved hash
    if dep_need_update {
        // If the hashes differ, compile the dependencies
        emit_log(
            app,
            "Dependencies have changed, locking the dependencies...",
            "info",
        );

        // Run the 'pip compile' command to lock the dependencies
        let mut cmd = Command::new(uv_path);
        cmd.arg("pip")
            .arg("compile")
            .arg(&req_path)
            .arg("-o")
            .arg(&req_lock_path);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        let mut child = cmd
            .env("UV_INDEX", config.general.source_list[0].as_str())
            .env("UV_DEFAULT_INDEX", config.general.source_list[0].as_str())
            .env("UV_CACHE_DIR", uv_dir.join("cache"))
            .env("VIRTUAL_ENV", base_path.join(".venv"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Deps lock failed");

        log_stream(app, &mut child);

        child.wait().unwrap();

        // Update the hash file with the new hash value
        fs::write(hash_file_path, current_hash).map_err(|e| e.to_string())?;

        // Log that the dependencies were locked
        emit_log(app, "Dependencies locked.", "info");
    } else {
        // If the hashes are the same, no need to compile
        emit_log(app, "No changes in dependencies. Skipping compile.", "info");
    }

    emit_log(
        app,
        "Synchronizing dependencies (this may take a while) ...",
        "info",
    );
    // Start the command process and capture its output
    let mut cmd = Command::new(uv_path);
    cmd.arg("pip").arg("sync").arg(&req_lock_path);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let mut child = cmd
        .env("UV_INDEX", config.general.source_list[0].as_str())
        .env("UV_DEFAULT_INDEX", config.general.source_list[0].as_str())
        .env("UV_CACHE_DIR", uv_dir.join("cache"))
        .env("VIRTUAL_ENV", base_path.join(".venv"))
        .stdout(Stdio::piped()) // Capture stdout
        .stderr(Stdio::piped()) // Capture stderr
        .spawn()
        .map_err(|e| e.to_string())?;

    log_stream(app, &mut child);

    // Wait for the command to finish
    let output = child.wait().map_err(|e| e.to_string())?;

    if !output.success() {
        return Err("Failed to install dependencies".to_string());
    }

    emit_log(app, "Dependencies synchronized.", "success");

    if dep_need_update {
        emit_log(app, "Cleaning cache yielded by UV ...", "info");

        let mut cmd = Command::new(uv_path);
        cmd.arg("cache").arg("clean");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        let mut child = cmd
            .stdout(Stdio::piped()) // Capture stdout
            .stderr(Stdio::piped()) // Capture stderr
            .spawn()
            .map_err(|e| e.to_string())?;

        log_stream(app, &mut child);

        // Wait for the command to finish
        let output = child.wait().map_err(|e| e.to_string())?;

        if !output.success() {
            return Err("Failed to clean UV cache.".to_string());
        } else {
            emit_log(app, "UV Cache cleaned successfully.", "info");
        }
    }

    Ok(())
}

// async fn apply_env_patch(
//     app: &AppHandle,
//     config: &SetupConfig,
//     base_path: &Path,
// ) -> Result<(), String> {
//     if cfg!(target_os = "linux") || cfg!(target_os = "macos") {
//         return Ok(());
//     }
//
//     let polygon_path = base_path
//         .join(".venv")
//         .join("Lib")
//         .join("site-packages")
//         .join("Polygon");
//
//     // Skip if the patch is already applied
//     if polygon_path.exists() {
//         return Ok(());
//     }
//
//     emit_log(app, "Downloading environment patch...", "info");
//     let url = &config.urls.get_env_patch_url;
//
//     let response = reqwest::get(url).await.map_err(|e| e.to_string())?;
//     let content_length = response
//         .headers()
//         .get(CONTENT_LENGTH)
//         .and_then(|value| value.to_str().ok())
//         .and_then(|s| s.parse::<u64>().ok())
//         .unwrap_or(0);
//
//     let mut bytes_downloaded = 0;
//     let mut reader = response.bytes_stream();
//
//     // Read in chunks and track the progress
//     let mut full_bytes = Vec::new(); // This will hold the entire file content
//     while let Some(chunk) = reader.next().await {
//         let chunk = chunk.map_err(|e| e.to_string())?;
//         bytes_downloaded += chunk.len() as u64;
//
//         // Calculate progress percentage (normalized between 40 and 50)
//         let progress = if content_length > 0 {
//             ((bytes_downloaded * 5) / content_length) + 90
//         } else {
//             90 // Default to 40% if no content length is provided
//         };
//
//         // Calculate progress percentage (Real Download progress)
//         let _progress = if content_length > 0 {
//             bytes_downloaded * 100 / content_length
//         } else {
//             0 // Default to 0% if no content length is provided
//         };
//
//         // Emit progress to the app
//         let _ = app.emit(
//             "installer://progress",
//             serde_json::json!({
//                 "step": "setup_patch",
//                 "message": format!("Downloading environment patch...{:.2}%", _progress),
//                 "percentage": progress as u8
//             }),
//         );
//
//         // Append to full_bytes
//         full_bytes.extend_from_slice(&chunk);
//     }
//
//     // Now use the downloaded bytes to handle extraction
//     let bytes = full_bytes; // Move full_bytes into the next block for extraction
//
//     // Handle the extraction
//     let venv_path = base_path.join(".venv");
//     let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
//     archive.extract(&venv_path).map_err(|e| e.to_string())?;
//
//     emit_log(app, "Environment patch applied.", "success");
//     Ok(())
// }
