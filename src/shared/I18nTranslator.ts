import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import StorageUtil from "@/shared/StorageManager.ts";

const baseUrl = import.meta.env.BASE_URL;

/**
 * Initialize i18next immediately so React never complains.
 * Resources are empty at first; we load them dynamically later.
 */
export async function initI18n() {
  await StorageUtil.init().catch(() => {
    console.warn("[i18n] Storage init failed, fallback to default settings");
  });

  await i18n.use(initReactI18next).init({
    lng: StorageUtil.get("uiSettings")?.["lang"] || "en",
    fallbackLng: "en",
    resources: {},
    interpolation: { escapeValue: false },
  });

  console.log("[i18n] initialized");
}

/**
 * Load locale JSON file from /public/locales/
 */
export async function loadLocale(lang: string) {
  try {
    const res = await fetch(`${__WITH_WEBUI__ ? baseUrl : ""}locales/${lang}.json`);
    if (!res.ok) throw new Error(`Failed to load locale: ${lang}`);
    const data = await res.json();

    // Add or overwrite translations for this language
    i18n.addResourceBundle(lang, "translation", data, true, true);

    // Change the current language
    await i18n.changeLanguage(lang);

    console.log(`[i18n] switched to ${lang}`);
  } catch (err) {
    console.error(`[i18n] failed to load ${lang}:`, err);
  }
}

export default i18n;
