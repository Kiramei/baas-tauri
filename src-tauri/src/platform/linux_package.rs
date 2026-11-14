//! Linux client packaging must follow the running bundle, never the host distribution.
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug)]
pub enum Package {
    AppImage,
    Deb,
    Rpm,
}

pub fn update_target(architecture: &str, package: Package) -> Result<String, String> {
    if !matches!(architecture, "x86_64" | "aarch64") {
        return Err("Linux client updates require x64 or ARM64".into());
    }
    let format = match package {
        Package::AppImage => "appimage",
        Package::Deb => "deb",
        Package::Rpm => "rpm",
    };
    Ok(format!("linux-{architecture}-{format}"))
}

/// Resolve existing components before handling `..`, including directory symlinks.
fn resolved(path: &Path) -> Result<PathBuf, String> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    };
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => {
                result.push(other.as_os_str());
                match std::fs::symlink_metadata(&result) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        result = result.canonicalize().map_err(|error| error.to_string())?;
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
    }
    Ok(result)
}

pub fn persistent_path(path: &Path, appdir: Option<&Path>) -> Result<(), String> {
    if let Some(appdir) = appdir {
        if resolved(path)?.starts_with(resolved(appdir)?) {
            return Err("Choose a persistent directory outside the AppImage mount for backend data and setup.toml".into());
        }
    }
    Ok(())
}

/// The updater replaces the original AppImage, never its mounted ELF executable.
pub fn original_appimage(path: &Path, appdir: Option<&Path>) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("APPIMAGE must identify the absolute original AppImage file".into());
    }
    persistent_path(path, appdir)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("APPIMAGE must identify a regular original AppImage file".into());
    }
    path.canonicalize().map_err(|error| error.to_string())
}
