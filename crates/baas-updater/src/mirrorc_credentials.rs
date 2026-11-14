//! User-supplied MirrorChyan credentials live in native app-private storage.
//! The development fixture in the source checkout is never a credential source.
use crate::config::ConfigManager;
use std::{
    fs,
    io::{ErrorKind, Write},
    path::Path,
};
use tempfile::NamedTempFile;

const FILE_NAME: &str = "mirrorc.key";

pub fn load(directory: &Path) -> Result<String, String> {
    match fs::read_to_string(directory.join(FILE_NAME)) {
        Ok(contents) => Ok(contents.trim().to_owned()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(_) => Err("Cannot read the local MirrorChyan credential".to_owned()),
    }
}

/// Publish a complete owner-only file in one rename. Clearing a missing key is idempotent.
pub fn store(directory: &Path, cdk: &str) -> Result<(), String> {
    let path = directory.join(FILE_NAME);
    let cdk = cdk.trim();
    if cdk.is_empty() {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Cannot clear the local MirrorChyan credential".to_owned()),
        };
    }
    fs::create_dir_all(directory).map_err(|_| "Cannot create the local credential directory")?;
    let mut file =
        NamedTempFile::new_in(directory).map_err(|_| "Cannot create a local credential file")?;
    file.write_all(cdk.as_bytes())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Cannot write the local MirrorChyan credential")?;
    file.persist(path)
        .map_err(|_| "Cannot replace the local MirrorChyan credential")?;
    Ok(())
}

/// Import an older shared setup key. Save the private copy before erasing the original.
pub fn migrate(manager: &mut ConfigManager, directory: &Path) -> Result<(), String> {
    if !manager.config.general.mirrorc_cdk.is_empty() {
        if load(directory)?.is_empty() {
            store(directory, &manager.config.general.mirrorc_cdk)?;
        }
        manager.config.general.mirrorc_cdk.clear();
        manager.save().map_err(|error| error.message())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_keeps_the_newer_private_key_and_removes_the_shared_copy() {
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("native");
        let path = root.path().join("setup.toml");
        let mut manager = ConfigManager::load_from(&path).unwrap();
        manager.set_mirrorc_cdk("legacy-fixture").unwrap();
        migrate(&mut manager, &private).unwrap();
        assert_eq!(load(&private).unwrap(), "legacy-fixture");
        assert!(
            !fs::read_to_string(&path)
                .unwrap()
                .contains("legacy-fixture")
        );
        store(&private, "replacement-fixture").unwrap();
        manager.set_mirrorc_cdk("stale-fixture").unwrap();
        migrate(&mut manager, &private).unwrap();
        assert_eq!(load(&private).unwrap(), "replacement-fixture");
        assert!(!fs::read_to_string(&path).unwrap().contains("stale-fixture"));
    }

    #[test]
    fn a_private_key_can_be_replaced_and_cleared_without_touching_setup() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), "");
        store(dir.path(), " first-fixture ").unwrap();
        store(dir.path(), "second-fixture").unwrap();
        assert_eq!(load(dir.path()).unwrap(), "second-fixture");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.path().join(FILE_NAME))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
        }
        store(dir.path(), "").unwrap();
        store(dir.path(), "").unwrap();
        assert_eq!(load(dir.path()).unwrap(), "");
    }
}
