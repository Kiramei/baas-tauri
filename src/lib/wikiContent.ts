// src/descriptions/wikiContent.ts
export type LanguageCode = 'en' | 'zh' | 'ja' | 'ko' | 'fr' | 'de' | 'ru';

export interface LocalizedField {
  en: string;
  zh?: string;
  ja?: string;
  ko?: string;
  fr?: string;
  de?: string;
  ru?: string;
}

interface ArticleBase {
  id: string;
  category:
    | 'architecture'
    | 'getting-started'
    | 'environment'
    | 'configuration'
    | 'operations'
    | 'support'
    | 'formation';
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
  en: 'en_US',
  zh: 'zh_CN',
  ja: 'ja_JP',
  ko: 'ko_KR',
  fr: 'fr_FR',
  de: 'de_DE',
  ru: 'ru_RU',
};

// Load Docs from local
export const loadDocs = async (basename: string, language: LanguageCode) => {
  const result: Partial<Record<LanguageCode, string>> = {};
  const path = `/docs/${LANG_PATHS[language]}/${basename}.md`;
  const articleFetched = await fetch(path);
  result[language] = await articleFetched.text();
  return result;
};


// ----------------------
// Passage List
// ----------------------
export const getWikiArticles: (language: LanguageCode) => Promise<WikiArticle[]> = async (language: LanguageCode): Promise<WikiArticle[]> => {
  const res = await fetch("/docs/entry.json");
  const parsedRef = await res.json();
  return Promise.all(parsedRef.map(async (item: { basename: string }) => ({
    ...item, body: await loadDocs(item.basename, language)
  })));
};


// ----------------------
// Tool Functions
// ----------------------
export const mapLanguage = (language: string): LanguageCode => {
  if (language.startsWith('zh')) return 'zh';
  if (language.startsWith('ja')) return 'ja';
  if (language.startsWith('ko')) return 'ko';
  if (language.startsWith('fr')) return 'fr';
  if (language.startsWith('de')) return 'de';
  if (language.startsWith('ru')) return 'ru';
  return 'en';
};

export const getLocalizedField = (field: LocalizedField, lang: LanguageCode): string => {
  return field[lang] ?? field.en;
};
