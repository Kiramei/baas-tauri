/// Never let the native fallback raise a routine toast over a focused app.
/// Unknown focus also suppresses delivery, without requesting OS permission.
#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
pub(crate) fn suppress_for_focus(states: impl IntoIterator<Item = Result<bool, ()>>) -> bool {
    states.into_iter().any(|state| !matches!(state, Ok(false)))
}

/// Windows Tag is limited to 16 characters on older supported systems.
/// FNV-1a is fixed across processes/platforms, unlike a seeded map hasher.
#[cfg(any(windows, test))]
pub(crate) fn replacement_tag(tag: Option<&str>) -> Option<String> {
    let tag = tag.map(str::trim).filter(|tag| !tag.is_empty())?;
    let hash = tag
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    Some(format!("{hash:016x}"))
}

#[cfg(any(windows, test))]
pub(crate) fn expiry_seconds(tag: Option<&str>) -> u64 {
    if tag.is_some_and(|tag| tag.ends_with(":failed") || tag.starts_with("service:disconnected:")) {
        300
    } else {
        10
    }
}

#[cfg(any(windows, test))]
pub(crate) fn windows_expiry(unix_seconds: u64, ttl_seconds: u64) -> i64 {
    // Windows DateTime counts 100 ns intervals since 1601-01-01.
    let ticks = (u128::from(unix_seconds) + u128::from(ttl_seconds) + 11_644_473_600) * 10_000_000;
    ticks.min(i64::MAX as u128) as i64
}

#[cfg(any(windows, test))]
fn xml_text(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            '\t' | '\n' | '\r' => escaped.push(ch),
            ch if ch >= '\u{20}' && ch != '\u{fffe}' && ch != '\u{ffff}' => escaped.push(ch),
            _ => {}
        }
    }
    escaped
}

#[cfg(any(windows, test))]
pub(crate) fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast duration=\"short\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        xml_text(title), xml_text(body)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focused_or_unavailable_windows_suppress_but_background_and_tray_allow() {
        assert!(suppress_for_focus([Ok(false), Ok(true)]));
        assert!(suppress_for_focus([Ok(false), Err(())]));
        assert!(!suppress_for_focus([Ok(false), Ok(false)]));
        assert!(!suppress_for_focus([]));
    }

    #[test]
    fn replacement_keys_are_stable_bounded_and_keep_failure_separate() {
        let complete = replacement_tag(Some("script:profile-a:completed")).unwrap();
        assert_eq!(
            complete,
            replacement_tag(Some("script:profile-a:completed")).unwrap()
        );
        assert_eq!(complete.len(), 16);
        assert!(complete.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(
            complete,
            replacement_tag(Some("script:profile-a:failed")).unwrap()
        );
        assert_ne!(
            complete,
            replacement_tag(Some("script:profile-b:completed")).unwrap()
        );
        assert_eq!(replacement_tag(None), None);
        assert_eq!(replacement_tag(Some(" \n ")), None);
        // A known hash vector ensures a refactor cannot silently change OS IDs.
        assert_eq!(
            replacement_tag(Some("hello")).as_deref(),
            Some("a430d84680aabd0b")
        );
    }

    #[test]
    fn unicode_ids_remain_portable_and_completed_toasts_expire_quickly() {
        assert_eq!(
            replacement_tag(Some("script:配置😀:failed")).unwrap().len(),
            16
        );
        assert_eq!(expiry_seconds(Some("script:profile:completed")), 10);
        assert_eq!(expiry_seconds(Some("script:batch:completed")), 10);
        assert_eq!(expiry_seconds(Some("script:profile:failed")), 300);
        assert_eq!(expiry_seconds(Some("service:disconnected:websocket")), 300);
        assert_eq!(expiry_seconds(None), 10);
        assert_eq!(windows_expiry(0, 10), 116_444_736_100_000_000);
        assert_eq!(windows_expiry(u64::MAX, 300), i64::MAX);
    }

    #[test]
    fn toast_content_is_text_and_illegal_xml_controls_are_removed() {
        let xml = toast_xml(
            "中文😀 & <title>\0\u{7}",
            "\"quote\" 'single'\n\t</text>\u{fffe}\u{ffff}",
        );
        assert!(xml.contains("中文😀 &amp; &lt;title&gt;"));
        assert!(xml.contains("&quot;quote&quot; &apos;single&apos;\n\t&lt;/text&gt;"));
        assert!(!xml.contains('\0'));
        assert!(!xml.contains('\u{7}'));
        assert!(!xml.contains('\u{fffe}'));
        assert!(!xml.contains('\u{ffff}'));
    }
}
