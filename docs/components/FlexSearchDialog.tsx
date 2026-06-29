"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { usePathname } from "next/navigation";
import Search from "flexsearch";
import type { Document as FlexSearchDocument } from "flexsearch";
import { createContentHighlighter } from "fumadocs-core/search";
import { useDocsSearch, type SearchClient } from "fumadocs-core/search/client";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
} from "fumadocs-ui/components/dialog/search";
import type { SearchLink, SharedProps } from "fumadocs-ui/contexts/search";

type FlexSearchDialogProps = SharedProps & {
  links?: SearchLink[];
  delayMs?: number;
  footer?: ReactNode;
};

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const searchIndexUrl = `${basePath}/search-index.json`;

type SearchDocument = {
  id: string;
  content: string;
  page_id: string;
  type: "page" | "heading" | "text";
  breadcrumbs?: string[];
  tags: string[];
  url: string;
};

type ExportedSearchData =
  | {
      type: "default";
      raw: Record<string, string>;
    }
  | {
      type: "i18n";
      raw: Record<string, Record<string, string>>;
    };

const searchCache = new Map<string, Promise<Map<string, FlexSearchDocument<SearchDocument>>>>();

function localeFromPathname(pathname: string | null) {
  const segments = pathname?.split("/").filter(Boolean) ?? [];
  const docsIndex = segments.indexOf("docs");
  const locale = docsIndex >= 0 ? segments[docsIndex + 1] : undefined;

  return locale === "en" ? "en" : "zh";
}

function createDocument(locale: string) {
  return new Search.Document<SearchDocument>({
    tokenize: "full",
    encoder: locale === "zh" ? Search.Charset.CJK : undefined,
    document: {
      id: "id",
      index: ["content"],
      tag: ["tags"],
      store: true,
    },
  });
}

function importDocument(raw: Record<string, string>, locale: string) {
  const document = createDocument(locale);

  for (const [key, value] of Object.entries(raw)) {
    document.import(key, value);
  }

  return document;
}

async function loadSearchIndexes(from: string) {
  const cached = searchCache.get(from);
  if (cached) return cached;

  const loaded = fetch(from).then(async (res) => {
    if (!res.ok) {
      throw new Error(`Failed to fetch exported search indexes from ${from}.`);
    }

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
  });

  searchCache.set(from, loaded);
  return loaded;
}

function createSearchClient(locale: string): SearchClient {
  return {
    deps: [searchIndexUrl, locale],
    async search(query) {
      const indexes = await loadSearchIndexes(searchIndexUrl);
      const index = indexes.get(locale) ?? indexes.get("");
      if (!index) return [];

      const results = await index.searchAsync(query, {
        index: "content",
        limit: 60,
      });

      if (results.length === 0) return [];

      const highlighter = createContentHighlighter(query);
      const grouped = new Map<string, SearchDocument[]>();

      for (const id of results[0].result) {
        const item = index.get(id) as SearchDocument | undefined;
        if (!item) continue;

        const group = grouped.get(item.page_id) ?? [];
        if (!grouped.has(item.page_id)) grouped.set(item.page_id, group);
        if (item.type !== "page") group.push(item);
      }

      return Array.from(grouped).flatMap(([pageId, items]) => {
        const page = index.get(pageId) as SearchDocument | undefined;
        if (!page) return [];

        return [
          {
            id: pageId,
            type: "page" as const,
            content: highlighter.highlightMarkdown(page.content),
            breadcrumbs: page.breadcrumbs,
            url: page.url,
          },
          ...items.map((item) => ({
            id: item.id,
            type: item.type,
            content: highlighter.highlightMarkdown(item.content),
            breadcrumbs: item.breadcrumbs,
            url: item.url,
          })),
        ];
      });
    },
  };
}

export function FlexSearchDialog({
  links = [],
  delayMs,
  footer,
  ...props
}: FlexSearchDialogProps) {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const { search, setSearch, query } = useDocsSearch({
    client: createSearchClient(locale),
    delayMs,
  });

  const defaultItems = useMemo(() => {
    if (links.length === 0) return null;

    return links.map(([name, link]) => ({
      type: "page" as const,
      id: name,
      content: name,
      url: link,
    }));
  }, [links]);

  return (
    <SearchDialog
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== "empty" ? query.data : defaultItems} />
      </SearchDialogContent>
      {footer ? <SearchDialogFooter>{footer}</SearchDialogFooter> : null}
    </SearchDialog>
  );
}
