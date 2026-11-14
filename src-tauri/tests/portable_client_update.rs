#[path = "../src/platform/windows/portable_transaction.rs"]
mod portable;

use portable::{Architecture, PackageKind, Swap, SwapFileSystem};
use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
};
use tempfile::TempDir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const RUNTIME: &str = "Microsoft.WebView2.FixedVersionRuntime.133.0.3065.92.x64";
const NEW_RUNTIME: &str = "Microsoft.WebView2.FixedVersionRuntime.134.0.1.2.x64";

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
fn archive(entries: &[(&str, &[u8])], compression: CompressionMethod) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(
            *name,
            SimpleFileOptions::default().compression_method(compression),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
fn fixed_archive(extra: &[(&str, &[u8])]) -> Vec<u8> {
    let client = pe(Architecture::X64, true);
    let runtime = pe(Architecture::X64, false);
    let name = format!("{RUNTIME}/msedgewebview2.exe");
    let mut entries = vec![
        ("baas-tauri.exe", client.as_slice()),
        (name.as_str(), runtime.as_slice()),
    ];
    entries.extend_from_slice(extra);
    archive(&entries, CompressionMethod::Stored)
}
fn stage(bytes: &[u8], kind: PackageKind) -> Result<portable::StagedPayload, String> {
    let temp = TempDir::new().unwrap();
    portable::stage_payload(bytes, &temp.path().join("payload"), kind, Architecture::X64)
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
        PackageKind::RawExe,
        Architecture::X64
    )
    .is_ok());
    assert!(portable::validate_package_name(
        "BAAS.Tauri_0.0.10_arm64_fixed_webview2_portable.zip",
        PackageKind::FixedWebview,
        Architecture::Arm64
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
            portable::validate_package_name(name, PackageKind::RawExe, Architecture::X64).is_err(),
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
        PackageKind::RawExe,
        Architecture::X64,
    )
    .unwrap();
    assert_eq!(
        fs::read(payload.executable).unwrap(),
        pe(Architecture::X64, true)
    );
    assert!(payload.runtime.is_none());
    assert!(stage(&pe(Architecture::Arm64, true), PackageKind::RawExe).is_err());
    assert!(stage(&pe(Architecture::X64, false), PackageKind::RawExe).is_err());
    let mut installed = pe(Architecture::X64, true);
    let marker = installed.len() - 3;
    installed[marker..].copy_from_slice(b"NSS");
    assert!(stage(&installed, PackageKind::RawExe).is_err());
    let mut duplicate = pe(Architecture::X64, true);
    duplicate.extend_from_slice(b"__TAURI_BUNDLE_TYPE_VAR_UNK");
    assert!(stage(&duplicate, PackageKind::RawExe).is_err());
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

#[test]
fn fixed_runtime_accepts_a_complete_single_architecture_package() {
    let temp = TempDir::new().unwrap();
    let bytes = fixed_archive(&[
        ("WebView2Loader.dll", b"loader"),
        (&format!("{RUNTIME}/locales/en-US.pak"), b"locale"),
    ]);
    let payload = portable::stage_payload(
        &bytes,
        &temp.path().join("payload"),
        PackageKind::FixedWebview,
        Architecture::X64,
    )
    .unwrap();
    let (name, runtime) = payload.runtime.unwrap();
    assert_eq!(name, RUNTIME);
    assert_eq!(
        fs::read(runtime.join("locales/en-US.pak")).unwrap(),
        b"locale"
    );
    assert_eq!(fs::read(payload.loader.unwrap()).unwrap(), b"loader");
}

#[test]
fn fixed_runtime_requires_client_runtime_and_runtime_executable() {
    let client = pe(Architecture::X64, true);
    for entries in [
        vec![("baas-tauri.exe", client.as_slice())],
        vec![("unrelated.exe", client.as_slice())],
        vec![
            ("baas-tauri.exe", client.as_slice()),
            (RUNTIME, b"file".as_slice()),
        ],
    ] {
        assert!(stage(
            &archive(&entries, CompressionMethod::Stored),
            PackageKind::FixedWebview
        )
        .is_err());
    }
    assert!(stage(
        &fixed_archive(&[(
            &format!("{NEW_RUNTIME}/msedgewebview2.exe"),
            &pe(Architecture::X64, false)
        )]),
        PackageKind::FixedWebview
    )
    .is_err());
    assert!(stage(
        &fixed_archive(&[("BAAS Tauri.exe", &client)]),
        PackageKind::FixedWebview
    )
    .is_err());
}

#[test]
fn fixed_runtime_and_client_architectures_are_checked_separately() {
    let client = pe(Architecture::X64, true);
    let arm = pe(Architecture::Arm64, false);
    let wrong = format!("{RUNTIME}/msedgewebview2.exe");
    assert!(stage(
        &archive(
            &[("baas-tauri.exe", &client), (&wrong, &arm)],
            CompressionMethod::Stored
        ),
        PackageKind::FixedWebview
    )
    .is_err());
    let arm_path = "Microsoft.WebView2.FixedVersionRuntime.133.0.3065.92.arm64/msedgewebview2.exe";
    assert!(stage(
        &archive(
            &[("baas-tauri.exe", &client), (arm_path, &arm)],
            CompressionMethod::Stored
        ),
        PackageKind::FixedWebview
    )
    .is_err());
}

#[test]
fn runtime_directory_match_is_exact_and_versioned() {
    assert!(portable::runtime_name(RUNTIME, Architecture::X64));
    assert!(portable::runtime_name(NEW_RUNTIME, Architecture::X64));
    for name in [
        "WebView2Data",
        "Microsoft.WebView2.FixedVersionRuntime.1.2.3.x64",
        "Microsoft.WebView2.FixedVersionRuntime.1.2.3.4.x64.old",
        "Microsoft.WebView2.FixedVersionRuntime.1.2.3.4.arm64",
    ] {
        assert!(!portable::runtime_name(name, Architecture::X64), "{name}");
    }
}

#[test]
fn windows_archive_path_aliases_traversal_and_devices_are_rejected() {
    for path in [
        "../config/main.json",
        "/absolute",
        "C:/config",
        "//server/share",
        "a\\b",
        "a//b",
        "a///",
        "a/./b",
        "a/../b",
        "a:stream",
        "a. ",
        "a.",
        "CON",
        "con.txt",
        "CON .txt",
        "NUL.exe",
        "LPT1.txt",
        "COM¹.txt",
        "a/b\0c",
        "a/b\nc",
        "a/?",
        "a/*",
        "a/\"",
        "a/<",
    ] {
        assert!(portable::safe_archive_path(path).is_err(), "{path:?}");
    }
    assert!(portable::safe_archive_path(&vec!["a"; 33].join("/")).is_err());
    assert_eq!(
        portable::safe_archive_path("dir/file.pak").unwrap(),
        ["dir", "file.pak"]
    );
}

#[test]
fn zip_allowlist_never_extracts_setup_config_or_data() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("outside"), b"keep").unwrap();
    for extra in [
        "setup.toml",
        "config/main/config.json",
        "data/cache.db",
        "WebView2Data/file",
        "../outside",
        "C:/outside",
    ] {
        let root = temp.path().join("payload");
        let bytes = fixed_archive(&[(extra, b"bad")]);
        assert!(
            portable::stage_payload(&bytes, &root, PackageKind::FixedWebview, Architecture::X64)
                .is_err(),
            "{extra}"
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
        assert_eq!(fs::read(temp.path().join("outside")).unwrap(), b"keep");
    }
}

#[test]
fn duplicate_case_aliases_and_symlink_entries_are_rejected() {
    let name = format!("{RUNTIME}/locale.pak");
    let alias = format!("{RUNTIME}/LOCALE.pak");
    assert!(stage(
        &fixed_archive(&[(&name, b"a"), (&alias, b"b")]),
        PackageKind::FixedWebview
    )
    .is_err());
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("baas-tauri.exe", SimpleFileOptions::default())
        .unwrap();
    zip.write_all(&pe(Architecture::X64, true)).unwrap();
    zip.start_file(
        format!("{RUNTIME}/msedgewebview2.exe"),
        SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(&pe(Architecture::X64, false)).unwrap();
    zip.add_symlink(
        format!("{RUNTIME}/link"),
        "../config",
        SimpleFileOptions::default(),
    )
    .unwrap();
    assert!(stage(
        &zip.finish().unwrap().into_inner(),
        PackageKind::FixedWebview
    )
    .unwrap_err()
    .contains("links and special"));
}

#[test]
fn unix_special_file_modes_are_rejected_before_extraction() {
    let mut bytes = fixed_archive(&[]);
    let central = bytes
        .windows(4)
        .position(|value| value == b"PK\x01\x02")
        .unwrap();
    bytes[central + 5] = 3;
    bytes[central + 38..central + 42].copy_from_slice(&((0x1000_u32 | 0o644) << 16).to_le_bytes());
    assert!(stage(&bytes, PackageKind::FixedWebview)
        .unwrap_err()
        .contains("links and special"));
}

#[test]
fn archive_size_entry_count_and_expansion_limits_are_enforced() {
    let bomb = vec![0; 2 * 1024 * 1024];
    let client = pe(Architecture::X64, true);
    let runtime = pe(Architecture::X64, false);
    let runtime_path = format!("{RUNTIME}/msedgewebview2.exe");
    let data_path = format!("{RUNTIME}/bomb");
    assert!(stage(
        &archive(
            &[
                ("baas-tauri.exe", &client),
                (&runtime_path, &runtime),
                (&data_path, &bomb)
            ],
            CompressionMethod::Deflated
        ),
        PackageKind::FixedWebview
    )
    .is_err());
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..=portable::MAX_ARCHIVE_ENTRIES {
        zip.start_file(
            format!("{RUNTIME}/file{index}"),
            SimpleFileOptions::default(),
        )
        .unwrap();
    }
    assert!(stage(
        &zip.finish().unwrap().into_inner(),
        PackageKind::FixedWebview
    )
    .is_err());
    let mut bytes = fixed_archive(&[]);
    let central = bytes
        .windows(4)
        .position(|value| value == b"PK\x01\x02")
        .unwrap();
    bytes[central + 24..central + 28]
        .copy_from_slice(&((portable::MAX_UNCOMPRESSED_BYTES + 1) as u32).to_le_bytes());
    assert!(stage(&bytes, PackageKind::FixedWebview)
        .unwrap_err()
        .contains("safe expansion limits"));
}

#[cfg(unix)]
#[test]
fn existing_staging_symlink_is_rejected() {
    let temp = TempDir::new().unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let link = temp.path().join("payload");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(portable::stage_payload(
        &pe(Architecture::X64, true),
        &link,
        PackageKind::RawExe,
        Architecture::X64
    )
    .is_err());
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
    for name in ["runtime", "loader", "client.exe"] {
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

#[test]
fn obsolete_runtime_is_backed_up_and_can_be_restored_with_a_new_runtime() {
    let mut fs = FakeFs::default();
    fs.files
        .insert("/backend/old-runtime".into(), b"old runtime".to_vec());
    fs.files
        .insert("/backend/.stage/runtime".into(), b"new runtime".to_vec());
    let swaps = vec![
        Swap {
            target: "/backend/new-runtime".into(),
            staged: Some("/backend/.stage/runtime".into()),
            backup: "/backend/.stage/new-backup".into(),
        },
        Swap {
            target: "/backend/old-runtime".into(),
            staged: None,
            backup: "/backend/.stage/old-backup".into(),
        },
    ];
    let before = fs.files.clone();
    let applied = portable::apply_transaction(&mut fs, &swaps).unwrap();
    assert!(!fs.files.contains_key(Path::new("/backend/old-runtime")));
    assert_eq!(fs.files[Path::new("/backend/new-runtime")], b"new runtime");
    portable::rollback_transaction(&mut fs, &applied).unwrap();
    assert_eq!(fs.files, before);
}
