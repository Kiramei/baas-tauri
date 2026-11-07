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
    assert_eq!(messages[0]["code"], "config");
    assert!(
        messages[0]["message"]
            .as_str()
            .unwrap()
            .contains("unmanaged")
    );
    assert_eq!(std::fs::read_to_string(existing).unwrap(), "user data");
    assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 1);
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
