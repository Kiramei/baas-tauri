#![cfg(target_os = "linux")]

#[path = "../src/platform/linux_package.rs"]
mod package;

use package::{original_appimage, persistent_path, update_target, Package};
use std::{fs, path::Path};
use tempfile::TempDir;

#[test]
fn updates_follow_the_running_package_on_both_supported_architectures() {
    for arch in ["x86_64", "aarch64"] {
        for (kind, suffix) in [
            (Package::AppImage, "appimage"),
            (Package::Deb, "deb"),
            (Package::Rpm, "rpm"),
        ] {
            assert_eq!(
                update_target(arch, kind).unwrap(),
                format!("linux-{arch}-{suffix}")
            );
        }
    }
    for arch in ["arm", "armv7", "armv7l", "armhf", "i686"] {
        assert!(update_target(arch, Package::AppImage).is_err());
        assert!(update_target(arch, Package::Deb).is_err());
        assert!(update_target(arch, Package::Rpm).is_err());
    }
}

#[test]
fn original_file_is_outside_the_mount_and_keeps_adjacent_data_untouched() {
    let root = TempDir::new().unwrap();
    let mount = root.path().join(".mount_BAAS");
    fs::create_dir(&mount).unwrap();
    fs::write(mount.join("baas-tauri"), b"mounted ELF").unwrap();
    let image = root.path().join("renamed-client.AppImage");
    fs::write(&image, b"original AppImage").unwrap();
    for file in ["setup.toml", "script.py", "config.json"] {
        fs::write(root.path().join(file), b"keep").unwrap();
    }
    let original = original_appimage(&image, Some(&mount)).unwrap();
    assert_eq!(original, image.canonicalize().unwrap());
    assert_eq!(original.parent(), image.parent());
    assert!(original_appimage(&mount.join("baas-tauri"), Some(&mount)).is_err());
    assert!(original_appimage(Path::new("relative.AppImage"), Some(&mount)).is_err());
    assert!(original_appimage(&mount, Some(&mount)).is_err());
    for file in ["setup.toml", "script.py", "config.json"] {
        assert_eq!(fs::read(root.path().join(file)).unwrap(), b"keep");
    }
}

#[test]
fn backend_setup_cannot_use_mounted_or_normalized_mount_paths() {
    let root = TempDir::new().unwrap();
    let mount = root.path().join(".mount_BAAS");
    fs::create_dir(&mount).unwrap();
    for path in [
        mount.join("setup.toml"),
        mount.join("data/backend"),
        mount.join("child/../setup.toml"),
    ] {
        assert!(
            persistent_path(&path, Some(&mount)).is_err(),
            "{}",
            path.display()
        );
    }
    assert!(persistent_path(&root.path().join("backend/setup.toml"), Some(&mount)).is_ok());
    assert!(persistent_path(
        &root.path().join(".mount_BAAS-other/setup.toml"),
        Some(&mount)
    )
    .is_ok());
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_redirect_updates_or_backend_storage_into_the_mount() {
    let root = TempDir::new().unwrap();
    let mount = root.path().join(".mount_BAAS");
    fs::create_dir(&mount).unwrap();
    let image = root.path().join("client.AppImage");
    fs::write(&image, b"image").unwrap();
    let image_link = root.path().join("linked.AppImage");
    std::os::unix::fs::symlink(&image, &image_link).unwrap();
    assert!(original_appimage(&image_link, Some(&mount)).is_err());
    let data_link = root.path().join("data");
    std::os::unix::fs::symlink(&mount, &data_link).unwrap();
    assert!(persistent_path(&data_link.join("backend/setup.toml"), Some(&mount)).is_err());
    fs::create_dir(mount.join("child")).unwrap();
    let child_link = root.path().join("child-link");
    std::os::unix::fs::symlink(mount.join("child"), &child_link).unwrap();
    assert!(persistent_path(&child_link.join("../setup.toml"), Some(&mount)).is_err());
}
