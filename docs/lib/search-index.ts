import Search from "flexsearch";
import type { Document as FlexSearchDocument } from "flexsearch";
import { chineseSearchEncoder } from "./search-encoding";
import { parseSearchPayload, SearchIndexChangedError, type SearchIndexReference } from "./search-contract";

export type SearchDocument = {
  id: string;
  content: string;
  page_id: string;
  type: "page" | "heading" | "text";
  breadcrumbs?: string[];
  tags: string[];
  url: string;
};

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

export function loadSearchIndexes(reference: SearchIndexReference) {
  const key = JSON.stringify([reference.url, reference.revision]);
  const cached = searchCache.get(key);
  if (cached) return cached;

  const loaded = fetch(reference.url, { cache: "no-store" })
    .then(async (res) => {
      if (res.status === 404) throw new SearchIndexChangedError();
      if (!res.ok) throw new Error(`Failed to fetch exported search indexes from ${reference.url}.`);
      const data = parseSearchPayload(await res.json(), reference.revision);
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
      if (searchCache.get(key) === loaded) searchCache.delete(key);
      throw error;
    });

  searchCache.set(key, loaded);
  return loaded;
}
