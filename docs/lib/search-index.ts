import Search from "flexsearch";
import type { Document as FlexSearchDocument } from "flexsearch";
import { chineseSearchEncoder } from "./search-encoding";

export type SearchDocument = {
  id: string;
  content: string;
  page_id: string;
  type: "page" | "heading" | "text";
  breadcrumbs?: string[];
  tags: string[];
  url: string;
};

type ExportedSearchData =
  | { type: "default"; raw: Record<string, string> }
  | { type: "i18n"; raw: Record<string, Record<string, string>> };

const searchCache = new Map<string, Promise<Map<string, FlexSearchDocument<SearchDocument>>>>();

function importDocument(raw: Record<string, string>, locale: string) {
  const document = new Search.Document<SearchDocument>({
    tokenize: "full",
    encoder: locale === "zh" ? chineseSearchEncoder : undefined,
    document: { id: "id", index: ["content"], tag: ["tags"], store: true },
  });
  for (const [key, value] of Object.entries(raw)) document.import(key, value);
  return document;
}

export function loadSearchIndexes(from: string) {
  const cached = searchCache.get(from);
  if (cached) return cached;

  const loaded = fetch(from)
    .then(async (res) => {
      if (!res.ok) throw new Error(`Failed to fetch exported search indexes from ${from}.`);
      const data = (await res.json()) as ExportedSearchData;
      const indexes = new Map<string, FlexSearchDocument<SearchDocument>>();
      if (data.type === "i18n") {
        for (const [locale, raw] of Object.entries(data.raw)) {
          indexes.set(locale, importDocument(raw, locale));
        }
      } else {
        indexes.set("", importDocument(data.raw, ""));
      }
      return indexes;
    })
    .catch((error: unknown) => {
      if (searchCache.get(from) === loaded) searchCache.delete(from);
      throw error;
    });

  searchCache.set(from, loaded);
  return loaded;
}
