const baseUrl = import.meta.env.BASE_URL;

export type LanguageCode = "en" | "zh";

export interface LocalizedField {
  en: string;
  zh?: string;
}

interface ArticleBase {
  id: string;
  category:
    | "architecture"
    | "getting-started"
    | "environment"
    | "configuration"
    | "operations"
    | "support"
    | "formation";
  title: LocalizedField;
  summary: LocalizedField;
  tags: string[];
}

export interface RefArticle extends ArticleBase {
  basename: string;
}

export interface WikiArticle extends RefArticle {
  body: Partial<Record<LanguageCode, string>>;
}

// language folder mapping
const LANG_PATHS: Record<LanguageCode, string> = {
  en: "en_US",
  zh: "zh_CN",
};

// Load Docs from local
export const loadDocs = async (basename: string, language: LanguageCode) => {
  const result: Partial<Record<LanguageCode, string>> = {};
  const path = `${baseUrl}docs/${LANG_PATHS[language]}/${basename}.md`;
  const articleFetched = await fetch(path);
  result[language] = await articleFetched.text();
  return result;
};

// ----------------------
// Passage List
// ----------------------
export const getWikiArticles: (language: LanguageCode) => Promise<WikiArticle[]> = async (
  language: LanguageCode
): Promise<WikiArticle[]> => {
  const res = await fetch(`${baseUrl}docs/entry.json`);
  const parsedRef = await res.json();
  return Promise.all(
    parsedRef.map(async (item: { basename: string }) => ({
      ...item,
      body: await loadDocs(item.basename, language),
    }))
  );
};

// ----------------------
// Tool Functions
// ----------------------
export const mapLanguage = (language: string): LanguageCode => {
  if (language.startsWith("zh")) return "zh";
  return "en";
};

/** Returns the get localized field result. */
export const getLocalizedField = (field: LocalizedField, lang: LanguageCode): string => {
  return field[lang] ?? field.en;
};
