use std::fs;
use std::io::Write;
use std::path::PathBuf;

#[tauri::command]
pub async fn export_log_for_profile(
    log_to_save: String,
    path_save_to: String,
) -> Result<(), String> {
    // Convert the save path into a PathBuf
    let out_path = PathBuf::from(&path_save_to);

    // Ensure the parent directory exists (create it if not)
    if let Some(parent) = out_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return Err(format!("Failed to create directory: {}", e));
        }
    }

    // Try to create or overwrite the file and write the log content
    match fs::File::create(&out_path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(log_to_save.as_bytes()) {
                return Err(format!("Failed to write to file: {}", e));
            }
        }
        Err(e) => {
            return Err(format!("Failed to create file: {}", e));
        }
    }

    Ok(())
}
