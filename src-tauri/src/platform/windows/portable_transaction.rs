//! Portable packages may replace only explicitly selected client components.
//! This module is shared by the headless helper and filesystem/host tests.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_ARCHIVE_ENTRIES: usize = 10_000;
pub const MAX_UNCOMPRESSED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_COMPRESSION_RATIO: u64 = 200;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadySignal {
    pub nonce: String,
    pub pid: u32,
    pub version: String,
}
impl ReadySignal {
    pub fn matches(&self, nonce: &str, pid: u32, version: &str) -> bool {
        self.nonce == nonce && self.pid == pid && self.version == version
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Architecture {
    X64,
    Arm64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageKind {
    RawExe,
    FixedWebview,
}
#[derive(Debug)]
pub struct StagedPayload {
    pub executable: PathBuf,
    pub runtime: Option<(String, PathBuf)>,
    pub loader: Option<PathBuf>,
}

pub fn validate_package_name(
    name: &str,
    kind: PackageKind,
    arch: Architecture,
) -> Result<(), String> {
    let arch = match arch {
        Architecture::X64 => "x64",
        Architecture::Arm64 => "arm64",
    };
    let suffix = match kind {
        PackageKind::RawExe => format!("_{arch}_portable.exe"),
        PackageKind::FixedWebview => format!("_{arch}_fixed_webview2_portable.zip"),
    };
    if !name.starts_with("BAAS.Tauri_")
        || !name.ends_with(&suffix)
        || name.contains(['/', '\\', ':'])
    {
        return Err("Portable updater feed does not select the matching portable package".into());
    }
    Ok(())
}

pub fn validate_pe(bytes: &[u8], arch: Architecture) -> Result<(), String> {
    if bytes.len() < 64 || &bytes[..2] != b"MZ" {
        return Err("Portable payload is not a Windows executable".into());
    }
    let offset = u32::from_le_bytes(bytes[60..64].try_into().unwrap()) as usize;
    let header = bytes
        .get(offset..offset.checked_add(6).ok_or("Invalid PE offset")?)
        .ok_or("Truncated PE header")?;
    let machine = match arch {
        Architecture::X64 => 0x8664_u16,
        Architecture::Arm64 => 0xaa64,
    };
    if &header[..4] != b"PE\0\0" || u16::from_le_bytes(header[4..6].try_into().unwrap()) != machine
    {
        return Err("Portable executable architecture does not match this client".into());
    }
    Ok(())
}

fn validate_client_pe(bytes: &[u8], arch: Architecture) -> Result<(), String> {
    validate_pe(bytes, arch)?;
    // Tauri restores this marker on the raw binary after building NSIS/MSI bundles.
    // Rejecting installer/installed payloads also protects against a misrouted feed.
    let mut marker = b"__TAURI_BUNDLE_".to_vec();
    marker.extend_from_slice(std::hint::black_box(b"TYPE_VAR_"));
    marker.extend_from_slice(std::hint::black_box(b"UNK"));
    if bytes
        .windows(marker.len())
        .filter(|part| *part == marker.as_slice())
        .count()
        != 1
    {
        return Err("Portable update must contain the original unpacked Tauri client".into());
    }
    Ok(())
}

pub fn runtime_name(name: &str, arch: Architecture) -> bool {
    let suffix = match arch {
        Architecture::X64 => ".x64",
        Architecture::Arm64 => ".arm64",
    };
    let Some(version) = name
        .strip_prefix("Microsoft.WebView2.FixedVersionRuntime.")
        .and_then(|name| name.strip_suffix(suffix))
    else {
        return false;
    };
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|ch| ch.is_ascii_digit())
                && part.parse::<u32>().is_ok()
        })
}

pub fn safe_archive_path(name: &str) -> Result<Vec<&str>, String> {
    if name.starts_with('/')
        || name.contains('\\')
        || name
            .chars()
            .any(|ch| matches!(ch, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
        || name.chars().any(char::is_control)
    {
        return Err("Unsafe portable archive path".into());
    }
    let parts: Vec<_> = name.strip_suffix('/').unwrap_or(name).split('/').collect();
    if parts.len() > 32 {
        return Err("Portable archive nesting exceeds the safe limit".into());
    }
    for part in &parts {
        let stem = part
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        if part.is_empty()
            || *part == "."
            || *part == ".."
            || part.ends_with([' ', '.'])
            || matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            )
            || ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"].contains(&stem.as_str())
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err("Unsafe Windows portable filename".into());
        }
    }
    Ok(parts)
}

pub fn reject_link(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Client update paths must not be symbolic links".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Client update paths must not be reparse points".into());
        }
    }
    Ok(())
}

pub fn stage_payload(
    bytes: &[u8],
    root: &Path,
    kind: PackageKind,
    arch: Architecture,
) -> Result<StagedPayload, String> {
    if root.exists() {
        reject_link(root)?;
        if fs::read_dir(root)
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
        {
            return Err("Portable staging directory must be empty".into());
        }
    } else {
        fs::create_dir(root).map_err(|error| error.to_string())?;
    }
    if kind == PackageKind::RawExe {
        validate_client_pe(bytes, arch)?;
        let executable = root.join("client.exe");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&executable)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        return Ok(StagedPayload {
            executable,
            runtime: None,
            loader: None,
        });
    }
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("Portable archive has too many entries".into());
    }
    let mut seen = HashSet::new();
    let mut file_paths = Vec::new();
    let mut runtime_roots = HashSet::new();
    let mut executable = None;
    let mut loader = None;
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let parts = safe_archive_path(entry.name())?;
        let relative = parts.join("/");
        if !seen.insert(relative.to_lowercase()) {
            return Err("Duplicate Windows portable archive path".into());
        }
        let mode = entry.unix_mode().unwrap_or(0) & 0xf000;
        if !matches!(mode, 0 | 0x4000 | 0x8000) || (mode == 0x4000 && !entry.is_dir()) {
            return Err("Portable archive links and special files are not allowed".into());
        }
        total = total
            .checked_add(entry.size())
            .ok_or("Portable archive size overflow")?;
        if total > MAX_UNCOMPRESSED_BYTES
            || entry.size()
                > entry
                    .compressed_size()
                    .saturating_mul(MAX_COMPRESSION_RATIO)
                    .max(1024 * 1024)
        {
            return Err("Portable archive exceeds safe expansion limits".into());
        }
        if parts.len() == 1
            && !entry.is_dir()
            && matches!(
                parts[0],
                "baas-tauri.exe" | "BAAS Tauri.exe" | "BAAS.Tauri.exe"
            )
        {
            if executable.replace(root.join(parts[0])).is_some() {
                return Err("Portable archive must contain exactly one client executable".into());
            }
        } else if parts.len() == 1 && !entry.is_dir() && parts[0] == "WebView2Loader.dll" {
            loader = Some(root.join(parts[0]));
        } else if runtime_name(parts[0], arch) {
            runtime_roots.insert(parts[0].to_string());
        } else {
            return Err(
                "Portable archive contains a file outside the client/runtime allowlist".into(),
            );
        }
        file_paths.push((relative, entry.is_dir(), entry.size()));
    }
    if runtime_roots.len() != 1 {
        return Err(
            "Fixed portable archive must contain exactly one matching WebView2 runtime".into(),
        );
    }
    let runtime = runtime_roots.into_iter().next().unwrap();
    let executable = executable.ok_or("Portable archive has no client executable")?;
    if !file_paths
        .iter()
        .any(|(path, directory, _)| !directory && path == &format!("{runtime}/msedgewebview2.exe"))
    {
        return Err("Portable archive is missing the WebView2 executable".into());
    }
    for (index, (relative, directory, size)) in file_paths.iter().enumerate() {
        let destination = root.join(relative);
        if *directory {
            fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut input = archive
            .by_index(index)
            .map_err(|error| error.to_string())?
            .take(size.saturating_add(1));
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| error.to_string())?;
        let copied = std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
        if copied != *size {
            return Err("Portable archive entry size mismatch".into());
        }
        output.sync_all().map_err(|error| error.to_string())?;
    }
    validate_client_pe(
        &fs::read(&executable).map_err(|error| error.to_string())?,
        arch,
    )?;
    validate_pe(
        &fs::read(root.join(&runtime).join("msedgewebview2.exe"))
            .map_err(|error| error.to_string())?,
        arch,
    )?;
    Ok(StagedPayload {
        executable,
        runtime: Some((runtime.clone(), root.join(runtime))),
        loader,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Swap {
    pub target: PathBuf,
    pub staged: Option<PathBuf>,
    pub backup: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppliedSwap {
    pub swap: Swap,
    pub had_original: bool,
    pub installed: bool,
}
pub trait SwapFileSystem {
    fn exists(&self, path: &Path) -> Result<bool, String>;
    fn rename(&mut self, from: &Path, to: &Path) -> Result<(), String>;
}

pub fn rollback_transaction(
    filesystem: &mut impl SwapFileSystem,
    applied: &[AppliedSwap],
) -> Result<(), String> {
    let mut errors = Vec::new();
    for item in applied.iter().rev() {
        if item.installed {
            if let Some(staged) = &item.swap.staged {
                if let Err(error) = filesystem.rename(&item.swap.target, staged) {
                    errors.push(error);
                    continue;
                }
            }
        }
        if item.had_original {
            if let Err(error) = filesystem.rename(&item.swap.backup, &item.swap.target) {
                errors.push(error);
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Portable rollback needs recovery: {}",
            errors.join("; ")
        ))
    }
}

pub fn apply_transaction(
    filesystem: &mut impl SwapFileSystem,
    swaps: &[Swap],
) -> Result<Vec<AppliedSwap>, String> {
    let mut applied = Vec::new();
    for swap in swaps {
        let operation = (|| -> Result<(), String> {
            if filesystem.exists(&swap.backup)? {
                return Err("Portable backup path is already occupied".into());
            }
            let exists = filesystem.exists(&swap.target)?;
            applied.push(AppliedSwap {
                swap: swap.clone(),
                had_original: false,
                installed: false,
            });
            if exists {
                filesystem.rename(&swap.target, &swap.backup)?;
                applied.last_mut().unwrap().had_original = true;
            }
            if let Some(staged) = &swap.staged {
                filesystem.rename(staged, &swap.target)?;
                applied.last_mut().unwrap().installed = true;
            }
            Ok(())
        })();
        if let Err(error) = operation {
            return match rollback_transaction(filesystem, &applied) {
                Ok(()) => Err(error),
                Err(rollback) => Err(format!("{error}; {rollback}")),
            };
        }
    }
    Ok(applied)
}
