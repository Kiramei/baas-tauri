import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import StorageUtil from "@/shared/StorageManager.ts";
import englishLocale from "../../public/locales/en.json";

const baseUrl = import.meta.env.BASE_URL ?? "/";
const selfKey = "$self";
const supportedLocales = new Set(["en", "zh", "ja", "ko", "de", "ru", "fr"]);

function flattenLocale(value: unknown, prefix = "", output: Record<string, string> = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;

  for (const [key, child] of Object.entries(value)) {
    if (key === selfKey) {
      if (prefix) output[prefix] = String(child);
      continue;
    }

    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenLocale(child, nextKey, output);
    } else {
      output[nextKey] = String(child);
    }
  }

  return output;
}

async function syncBackendLocale(lang: string) {
  if (!__WITH_TAURI__ || __WITH_ANDROID__) return;
  try {
    const { invoke } = await import("@/shared/TauriInvoke");
    await invoke("set_backend_locale", { lang });
  } catch (err) {
    console.error(`[i18n] failed to sync backend locale ${lang}:`, err);
  }
}

/**
 * Initialize i18next immediately so React never complains.
 * Resources are empty at first; we load them dynamically later.
 */
export async function initI18n() {
  await StorageUtil.init().catch(() => {
    console.warn("[i18n] Storage init failed, fallback to default settings");
  });

  const lang = StorageUtil.get("uiSettings")?.["lang"] || "en";

  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    // English ships with the application so a missing locale cannot leave raw keys.
    resources: { en: { translation: flattenLocale(englishLocale) } },
    interpolation: { escapeValue: false },
  });

  await loadLocale(lang);

  console.log("[i18n] initialized");
}

/**
 * Load locale JSON file from /public/locales/
 */
export async function loadLocale(lang: string): Promise<boolean> {
  if (!supportedLocales.has(lang)) return false;
  try {
    let data: Record<string, string>;
    if (lang === "en") {
      data = flattenLocale(englishLocale);
    } else {
      const res = await fetch(`${__WITH_WEBUI__ ? baseUrl : ""}locales/${lang}.json`);
      if (!res.ok) throw new Error(`Failed to load locale: ${lang}`);
      data = flattenLocale(await res.json());
      if (Object.keys(data).length === 0) throw new Error(`Empty locale: ${lang}`);
    }

    // Add or overwrite translations for this language
    i18n.addResourceBundle(lang, "translation", data, true, true);

    // Change the current language
    await i18n.changeLanguage(lang);
    await syncBackendLocale(lang);

    console.log(`[i18n] switched to ${lang}`);
    return true;
  } catch (err) {
    console.error(`[i18n] failed to load ${lang}:`, err);
    return false;
  }
}

export default i18n;
