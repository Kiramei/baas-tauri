use serde_json::Value;
use std::process::Command;

fn invoke(args: &[&str]) -> (bool, Vec<Value>) {
    let output = Command::new(env!("CARGO_BIN_EXE_baas-cli-runtime"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.stderr.is_empty(),
        "unexpected stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let messages: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("stdout must be NDJSON only"))
        .collect();
    assert!(!messages.is_empty());
    (output.status.success(), messages)
}

#[test]
fn inspect_is_read_only_and_emits_a_single_result() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("runtime");
    let (success, messages) = invoke(&["inspect", "--root", root.to_str().unwrap()]);
    assert!(success);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["type"], "result");
    assert_eq!(messages[0]["data"]["installed"], false);
    assert_eq!(messages[0]["data"]["managed"], false);
    assert_eq!(messages[0]["data"]["root"], root.to_str().unwrap());
    assert_eq!(
        messages[0]["data"]["backendPath"],
        root.join("main.service.py").to_str().unwrap()
    );
    assert!(!root.exists());
}

#[test]
fn stable_install_fails_without_creating_a_directory_or_reporting_download_progress() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("unused-runtime");
    let (success, messages) = invoke(&[
        "install",
        "--root",
        root.to_str().unwrap(),
        "--channel",
        "stable",
    ]);
    assert!(!success);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["type"], "error");
    assert_eq!(messages[0]["code"], "config");
    assert_eq!(
        messages[0]["message"],
        baas_cli_runtime::DEV_BACKEND_REQUIRED
    );
    assert!(!root.exists());
    assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 0);
}

#[test]
fn unmanaged_install_is_rejected_without_changing_existing_files() {
    let parent = tempfile::tempdir().unwrap();
    let existing = parent.path().join("settings.json");
    std::fs::write(&existing, "user data").unwrap();
    let (success, messages) = invoke(&[
        "install",
        "--root",
        parent.path().to_str().unwrap(),
        "--channel",
        "dev",
    ]);
    assert!(!success);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["type"], "error");
    match baas_updater::repo::cpp_branch_for(std::env::consts::OS, std::env::consts::ARCH) {
        Ok(_) => {
            assert_eq!(messages[0]["code"], "config");
            assert!(
                messages[0]["message"]
                    .as_str()
                    .unwrap()
                    .contains("unmanaged")
            );
        }
        Err(error) => {
            assert_eq!(messages[0]["code"], "git");
            assert_eq!(messages[0]["message"], error.message());
        }
    }
    assert_eq!(std::fs::read_to_string(existing).unwrap(), "user data");
    assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 1);
}

#[test]
fn missing_ocr_prebuild_cannot_create_installation_state() {
    let Err(error) =
        baas_updater::repo::cpp_branch_for(std::env::consts::OS, std::env::consts::ARCH)
    else {
        return;
    };
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("new-runtime");
    let (success, messages) = invoke(&[
        "install",
        "--channel",
        "dev",
        "--root",
        root.to_str().unwrap(),
    ]);
    assert!(!success);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["message"], error.message());
    assert!(!root.exists());
}

#[test]
fn invalid_cli_options_are_structured_failures() {
    for args in [
        vec!["inspect"],
        vec!["install", "--root", "/unused", "--channel", "preview"],
        vec!["inspect", "--root", "/unused", "--root", "/other"],
        vec!["launch-spec", "--root", "/unused"],
        vec!["unknown"],
    ] {
        let (success, messages) = invoke(&args);
        assert!(!success);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["type"], "error");
        assert_eq!(messages[0]["code"], "config");
    }
}

#[test]
fn uninstall_accepts_node_directory_identity_and_rejects_a_different_identity() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("node identity 测试");
    std::fs::create_dir(&root).unwrap();
    // RuntimeManager captures these exact values before presenting confirmation.
    let output = match Command::new("node")
        .arg("-e")
        .arg("const s=require('node:fs').statSync(process.argv[1],{bigint:true});console.log(JSON.stringify({device:s.dev.toString(),inode:s.ino.toString()}))")
        .arg(&root)
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("Skipping Node/Rust directory identity test: node is not installed");
            return;
        }
        Err(error) => panic!("Cannot start Node for directory identity test: {error}"),
    };
    assert!(
        output.status.success(),
        "Node stat failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let identity: Value =
        serde_json::from_slice(&output.stdout).expect("Node must return identity JSON");
    let device = identity["device"]
        .as_str()
        .expect("Node device is a decimal string");
    let inode = identity["inode"]
        .as_str()
        .expect("Node inode is a decimal string");
    let root_text = root.to_str().unwrap();
    let (success, messages) = invoke(&[
        "uninstall",
        "--root",
        root_text,
        "--expected-device",
        device,
        "--expected-inode",
        inode,
    ]);
    assert!(!success);
    assert_eq!(messages.len(), 1);
    // Reaching the missing-marker IO error proves the Node identity matched the
    // capability directory handle; no lock or other file has been created.
    assert_eq!(messages[0]["code"], "io", "{messages:?}");

    let different_inode = inode.parse::<u64>().unwrap().wrapping_add(1).to_string();
    let (success, messages) = invoke(&[
        "uninstall",
        "--root",
        root_text,
        "--expected-device",
        device,
        "--expected-inode",
        &different_inode,
    ]);
    assert!(!success);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["code"], "config");
    assert!(
        messages[0]["message"]
            .as_str()
            .unwrap()
            .contains("identity changed")
    );
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
}

#[test]
fn uninstalled_runtime_never_returns_a_launchable_specification() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("runtime");
    let pipe = if cfg!(windows) {
        r"\\.\pipe\baas-cli-protocol".to_string()
    } else {
        parent
            .path()
            .join("service.sock")
            .to_string_lossy()
            .into_owned()
    };
    let (success, messages) = invoke(&[
        "launch-spec",
        "--root",
        root.to_str().unwrap(),
        "--pipe",
        &pipe,
    ]);
    assert!(!success);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["type"], "error");
    assert_eq!(messages[0]["code"], "environment");
    assert!(!root.exists());
}
