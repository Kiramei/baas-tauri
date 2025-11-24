use crate::installer::config::SetupConfig;
use crate::installer::utils::emit_log;
use git2::{build::RepoBuilder, FetchOptions, RemoteCallbacks, Repository};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Emitter};

pub fn setup_git(app: &AppHandle, config: &SetupConfig, base_path: &Path) -> Result<(), String> {
    emit_log(app, "Checking git repository...", "info");

    let url = &config.urls.repo_url_http;
    let repo_path = base_path;

    if repo_path.join(".git").exists() {
        emit_log(app, "Repository already exists. Updating...", "info");
        update_repo(app, repo_path)?;
    } else {
        emit_log(app, "Cloning repository...", "info");
        clone_repo(app, url, repo_path)?;
    }

    Ok(())
}

fn clone_repo(app: &AppHandle, url: &str, path: &Path) -> Result<(), String> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.transfer_progress(|stats| {
        if stats.received_objects() % 100 == 0 {
             let _ = app.emit("installer://progress", serde_json::json!({
                "step": "setup_git",
                "message": format!("Cloning: {}/{} objects", stats.received_objects(), stats.total_objects()),
                "percentage": (stats.received_objects() as f32 / stats.total_objects() as f32 * 40.0) as u8
            }));
        }
        true
    });

    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks);

    let mut builder = RepoBuilder::new();
    builder.fetch_options(fo);

    // Check if directory is empty
    let is_empty = path
        .read_dir()
        .map(|mut i| i.next().is_none())
        .unwrap_or(true);

    if is_empty {
        match builder.clone(url, path) {
            Ok(_) => {
                emit_log(app, "Repository cloned successfully.", "success");
                let _ = app.emit(
                    "installer://progress",
                    serde_json::json!({
                        "step": "setup_git",
                        "message": "Repository Clone Completed.",
                        "percentage": 40.0 as u8
                    }),
                );
                Ok(())
            }
            Err(e) => {
                emit_log(app, &format!("Failed to clone repository: {}", e), "error");
                Err(e.to_string())
            }
        }
    } else {
        // Clone to temp and move
        emit_log(
            app,
            "Directory not empty, cloning to temporary location...",
            "info",
        );
        let tmp_dir_name = format!(
            "{}_tmp_{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );
        let tmp_path = path.parent().unwrap_or(Path::new(".")).join(tmp_dir_name);

        if tmp_path.exists() {
            fs::remove_dir_all(&tmp_path).map_err(|e| e.to_string())?;
        }

        // Scope to ensure Repository is dropped
        {
            builder.clone(url, &tmp_path).map_err(|e| {
                let _ = fs::remove_dir_all(&tmp_path);
                emit_log(app, &format!("Failed to clone repository: {}", e), "error");
                e.to_string()
            })?;
        }

        emit_log(app, "Moving files to installation directory...", "info");
        match move_files_recursive(&tmp_path, path) {
            Ok(_) => {
                let _ = retry_op(|| fs::remove_dir_all(&tmp_path));
                emit_log(app, "Repository cloned successfully (merged).", "success");
                let _ = app.emit(
                    "installer://progress",
                    serde_json::json!({
                        "step": "setup_git",
                        "message": "Repository Clone Completed.",
                        "percentage": 40.0 as u8
                    }),
                );
                Ok(())
            }
            Err(e) => {
                let _ = retry_op(|| fs::remove_dir_all(&tmp_path));
                emit_log(app, &format!("Failed to move files: {}", e), "error");
                Err(e)
            }
        }
    }
}

fn retry_op<F, T>(mut op: F) -> std::io::Result<T>
where
    F: FnMut() -> std::io::Result<T>,
{
    let mut retries = 0;
    loop {
        return match op() {
            Ok(v) => Ok(v),
            Err(e) => {
                if retries >= 10 {
                    return Err(e);
                }
                // Check if error is "file busy" (32) or "access denied" (5)
                let raw_err = e.raw_os_error().unwrap_or(0);
                if raw_err == 32 || raw_err == 5 {
                    retries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(200 * retries as u64));
                    continue;
                }
                Err(e)
            }
        };
    }
}

fn move_files_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !dst.exists() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    }

    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            move_files_recursive(&src_path, &dst_path)?;
        } else {
            if dst_path.exists() {
                if entry.file_name().to_string_lossy() == "setup.toml" {
                    continue;
                }
                // Remove dest file before rename to ensure overwrite
                retry_op(|| fs::remove_file(&dst_path)).map_err(|e| e.to_string())?;
            }

            // Try to rename, fallback to copy+delete
            if let Err(_) = retry_op(|| fs::rename(&src_path, &dst_path)) {
                retry_op(|| fs::copy(&src_path, &dst_path).map(|_| ()))
                    .map_err(|e| e.to_string())?;
                retry_op(|| fs::remove_file(&src_path)).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn update_repo(app: &AppHandle, path: &Path) -> Result<(), String> {
    let repo = Repository::open(path).map_err(|e| e.to_string())?;
    let mut remote = repo.find_remote("origin").map_err(|e| e.to_string())?;

    let mut callbacks = RemoteCallbacks::new();
    callbacks.transfer_progress(|stats| {
        if stats.received_objects() % 10 == 0 {
            // emit progress
        }
        true
    });

    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks);

    remote
        .fetch(&["master"], Some(&mut fo), None)
        .map_err(|e| e.to_string())?;

    // Hard reset to origin/master
    let fetch_head = repo
        .find_reference("FETCH_HEAD")
        .map_err(|e| e.to_string())?;
    let fetch_commit = repo
        .reference_to_annotated_commit(&fetch_head)
        .map_err(|e| e.to_string())?;
    let object = repo
        .find_object(fetch_commit.id(), None)
        .map_err(|e| e.to_string())?;

    // Backup setup.toml if it exists, to avoid overwrite by hard reset
    let setup_path = path.join("setup.toml");
    let setup_backup = path.join("setup.toml.bak");
    let has_setup = setup_path.exists();
    if has_setup {
        let _ = fs::copy(&setup_path, &setup_backup);
    }

    repo.reset(&object, git2::ResetType::Hard, None)
        .map_err(|e| e.to_string())?;

    // Restore setup.toml
    if has_setup {
        let _ = fs::copy(&setup_backup, &setup_path);
        let _ = fs::remove_file(&setup_backup);
    }

    emit_log(app, "Repository updated successfully.", "success");
    let _ = app.emit(
        "installer://progress",
        serde_json::json!({
            "step": "setup_git",
            "message": "Repository Update Completed.",
            "percentage": 40.0 as u8
        }),
    );
    Ok(())
}
