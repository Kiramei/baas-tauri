#[cfg(not(mobile))]
use std::path::{Path, PathBuf};
#[cfg(not(mobile))]
use tauri_plugin_opener::OpenerExt;

/// Opens only this installation's backend configuration directory.
#[tauri::command]
pub fn open_backend_config_folder(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(mobile))]
    {
        let manager = crate::commands::ensure_default_config(&app)?;
        let folder = backend_config_folder(&manager.config.baas_root())?;
        app.opener()
            .open_path(folder.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|error| error.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("The backend configuration folder is available in the desktop app only".into())
    }
}

#[cfg(not(mobile))]
fn backend_config_folder(root: &Path) -> Result<PathBuf, String> {
    let folder = root.join("config");
    if !folder.is_dir() {
        return Err("The backend configuration folder is not available yet".into());
    }
    std::path::absolute(folder).map_err(|error| error.to_string())
}

#[cfg(all(test, not(mobile)))]
mod tests {
    use super::backend_config_folder;

    #[test]
    fn resolves_only_the_existing_config_directory_of_the_active_backend() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("config");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(backend_config_folder(root.path()).unwrap(), folder);
    }

    #[test]
    fn missing_config_directory_is_reported_without_creating_files() {
        let root = tempfile::tempdir().unwrap();
        assert!(backend_config_folder(root.path()).is_err());
        assert!(!root.path().join("config").exists());
    }
}
