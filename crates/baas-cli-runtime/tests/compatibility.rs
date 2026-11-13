use serde_json::{Value, json};
use std::{fs, process::Command};

#[test]
fn legacy_executable_inspects_existing_marker_with_the_current_library_protocol() {
    let root = tempfile::tempdir().unwrap();
    let marker = json!({
        "owner": "baas-cli-runtime", "schemaVersion": 1, "root": root.path(),
        "channel": "dev", "complete": false
    });
    let marker_path = root.path().join(".baas-cli-runtime.json");
    let bytes = serde_json::to_vec(&marker).unwrap();
    fs::write(&marker_path, &bytes).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_baas-cli-runtime"))
        .args(["inspect", "--root"])
        .arg(root.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let expected = baas_cli_runtime::inspect(root.path()).unwrap();
    assert!(expected.managed);
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"type": "result", "data": expected})
    );
    assert_eq!(fs::read(marker_path).unwrap(), bytes);
}
