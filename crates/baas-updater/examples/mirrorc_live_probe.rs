//! Explicit local-only credential probe. Credentials never enter arguments or reports.
use baas_updater::{
    NoopOutput, RepositoryKind, UpdateChannel,
    mirrorc::{MirrorCClient, MirrorUpdateRequest, ReqwestMirrorHttp},
};
use serde_json::json;
use std::{env, fs, path::PathBuf, time::Duration};

fn main() {
    if run().is_err() {
        // Do not print external bodies, request URLs or credential-bearing debug values.
        eprintln!("MirrorC probe could not complete; no credential details were logged.");
        std::process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let secret_path = PathBuf::from(env::var("BAAS_MIRRORC_TEST_SECRET_FILE")?);
    let text = fs::read_to_string(secret_path)?;
    let credentials: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| line.len() == 24 && line.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .take(4)
        .collect();
    if credentials.is_empty() {
        return Err("No local test credentials found".into());
    }
    let download = env::var("BAAS_MIRRORC_TEST_DOWNLOAD").as_deref() == Ok("1");
    let client = MirrorCClient::with_timeout(ReqwestMirrorHttp, Duration::from_secs(30));
    let mut valid_main = None;
    let mut any_success = false;
    for (index, cdk) in credentials.iter().enumerate() {
        for (kind, resource) in [(RepositoryKind::Main, "main"), (RepositoryKind::Cpp, "cpp")] {
            match client.latest(kind, UpdateChannel::Stable, "", cdk) {
                Ok(latest) => {
                    println!(
                        "{}",
                        json!({
                            "credential_case": index + 1, "resource": resource,
                            "code": latest.code, "cdk_state": latest.cdk_state().map(|state| format!("{state:?}")),
                            "download_available": latest.has_url(), "update_type": latest.update_type,
                            "file_size": latest.file_size, "version": latest.latest_version_name,
                            "proxy_policy": "direct-only",
                        })
                    );
                    any_success |= latest.is_success();
                    if kind == RepositoryKind::Main && latest.is_success() && valid_main.is_none() {
                        valid_main = Some(*cdk);
                    }
                }
                Err(error) => println!(
                    "{}",
                    json!({
                        "credential_case": index + 1, "resource": resource,
                        "error_category": error.code(), "proxy_policy": "direct-only",
                    })
                ),
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    }
    if download {
        if let Some(cdk) = valid_main {
            let target = tempfile::Builder::new()
                .prefix("BAAS-MirrorC-verification-")
                .tempdir()?;
            let marker = target.path().join("config/local-verification.json");
            fs::create_dir_all(marker.parent().unwrap())?;
            fs::write(&marker, "{\"local_config\":true}")?;
            let result = client.update(
                &MirrorUpdateRequest {
                    kind: RepositoryKind::Main,
                    channel: UpdateChannel::Stable,
                    current_version: "",
                    cdk,
                    target_dir: target.path(),
                },
                &NoopOutput,
            )?;
            let config_preserved = fs::read_to_string(&marker)? == "{\"local_config\":true}";
            let unchanged = client.update(
                &MirrorUpdateRequest {
                    kind: RepositoryKind::Main,
                    channel: UpdateChannel::Stable,
                    current_version: &result.version,
                    cdk,
                    target_dir: target.path(),
                },
                &NoopOutput,
            )?;
            println!(
                "{}",
                json!({
                    "download_status": format!("{:?}", result.status),
                    "same_version_status": format!("{:?}", unchanged.status),
                    "config_preserved": config_preserved,
                    "target": target.keep(),
                })
            );
        } else {
            println!("{}", json!({"download_status":"blocked_no_valid_cdk"}));
        }
    }
    println!(
        "{}",
        json!({"any_success":any_success,"credentials_printed":false})
    );
    Ok(())
}
