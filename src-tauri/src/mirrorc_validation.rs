use baas_updater::{
    mirrorc::{MirrorCClient, ReqwestMirrorHttp},
    RepositoryKind, UpdateChannel,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::time::Duration;

/// MirrorC CDK validation result returned to the setup wizard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorCValidateReport {
    pub success: bool,
    pub code: Option<i32>,
    pub message: String,
    pub mirrorc_message: Option<String>,
    pub latest_version: Option<String>,
    pub expires_at: Option<u64>,
    pub expires_at_iso: Option<String>,
}

pub fn validate(cdk: &str, channel: UpdateChannel) -> MirrorCValidateReport {
    let mut report = MirrorCValidateReport {
        success: false,
        code: None,
        message: String::new(),
        mirrorc_message: None,
        latest_version: None,
        expires_at: None,
        expires_at_iso: None,
    };
    if cdk.trim().is_empty() {
        report.code = Some(7002);
        report.message = "CDK invalid.".into();
        return report;
    }
    match MirrorCClient::new(ReqwestMirrorHttp).latest(RepositoryKind::Main, channel, "", cdk) {
        Ok(latest) => {
            report.success = latest.is_success();
            report.code = Some(latest.code);
            report.message = match latest.code {
                0 => "CDK valid.".into(),
                7001 => "The cdk has expired".into(),
                7002 => "CDK invalid.".into(),
                7003 => "CDK quota exhausted for today.".into(),
                7004 => "CDK mismatched for requested resource.".into(),
                7005 => "CDK blocked.".into(),
                code => format!("MirrorChyan returned code {code}."),
            };
            report.latest_version = latest.latest_version_name;
            report.expires_at = latest.cdk_expired_time;
            report.expires_at_iso = format_mirrorc_expiry(report.expires_at);
        }
        Err(error) => report.message = error.message(),
    }
    report
}

/// Anonymous metadata suffices for a version check and does not request a keyed download.
pub fn remote_version(channel: UpdateChannel) -> Result<String, String> {
    remote_version_with_timeout(channel, Duration::from_secs(15))
}

pub fn remote_version_with_timeout(
    channel: UpdateChannel,
    timeout: Duration,
) -> Result<String, String> {
    let latest = MirrorCClient::with_timeout(ReqwestMirrorHttp, timeout)
        .latest(RepositoryKind::Main, channel, "", "")
        .map_err(|e| e.message())?;
    if !latest.is_success() {
        return Err(format!("MirrorChyan returned code {}", latest.code));
    }
    latest
        .latest_version_name
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "MirrorChyan did not return a backend version".into())
}

/// Returns the format mirrorc expiry result.
fn format_mirrorc_expiry(expires_at: Option<u64>) -> Option<String> {
    let timestamp = i64::try_from(expires_at?).ok()?;
    DateTime::<Utc>::from_timestamp(timestamp, 0).map(|datetime| datetime.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_key_is_rejected_locally() {
        let report = validate(" ", UpdateChannel::Stable);
        assert!(!report.success);
        assert_eq!(report.code, Some(7002));
    }

    #[test]
    fn expiry_is_an_iso_timestamp_for_all_platforms() {
        assert_eq!(format_mirrorc_expiry(None), None);
        assert_eq!(
            format_mirrorc_expiry(Some(0)).as_deref(),
            Some("1970-01-01T00:00:00+00:00")
        );
    }
}
