use serde::de::{self, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;

/// Android `Invoke.resolve()` returns null, while background commands resolve
/// with an empty JSObject. Both acknowledge success without a response payload.
/// Do not silently discard unexpected payloads from a mismatched native method.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct NativeVoidAck;

impl<'de> Deserialize<'de> for NativeVoidAck {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct AckVisitor;

        impl<'de> Visitor<'de> for AckVisitor {
            type Value = NativeVoidAck;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("null or an empty Android acknowledgment object")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(NativeVoidAck)
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                if map.next_key::<IgnoredAny>()?.is_some() {
                    return Err(de::Error::custom(
                        "Android acknowledgment object must be empty",
                    ));
                }
                Ok(NativeVoidAck)
            }
        }

        deserializer.deserialize_any(AckVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::NativeVoidAck;
    use serde_json::{json, Value};

    #[test]
    fn native_void_ack_accepts_null_and_empty_object_responses() {
        // This is the same serde_json::from_value boundary used by Tauri's
        // PluginHandle::run_mobile_plugin after Invoke.resolve on Android.
        assert!(serde_json::from_value::<()>(json!({})).is_err());
        for response in [Value::Null, json!({})] {
            assert_eq!(
                serde_json::from_value::<NativeVoidAck>(response).unwrap(),
                NativeVoidAck
            );
        }
    }

    #[test]
    fn native_void_ack_rejects_nonempty_objects_and_scalar_payloads() {
        for response in [
            json!({ "displayId": 9 }),
            json!({ "error": null }),
            json!({ "ok": true }),
            json!([]),
            json!([null]),
            json!(false),
            json!(true),
            json!(0),
            json!(1.5),
            json!(""),
            json!("null"),
        ] {
            assert!(
                serde_json::from_value::<NativeVoidAck>(response.clone()).is_err(),
                "unexpected acknowledgment was accepted: {response}"
            );
        }
    }

    #[test]
    fn native_void_ack_preserves_unit_command_api_and_errors() {
        let decode = |response| serde_json::from_value::<NativeVoidAck>(response).map(|_| ());
        assert_eq!(decode(json!({})).unwrap(), ());
        assert_eq!(decode(Value::Null).unwrap(), ());
        let error = decode(json!({ "unexpected": true })).unwrap_err();
        assert!(error.to_string().contains("must be empty"));
    }

    #[test]
    fn every_android_void_wrapper_decodes_an_explicit_native_ack() {
        let source = include_str!("android_backend_service.rs");
        for name in [
            "launch_game",
            "game_gesture",
            "install_package",
            "set_system_bars",
            "open_shizuku",
            "request_shizuku_permission",
            "stop_shizuku_display",
            "launch_package_on_shizuku_display",
        ] {
            let function = source
                .split(&format!("pub fn {name}<"))
                .nth(1)
                .expect("native wrapper exists")
                .split("\npub fn ")
                .next()
                .unwrap();
            assert!(function.contains("Result<(), String>"), "{name}");
            assert!(
                function.contains("run_mobile_plugin::<NativeVoidAck>"),
                "{name}"
            );
            assert!(function.contains(".map(|_| ())"), "{name}");
        }
    }
}
