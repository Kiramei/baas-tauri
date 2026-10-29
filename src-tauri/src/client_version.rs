//! Public client versions use x.y.z[.rcN|.postN]; native packages retain ordered SemVer.

#[cfg(any(target_os = "android", test))]
use std::cmp::Ordering;

const MAX_COMPONENT: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum Kind {
    Rc,
    Stable,
    Post,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ReleaseVersion {
    major: u64,
    minor: u64,
    patch: u64,
    kind: Kind,
    serial: u64,
}

fn number(value: &str) -> Option<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= MAX_COMPONENT)
}

fn base(value: &str, kind: Kind, serial: u64) -> Option<ReleaseVersion> {
    let mut parts = value.split('.');
    let version = ReleaseVersion {
        major: number(parts.next()?)?,
        minor: number(parts.next()?)?,
        patch: number(parts.next()?)?,
        kind,
        serial,
    };
    if parts.next().is_some() || (kind == Kind::Post && version.patch == MAX_COMPONENT) {
        return None;
    }
    Some(version)
}

impl ReleaseVersion {
    fn parse(value: &str) -> Option<Self> {
        let input = value.trim().strip_prefix('v').unwrap_or(value.trim());
        let input = if let Some((version, build)) = input.split_once('+') {
            if build.is_empty()
                || !build
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
            {
                return None;
            }
            version
        } else {
            input
        };
        for (marker, kind) in [(".rc", Kind::Rc), (".post", Kind::Post)] {
            if let Some((value, serial)) = input.rsplit_once(marker) {
                if let Some(parsed) = number(serial).and_then(|serial| base(value, kind, serial)) {
                    return Some(parsed);
                }
            }
        }
        if let Some((value, serial)) = input.split_once("-0.post.") {
            let mut parsed = base(value, Kind::Stable, number(serial)?)?;
            parsed.patch = parsed.patch.checked_sub(1)?;
            parsed.kind = Kind::Post;
            return Some(parsed);
        }
        // Older published tags include v0.0.8-rc, -rc1 and -rc.1.
        let legacy = input.to_ascii_lowercase();
        if let Some((value, serial)) = legacy.split_once("-rc") {
            let serial = serial
                .strip_prefix('.')
                .or_else(|| serial.strip_prefix('-'))
                .unwrap_or(serial);
            return base(
                value,
                Kind::Rc,
                if serial.is_empty() {
                    0
                } else {
                    number(serial)?
                },
            );
        }
        base(input, Kind::Stable, 0)
    }

    fn canonical(&self) -> String {
        let base = format!("{}.{}.{}", self.major, self.minor, self.patch);
        match self.kind {
            Kind::Stable => base,
            Kind::Rc => format!("{base}.rc{}", self.serial),
            Kind::Post => format!("{base}.post{}", self.serial),
        }
    }
}

pub(crate) fn normalize_version(value: &str) -> Option<String> {
    ReleaseVersion::parse(value).map(|version| version.canonical())
}

pub(crate) fn display_version(value: &str) -> String {
    normalize_version(value).unwrap_or_else(|| value.to_string())
}

/// Invalid metadata must not turn into a spurious client upgrade.
#[cfg(any(target_os = "android", test))]
pub(crate) fn compare_versions(left: &str, right: &str) -> Ordering {
    match (ReleaseVersion::parse(left), ReleaseVersion::parse(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        _ => Ordering::Equal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_numbers_then_stage_then_counter_define_the_total_order() {
        let ordered = [
            "0.0.9.rc2",
            "0.0.9.rc10",
            "0.0.9",
            "0.0.9.post2",
            "0.0.9.post10",
            "0.0.9.post999",
            "0.0.10.rc0",
            "0.0.10",
            "1.5.2.rc10",
            "1.5.2",
            "1.5.2.post2",
        ];
        for pair in ordered.windows(2) {
            assert_eq!(
                compare_versions(pair[0], pair[1]),
                Ordering::Less,
                "{pair:?}"
            );
            assert_eq!(
                compare_versions(pair[1], pair[0]),
                Ordering::Greater,
                "{pair:?}"
            );
        }
        assert_eq!(
            compare_versions("2.10.3", "2.2.30.post999"),
            Ordering::Greater
        );
    }

    #[test]
    fn native_mapping_and_historical_tags_are_readable_without_displaying_the_mapping() {
        for (native, public) in [
            ("0.0.9", "0.0.9"),
            ("1.5.2-rc.10", "1.5.2.rc10"),
            ("1.5.3-0.post.2", "1.5.2.post2"),
            ("v0.0.8-rc", "0.0.8.rc0"),
            ("v0.0.8-rc1", "0.0.8.rc1"),
            ("v0.0.8-rc.1", "0.0.8.rc1"),
            ("v0.0.9+build.7", "0.0.9"),
        ] {
            assert_eq!(display_version(native), public);
            assert_eq!(compare_versions(native, public), Ordering::Equal);
        }
        assert_eq!(
            compare_versions("0.0.10-0.post.999", "0.0.10-rc.0"),
            Ordering::Less
        );
    }

    #[test]
    fn invalid_versions_do_not_become_upgrade_candidates() {
        for value in [
            "",
            "1.2",
            "1.2.3oops",
            "01.2.3",
            "1.2.3.rc-1",
            "0.0.0-0.post.1",
            "1.2.3+?",
        ] {
            assert!(normalize_version(value).is_none(), "{value}");
            assert_eq!(compare_versions(value, "0.0.9"), Ordering::Equal);
        }
    }
}
