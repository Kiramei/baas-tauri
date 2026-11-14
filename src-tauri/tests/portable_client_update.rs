#[path = "../src/platform/windows/portable_transaction.rs"]
mod portable;

use portable::{Architecture, Swap, SwapFileSystem};
use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

fn pe(arch: Architecture, portable: bool) -> Vec<u8> {
    let mut bytes = vec![0; 128];
    bytes[..2].copy_from_slice(b"MZ");
    bytes[60..64].copy_from_slice(&64_u32.to_le_bytes());
    bytes[64..68].copy_from_slice(b"PE\0\0");
    bytes[68..70].copy_from_slice(
        &match arch {
            Architecture::X64 => 0x8664_u16,
            Architecture::Arm64 => 0xaa64,
        }
        .to_le_bytes(),
    );
    if portable {
        bytes.extend_from_slice(b"__TAURI_BUNDLE_TYPE_VAR_UNK");
    }
    bytes
}
fn stage(bytes: &[u8]) -> Result<portable::StagedPayload, String> {
    let temp = TempDir::new().unwrap();
    portable::stage_payload(bytes, &temp.path().join("payload"), Architecture::X64)
}

#[test]
fn ready_acknowledgement_rejects_stale_nonce_other_process_and_wrong_version() {
    let ack = portable::ReadySignal {
        nonce: "transaction-a".into(),
        pid: 42,
        version: "0.0.10".into(),
    };
    assert!(ack.matches("transaction-a", 42, "0.0.10"));
    assert!(!ack.matches("transaction-b", 42, "0.0.10"));
    assert!(!ack.matches("transaction-a", 43, "0.0.10"));
    assert!(!ack.matches("transaction-a", 42, "0.0.9"));
}

#[test]
fn signed_installer_or_wrong_portable_variant_is_rejected_before_downloading() {
    assert!(portable::validate_package_name(
        "BAAS.Tauri_0.0.10_x64_portable.exe",
        Architecture::X64
    )
    .is_ok());
    for name in [
        "BAAS.Tauri_0.0.10_x64-setup.exe",
        "BAAS.Tauri_0.0.10_x64_fixed_webview2-setup.exe",
        "BAAS.Tauri_0.0.10_arm64_portable.exe",
        "BAAS.Tauri_0.0.10_x64_fixed_webview2_portable.zip",
        "evil/BAAS.Tauri_0.0.10_x64_portable.exe",
    ] {
        assert!(
            portable::validate_package_name(name, Architecture::X64).is_err(),
            "{name}"
        );
    }
}

#[test]
fn raw_payload_requires_matching_architecture_and_original_tauri_marker() {
    let temp = TempDir::new().unwrap();
    let payload = portable::stage_payload(
        &pe(Architecture::X64, true),
        &temp.path().join("payload"),
        Architecture::X64,
    )
    .unwrap();
    assert_eq!(
        fs::read(payload.executable).unwrap(),
        pe(Architecture::X64, true)
    );
    assert!(stage(&pe(Architecture::Arm64, true)).is_err());
    assert!(stage(&pe(Architecture::X64, false)).is_err());
    let mut installed = pe(Architecture::X64, true);
    let marker = installed.len() - 3;
    installed[marker..].copy_from_slice(b"NSS");
    assert!(stage(&installed).is_err());
    let mut duplicate = pe(Architecture::X64, true);
    duplicate.extend_from_slice(b"__TAURI_BUNDLE_TYPE_VAR_UNK");
    assert!(stage(&duplicate).is_err());
}

#[test]
fn malformed_pe_headers_and_offsets_fail_closed() {
    for bytes in [vec![], b"MZ".to_vec(), vec![0; 64]] {
        assert!(portable::validate_pe(&bytes, Architecture::X64).is_err());
    }
    let mut bytes = pe(Architecture::X64, true);
    bytes[60..64].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(portable::validate_pe(&bytes, Architecture::X64).is_err());
}

#[cfg(unix)]
#[test]
fn existing_staging_symlink_is_rejected() {
    let temp = TempDir::new().unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let link = temp.path().join("payload");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(
        portable::stage_payload(&pe(Architecture::X64, true), &link, Architecture::X64).is_err()
    );
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
}

#[derive(Default)]
struct FakeFs {
    files: BTreeMap<PathBuf, Vec<u8>>,
    renames: usize,
    exists: Cell<usize>,
    fail_rename: BTreeSet<usize>,
    fail_exists: usize,
}
impl SwapFileSystem for FakeFs {
    fn exists(&self, path: &Path) -> Result<bool, String> {
        let count = self.exists.get() + 1;
        self.exists.set(count);
        if self.fail_exists == count {
            return Err("injected exists error".into());
        }
        Ok(self.files.contains_key(path))
    }
    fn rename(&mut self, from: &Path, to: &Path) -> Result<(), String> {
        self.renames += 1;
        if self.fail_rename.contains(&self.renames) {
            return Err("injected rename error".into());
        }
        if self.files.contains_key(to) {
            return Err("occupied destination".into());
        }
        let value = self.files.remove(from).ok_or("missing rename source")?;
        self.files.insert(to.into(), value);
        Ok(())
    }
}
fn transaction() -> (FakeFs, Vec<Swap>) {
    let mut fs = FakeFs::default();
    let mut swaps = Vec::new();
    for name in ["extra-a.exe", "extra-b.exe", "client.exe"] {
        let target = PathBuf::from(format!("/backend/{name}"));
        let staged = PathBuf::from(format!("/backend/.stage/payload/{name}"));
        fs.files
            .insert(target.clone(), format!("old-{name}").into_bytes());
        fs.files
            .insert(staged.clone(), format!("new-{name}").into_bytes());
        swaps.push(Swap {
            target,
            staged: Some(staged),
            backup: format!("/backend/.stage/backup/{name}").into(),
        });
    }
    fs.files
        .insert("/backend/setup.toml".into(), b"keep setup".to_vec());
    fs.files.insert(
        "/backend/config/main/config.json".into(),
        b"keep config".to_vec(),
    );
    fs.files
        .insert("/backend/data/file".into(), b"keep data".to_vec());
    (fs, swaps)
}

#[test]
fn successful_swap_and_reverse_rollback_preserve_all_unmanaged_files() {
    let (mut fs, swaps) = transaction();
    let before = fs.files.clone();
    let applied = portable::apply_transaction(&mut fs, &swaps).unwrap();
    for item in &swaps {
        assert!(fs.files[&item.target].starts_with(b"new-"));
    }
    assert_eq!(fs.files[Path::new("/backend/setup.toml")], b"keep setup");
    assert_eq!(
        fs.files[Path::new("/backend/config/main/config.json")],
        b"keep config"
    );
    assert_eq!(fs.files[Path::new("/backend/data/file")], b"keep data");
    portable::rollback_transaction(&mut fs, &applied).unwrap();
    assert_eq!(fs.files, before);
}

#[test]
fn every_forward_rename_failure_restores_the_exact_original_state() {
    for operation in 1..=6 {
        let (mut fs, swaps) = transaction();
        let before = fs.files.clone();
        fs.fail_rename.insert(operation);
        assert!(
            portable::apply_transaction(&mut fs, &swaps).is_err(),
            "{operation}"
        );
        assert_eq!(fs.files, before, "rename failure {operation}");
    }
}

#[test]
fn every_existence_failure_rolls_back_previously_applied_components() {
    for operation in 1..=6 {
        let (mut fs, swaps) = transaction();
        let before = fs.files.clone();
        fs.fail_exists = operation;
        assert!(
            portable::apply_transaction(&mut fs, &swaps).is_err(),
            "{operation}"
        );
        assert_eq!(fs.files, before, "exists failure {operation}");
    }
}

#[test]
fn occupied_backups_and_missing_staged_files_do_not_discard_originals() {
    let (mut fs, swaps) = transaction();
    fs.files
        .insert(swaps[1].backup.clone(), b"unrelated backup".to_vec());
    let before = fs.files.clone();
    assert!(portable::apply_transaction(&mut fs, &swaps).is_err());
    assert_eq!(fs.files, before);
    let (mut fs, swaps) = transaction();
    fs.files.remove(swaps[1].staged.as_ref().unwrap());
    let before = fs.files.clone();
    assert!(portable::apply_transaction(&mut fs, &swaps).is_err());
    assert_eq!(fs.files, before);
}

#[test]
fn rollback_failure_preserves_the_old_backup_for_recovery() {
    let (mut fs, swaps) = transaction();
    let applied = portable::apply_transaction(&mut fs, &swaps).unwrap();
    fs.fail_rename.insert(fs.renames + 1);
    let error = portable::rollback_transaction(&mut fs, &applied).unwrap_err();
    assert!(error.contains("needs recovery"));
    assert_eq!(fs.files[&swaps[2].backup], b"old-client.exe");
    assert_eq!(fs.files[&swaps[2].target], b"new-client.exe");
    assert_eq!(fs.files[Path::new("/backend/setup.toml")], b"keep setup");
}
