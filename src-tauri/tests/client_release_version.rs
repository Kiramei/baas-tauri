#![cfg(not(any(target_os = "android", target_os = "ios")))]

#[path = "../src/client_version.rs"]
mod client_version;

use tauri_plugin_updater::RemoteRelease;

fn release(version: &str) -> RemoteRelease {
    serde_json::from_value(serde_json::json!({
        "version": version,
        "release_version": "0.0.9.post2",
        "platforms": {}
    }))
    .expect("native updater accepts the mapped SemVer manifest")
}

#[test]
fn installed_formal_clients_can_upgrade_to_post_without_skipping_the_next_rc() {
    // Exercise the same RemoteRelease parser and semver::Version comparison used
    // by the real updater's default comparator, including previously shipped clients.
    let formal = release("0.0.9");
    let post2 = release("0.0.10-0.post.2");
    let post10 = release("0.0.10-0.post.10");
    let post999 = release("0.0.10-0.post.999");
    let next_rc = release("0.0.10-rc.0");
    let next_formal = release("0.0.10");
    assert!(formal.version < post2.version);
    assert!(post2.version < post10.version);
    assert!(post10.version < post999.version);
    assert!(post999.version < next_rc.version);
    assert!(next_rc.version < next_formal.version);
    assert_eq!(
        client_version::display_version(&post2.version.to_string()),
        "0.0.9.post2"
    );
}
