import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import StorageUtil from "@/shared/StorageManager.ts";

const baseUrl = import.meta.env.BASE_URL;
const selfKey = "$self";

/** Handles the flatten locale workflow. */
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

/** Performs the sync backend locale operation. */
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
    lng: lang,
    fallbackLng: "en",
    resources: {},
    interpolation: { escapeValue: false },
  });

  await loadLocale(lang);

  console.log("[i18n] initialized");
}

/**
 * Load locale JSON file from /public/locales/
 */
export async function loadLocale(lang: string) {
  try {
    const res = await fetch(`${__WITH_WEBUI__ ? baseUrl : ""}locales/${lang}.json`);
    if (!res.ok) throw new Error(`Failed to load locale: ${lang}`);
    const data = flattenLocale(await res.json());

    // Add or overwrite translations for this language
    i18n.addResourceBundle(lang, "translation", data, true, true);

    // Change the current language
    await i18n.changeLanguage(lang);
    await syncBackendLocale(lang);

    console.log(`[i18n] switched to ${lang}`);
  } catch (err) {
    console.error(`[i18n] failed to load ${lang}:`, err);
  }
}

export default i18n;
