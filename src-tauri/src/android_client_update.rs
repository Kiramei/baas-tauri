//! Signed APK metadata shared by the Android update check and installer.
use crate::client_version::normalize_version;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;
use std::io::{Read, Write};

pub(crate) struct Release {
    pub version: String,
    pub notes: String,
    pub date: String,
    pub package: Option<Package>,
}

pub(crate) struct Package {
    pub url: String,
    pub signature: Signature,
}

impl Release {
    pub fn parse(metadata: &Value, arch: &str) -> Result<Self, String> {
        let field = |key, alias| {
            metadata
                .get(key)
                .or_else(|| metadata.get(alias))
                .and_then(Value::as_str)
                .unwrap_or_default()
        };
        let version = normalize_version(field("version", "name"))
            .ok_or_else(|| "Invalid client update release version".to_string())?;
        let platforms = metadata
            .get("platforms")
            .and_then(Value::as_object)
            .ok_or_else(|| "Missing update platforms".to_string())?;
        let target = match arch {
            "aarch64" => "android-arm64-v8a",
            "arm" | "armv7" => "android-armeabi-v7a",
            "x86_64" => "android-x86_64",
            "x86" => "android-x86",
            _ => "android",
        };
        let package = platforms
            .get(target)
            .or_else(|| platforms.get("android"))
            .map(|entry| {
                let url = entry
                    .get("url")
                    .and_then(Value::as_str)
                    .and_then(|url| tauri::Url::parse(url).ok())
                    .filter(|url| url.scheme() == "https" && url.has_host())
                    .ok_or("Missing secure Android package URL")?;
                let encoded = entry
                    .get("signature")
                    .and_then(Value::as_str)
                    .ok_or("Missing Android package signature")?;
                let signature = Signature::decode(&decode_minisign(encoded)?)
                    .map_err(|e| format!("Invalid Android package signature: {e}"))?;
                Ok::<_, String>(Package {
                    url: url.to_string(),
                    signature,
                })
            })
            .transpose()?;
        Ok(Self {
            version,
            notes: field("notes", "body").to_owned(),
            date: field("pub_date", "date").to_owned(),
            package,
        })
    }
}

fn decode_minisign(encoded: &str) -> Result<String, String> {
    let bytes = STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("Invalid Minisign encoding: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("Invalid Minisign text: {e}"))
}

pub(crate) fn public_key(encoded: &str) -> Result<PublicKey, String> {
    PublicKey::decode(&decode_minisign(encoded)?)
        .map_err(|e| format!("Invalid Android update public key: {e}"))
}

pub(crate) enum PackageError {
    Source(String),
    Storage(std::io::Error),
}

/// Hash exactly the bytes being written. The caller publishes the temporary file only on success.
pub(crate) fn copy_verified_apk(
    mut from: impl Read,
    mut to: impl Write,
    key: &PublicKey,
    signature: &Signature,
    mut progress: impl FnMut(usize),
) -> Result<(), PackageError> {
    let invalid = |e: minisign_verify::Error| {
        PackageError::Source(format!("Android update signature verification failed: {e}"))
    };
    let mut verifier = key.verify_stream(signature).map_err(invalid)?;
    let mut magic = [0; 4];
    from.read_exact(&mut magic)
        .map_err(|e| PackageError::Source(e.to_string()))?;
    if magic != *b"PK\x03\x04" {
        return Err(PackageError::Source(
            "Downloaded Android update is not an APK archive".into(),
        ));
    }
    verifier.update(&magic);
    to.write_all(&magic).map_err(PackageError::Storage)?;
    let mut pending = magic.len();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let count = from
            .read(&mut buffer)
            .map_err(|e| PackageError::Source(e.to_string()))?;
        if count == 0 {
            break;
        }
        let chunk = &buffer[..count];
        to.write_all(chunk).map_err(PackageError::Storage)?;
        verifier.update(chunk);
        pending += count;
        if pending >= 256 * 1024 {
            progress(pending);
            pending = 0;
        }
    }
    verifier.finalize().map_err(invalid)?;
    if pending != 0 {
        progress(pending);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Tauri CLI fixture signed with a disposable key.
    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQxRDY1REQ5NUJGNEM2NTUKUldSVnh2UmIyVjNXMGI3NlNaUUFZS2doL1pDNFhZTW5QZk52S0tudVA3cUVRZXRGNmtqN2lpNGMK";
    const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSVnh2UmIyVjNXMGY2Sm1qckZZcGNKZ3V3Rm9DeFdwalZLQVFhL2ZFTXl4dEx3Z1BsOEwvTUxFSGlFc2RMbzdTZ1d4enhNNGZzc2d3R1ZoenZ3T2theCs5MHM0YmtnUGc4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NTY3MTE3CWZpbGU6Zml4dHVyZS5hcGsKOVJhTWpiRXNLOXRDcXpTOTEreis0a01zQ0FxZ21XWkl2QXpnajZDL1FJeHRSTU4zK3ZlSWxnR2MwTDRzZ0dGdU5uNmxLd0sxaG5uOWVBcXdxRmh3Q2c9PQo=";

    #[test]
    fn select_only_matching_or_universal_signed_apk() {
        let entry = json!({"url":"https://example.org/app.apk","signature":SIG});
        let mut feed = json!({"version":"1.2.3", "platforms":{"android-arm64-v8a":entry}});
        assert!(Release::parse(&feed, "aarch64").unwrap().package.is_some());
        assert!(Release::parse(&feed, "x86_64").unwrap().package.is_none());
        feed["platforms"]["android"] = entry;
        assert!(Release::parse(&feed, "x86_64").unwrap().package.is_some());
        feed["platforms"]["android"]["url"] = json!("http://example.org/app.apk");
        assert!(Release::parse(&feed, "x86_64").is_err());
        feed["platforms"]["android-arm64-v8a"]["signature"] = json!("");
        assert!(Release::parse(&feed, "aarch64").is_err());
    }

    #[test]
    fn tauri_signature_verifies_only_the_original_apk_bytes() {
        let key = public_key(KEY).unwrap();
        let signature = Signature::decode(&decode_minisign(SIG).unwrap()).unwrap();
        let valid = b"PK\x03\x04hello apk";
        let mut written = Vec::new();
        let mut downloaded = 0;
        assert!(
            copy_verified_apk(valid.as_slice(), &mut written, &key, &signature, |n| {
                downloaded += n
            })
            .is_ok()
        );
        assert_eq!(written, valid);
        assert_eq!(downloaded, valid.len());
        for invalid in [b"PK\x03\x04modified".as_slice(), b"PK\x03\x04", b"html"] {
            assert!(matches!(
                copy_verified_apk(invalid, std::io::sink(), &key, &signature, |_| {}),
                Err(PackageError::Source(_))
            ));
        }
    }
}
