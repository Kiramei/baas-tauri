import zh from "../locales/zh.json";
import en from "../locales/en.json";
import ja from "../locales/ja.json";
import ko from "../locales/ko.json";
import de from "../locales/de.json";
import fr from "../locales/fr.json";
import ru from "../locales/ru.json";

export const LANGUAGES = [
  { id: "zh", label: "简体中文" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
  { id: "de", label: "Deutsch" },
  { id: "fr", label: "Français" },
  { id: "ru", label: "Русский" },
] as const;

type Catalog = Record<string, string>;
const catalogs: Record<string, Catalog> = { zh, en, ja, ko, de, fr, ru };

function supportedLanguage(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .split(/[_.@-]/)[0];
  if (["c", "posix"].includes(normalized)) return "en";
  return Object.hasOwn(catalogs, normalized) ? normalized : undefined;
}

/** CLI choice, BAAS_LANG, saved choice, then the operating system locale. */
export function detectLanguage(
  explicit?: string,
  saved?: string,
  env: Record<string, string | undefined> = process.env
): string {
  for (const candidate of [explicit, env.BAAS_LANG, saved, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const language = supportedLanguage(candidate);
    if (language) return language;
  }
  return "en";
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const templates = Object.keys(en)
  .filter((key) => /\{\w+\}/.test(key))
  .map((key) => {
    const names: string[] = [];
    const pieces = key.split(/(\{\w+\})/).map((piece) => {
      const match = /^\{(\w+)\}$/.exec(piece);
      if (match) {
        names.push(match[1]);
        return "(.+?)";
      }
      return escape(piece);
    });
    return { key, names, expression: new RegExp(`^${pieces.join("")}$`) };
  });

/** Translate known UI text only; unknown text and backend data pass through. */
export function translate(text: string, language: string): string {
  const locale = supportedLanguage(language) || "en";
  if (locale === "zh" || !text) return text;
  const catalog = catalogs[locale];
  const direct = catalog[text] ?? (en as Catalog)[text];
  if (direct !== undefined) return direct;
  if (!/[\p{Script=Han}]/u.test(text)) return text;
  const trimmed = text.trim();
  if (trimmed !== text) {
    const translated = translate(trimmed, locale);
    return (
      text.slice(0, text.indexOf(trimmed)) +
      translated +
      text.slice(text.indexOf(trimmed) + trimmed.length)
    );
  }
  if (text.includes("\n"))
    return text
      .split("\n")
      .map((line) => translate(line, locale))
      .join("\n");
  if (text.includes(" → "))
    return text
      .split(" → ")
      .map((part) => translate(part, locale))
      .join(" → ");
  if (text.includes(" · "))
    return text
      .split(" · ")
      .map((part) => translate(part, locale))
      .join(" · ");
  const decoration = /^(?:[●○◌❯✦✧⋆?✓·]\s+)(.+)$/u.exec(text);
  if (decoration) return text.slice(0, -decoration[1].length) + translate(decoration[1], locale);
  for (const template of templates) {
    const match = template.expression.exec(text);
    if (!match) continue;
    const result = catalog[template.key] ?? (en as Catalog)[template.key];
    if (!result) continue;
    return result.replace(/\{(\w+)\}/g, (_, name: string) => {
      const index = template.names.indexOf(name);
      return index < 0 ? `{${name}}` : translate(match[index + 1], locale);
    });
  }
  return text;
}
