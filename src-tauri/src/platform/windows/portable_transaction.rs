//! Portable packages may replace only explicitly selected client components.
//! This module is shared by the headless helper and filesystem/host tests.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

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
#[derive(Debug)]
pub struct StagedPayload {
    pub executable: PathBuf,
}

pub fn validate_package_name(name: &str, arch: Architecture) -> Result<(), String> {
    let arch = match arch {
        Architecture::X64 => "x64",
        Architecture::Arm64 => "arm64",
    };
    let suffix = format!("_{arch}_portable.exe");
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
    // Never add a second plaintext bundle marker to Tauri's executable patch scan.
    let marker = [
        0xf8_u8, 0xf8, 0xf3, 0xe6, 0xf2, 0xf5, 0xee, 0xf8, 0xe5, 0xf2, 0xe9, 0xe3, 0xeb, 0xe2,
        0xf8, 0xf3, 0xfe, 0xf7, 0xe2, 0xf8, 0xf1, 0xe6, 0xf5, 0xf8, 0xf2, 0xe9, 0xec,
    ]
    .map(|byte| std::hint::black_box(byte) ^ 0xa7);
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
    Ok(StagedPayload { executable })
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
