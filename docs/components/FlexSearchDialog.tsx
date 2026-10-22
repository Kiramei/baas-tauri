"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { localeFromPathname } from "@/lib/locale";
import { loadSearchIndexes, type SearchDocument } from "@/lib/search-index";
import { SearchIndexChangedError, type SearchIndexReference } from "@/lib/search-contract";
import { RotateCw } from "lucide-react";
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
  searchIndex: SearchIndexReference;
  links?: SearchLink[];
  delayMs?: number;
  footer?: ReactNode;
};

function createSearchClient(locale: string, retry: number, searchIndex: SearchIndexReference): SearchClient {
  return {
    deps: [searchIndex.url, searchIndex.revision, locale, retry],
    async search(query) {
      const indexes = await loadSearchIndexes(searchIndex);
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

export function FlexSearchDialog({ searchIndex, links = [], delayMs, footer, ...props }: FlexSearchDialogProps) {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const [retry, setRetry] = useState(0);
  const { search, setSearch, query } = useDocsSearch({
    client: createSearchClient(locale, retry, searchIndex),
    delayMs,
  });
  const failed = Boolean(query.error) && search.length > 0;
  const changed = query.error instanceof SearchIndexChangedError;
  const retryLabel = changed
    ? (locale === "zh" ? "重新加载文档" : "Reload documentation")
    : (locale === "zh" ? "重新搜索" : "Retry search");
  const retrySearch = () => changed ? window.location.reload() : setRetry((value) => value + 1);

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
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                failed &&
                !query.isLoading
              ) {
                event.preventDefault();
                retrySearch();
              }
            }}
          />
          <SearchDialogClose />
        </SearchDialogHeader>
        {failed ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 p-4 text-sm text-fd-muted-foreground"
          >
            <span>
              {changed
                ? (locale === "zh" ? "此页的搜索索引已不可用。" : "The search index for this page is no longer available.")
                : (locale === "zh" ? "搜索暂时不可用。" : "Search is temporarily unavailable.")}
            </span>
            <button
              type="button"
              aria-label={retryLabel}
              title={retryLabel}
              disabled={query.isLoading}
              onClick={retrySearch}
              className="flex size-9 shrink-0 items-center justify-center rounded-md border hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-primary disabled:opacity-50"
            >
              <RotateCw
                aria-hidden="true"
                className={`size-4${query.isLoading ? " animate-spin" : ""}`}
              />
            </button>
          </div>
        ) : (
          <SearchDialogList items={query.data !== "empty" ? query.data : defaultItems} />
        )}
      </SearchDialogContent>
      {footer ? <SearchDialogFooter>{footer}</SearchDialogFooter> : null}
    </SearchDialog>
  );
}
