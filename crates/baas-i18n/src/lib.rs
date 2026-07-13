//! Backend internationalization resources for BAAS.
//!
//! This crate intentionally keeps backend UI strings separate from the frontend
//! i18next resources. Backend callers use typed keys so menu labels and future
//! backend-facing text do not become scattered string literals.

/// Supported backend locale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Language {
    /// English fallback locale.
    #[default]
    En,
    /// Simplified Chinese.
    Zh,
    /// Japanese.
    Ja,
    /// Korean.
    Ko,
    /// German.
    De,
    /// Russian.
    Ru,
    /// French.
    Fr,
}

impl Language {
    /// Parses a frontend or OS-style language tag and falls back to English.
    pub fn parse(value: &str) -> Self {
        normalize_language(value)
    }
}

/// Typed translation keys used by backend code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum I18nKey {
    /// Tray menu item that restores the main app window.
    TrayShowMainWindow,
    /// Tray menu item that exits the app.
    TrayExit,
}

/// Localized labels used by the tray menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrayMenuLabels {
    pub show_main_window: &'static str,
    pub exit: &'static str,
}

/// Normalizes a language code used by the frontend into a backend locale.
///
/// Values like `zh-CN`, `zh_CN`, and `zh` map to [`Language::Zh`]. Unknown or
/// empty values map to [`Language::En`].
pub fn normalize_language(value: &str) -> Language {
    let normalized = value
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();

    match normalized.as_str() {
        "zh" => Language::Zh,
        "ja" => Language::Ja,
        "ko" => Language::Ko,
        "de" => Language::De,
        "ru" => Language::Ru,
        "fr" => Language::Fr,
        "en" => Language::En,
        _ => Language::En,
    }
}

/// Returns a localized backend string.
pub fn translate(language: Language, key: I18nKey) -> &'static str {
    match (language, key) {
        (Language::En, I18nKey::TrayShowMainWindow) => "Show Window",
        (Language::En, I18nKey::TrayExit) => "Exit App",
        (Language::Zh, I18nKey::TrayShowMainWindow) => "显示窗口",
        (Language::Zh, I18nKey::TrayExit) => "退出程序",
        (Language::Ja, I18nKey::TrayShowMainWindow) => "画面表示",
        (Language::Ja, I18nKey::TrayExit) => "アプリ終了",
        (Language::Ko, I18nKey::TrayShowMainWindow) => "메인 창 표시",
        (Language::Ko, I18nKey::TrayExit) => "종료",
        (Language::De, I18nKey::TrayShowMainWindow) => "Hauptfenster anzeigen",
        (Language::De, I18nKey::TrayExit) => "Beenden",
        (Language::Ru, I18nKey::TrayShowMainWindow) => "Показать главное окно",
        (Language::Ru, I18nKey::TrayExit) => "Выход",
        (Language::Fr, I18nKey::TrayShowMainWindow) => "Afficher la fenêtre principale",
        (Language::Fr, I18nKey::TrayExit) => "Quitter",
    }
}

/// Returns all tray menu labels for a language in one typed payload.
pub fn tray_menu_labels(language: Language) -> TrayMenuLabels {
    TrayMenuLabels {
        show_main_window: translate(language, I18nKey::TrayShowMainWindow),
        exit: translate(language, I18nKey::TrayExit),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_LANGUAGES: [Language; 7] = [
        Language::En,
        Language::Zh,
        Language::Ja,
        Language::Ko,
        Language::De,
        Language::Ru,
        Language::Fr,
    ];

    const ALL_KEYS: [I18nKey; 2] = [I18nKey::TrayShowMainWindow, I18nKey::TrayExit];

    /// Returns the normalizes frontend language codes result.
    #[test]
    fn normalizes_frontend_language_codes() {
        assert_eq!(normalize_language("zh-CN"), Language::Zh);
        assert_eq!(normalize_language("zh_CN"), Language::Zh);
        assert_eq!(normalize_language("en-US"), Language::En);
        assert_eq!(normalize_language(" ja_JP "), Language::Ja);
        assert_eq!(normalize_language("unknown"), Language::En);
        assert_eq!(normalize_language(""), Language::En);
    }

    /// Handles the all backend strings are present workflow.
    #[test]
    fn all_backend_strings_are_present() {
        for language in ALL_LANGUAGES {
            for key in ALL_KEYS {
                assert!(!translate(language, key).trim().is_empty());
            }
        }
    }

    /// Handles the tray labels are grouped by language workflow.
    #[test]
    fn tray_labels_are_grouped_by_language() {
        let labels = tray_menu_labels(Language::Zh);
        assert_eq!(labels.show_main_window, "显示窗口");
        assert_eq!(labels.exit, "退出程序");
    }
}
