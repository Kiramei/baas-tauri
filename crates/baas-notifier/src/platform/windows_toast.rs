use crate::policy::{expiry_seconds, replacement_tag, toast_xml, windows_expiry};
use ::windows::{
    core::{Interface, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::{DateTime, IReference, PropertyValue},
    UI::Notifications::{ToastNotification, ToastNotificationManager},
};
use std::time::{SystemTime, UNIX_EPOCH};

/// Keep the real WinRT identity setters together; no notification is emitted by tests.
pub(super) fn show(app_id: &str, title: &str, body: &str, tag: Option<&str>) -> Result<(), String> {
    let send = || -> ::windows::core::Result<()> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        if let Some(tag) = replacement_tag(tag) {
            toast.SetTag(&HSTRING::from(tag))?;
            toast.SetGroup(&HSTRING::from("baas-events"))?;
        }
        let unix_seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let expiry: IReference<DateTime> = PropertyValue::CreateDateTime(DateTime {
            UniversalTime: windows_expiry(unix_seconds, expiry_seconds(tag)),
        })?
        .cast()?;
        toast.SetExpirationTime(&expiry)?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)
    };
    send().map_err(|error| error.to_string())
}
