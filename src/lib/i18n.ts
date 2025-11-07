import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { StorageUtil } from "@/lib/storage.ts";

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

export async function loadLocale(lang: string) {
  try {
    const res = await fetch(`/locales/${lang}.json`);
    if (!res.ok) throw new Error(`Failed to load locale: ${lang}`);
    const data = await res.json();
    i18n.addResourceBundle(lang, "translation", data, true, true);
    await i18n.changeLanguage(lang);
    console.log(`[i18n] switched to ${lang}`);
  } catch (err) {
    console.error(`[i18n] failed to load ${lang}:`, err);
  }
}

export default i18n;
