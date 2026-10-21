"use client";

import { useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { RootProvider } from "fumadocs-ui/provider/next";
import { FlexSearchDialog } from "@/components/FlexSearchDialog";
import { localeFromPathname } from "@/lib/locale";
import { chineseUiTranslations } from "@/lib/ui-translations";
import type { SharedProps } from "fumadocs-ui/contexts/search";
import type { SearchIndexReference } from "@/lib/search-contract";

export function DocsProvider({ children, searchIndex }: { children: ReactNode; searchIndex: SearchIndexReference }) {
  const locale = localeFromPathname(usePathname());
  const SearchDialog = useMemo(() => function DocumentationSearchDialog(props: SharedProps) {
    return <FlexSearchDialog {...props} searchIndex={searchIndex} />;
  }, [searchIndex.url, searchIndex.revision]);
  return (
    <RootProvider
      i18n={{ locale, translations: locale === "zh" ? chineseUiTranslations : undefined }}
      search={{ SearchDialog }}
    >
      {children}
    </RootProvider>
  );
}
