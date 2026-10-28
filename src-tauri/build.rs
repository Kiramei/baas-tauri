/// Handles the main workflow.
fn main() {
    // Packaged Android assets are local. Remote dev-server ACLs expand into
    // hundreds of repeated URLPattern regex compilations at runtime.
    // Keep those ACLs for `tauri android dev`, and leave desktop builds intact.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android")
        && !tauri_build::is_dev()
    {
        println!("cargo:rerun-if-changed=capabilities/android.json");
        let mut capability: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string("capabilities/android.json").expect("Android capability"),
        ).expect("valid Android capability");
        capability.as_object_mut().expect("capability object").remove("remote");
        let path = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"))
            .join("android-local-capability.json");
        let content = serde_json::to_vec(&capability).unwrap();
        if std::fs::read(&path).ok().as_deref() != Some(content.as_slice()) {
            std::fs::write(&path, content).unwrap();
        }
        let pattern = Box::leak(path.to_string_lossy().replace('\\', "/").into_boxed_str());
        tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(pattern))
            .expect("Android local capability build");
    } else {
        tauri_build::build();
    }
    // Tauri embeds this manifest for binaries, but not for native smoke examples.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-examples=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
}
