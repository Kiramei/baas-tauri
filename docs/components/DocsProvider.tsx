"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { RootProvider } from "fumadocs-ui/provider/next";
import { FlexSearchDialog } from "@/components/FlexSearchDialog";
import { localeFromPathname } from "@/lib/locale";
import { chineseUiTranslations } from "@/lib/ui-translations";

export function DocsProvider({ children }: { children: ReactNode }) {
  const locale = localeFromPathname(usePathname());
  return (
    <RootProvider
      i18n={{ locale, translations: locale === "zh" ? chineseUiTranslations : undefined }}
      search={{ SearchDialog: FlexSearchDialog }}
    >
      {children}
    </RootProvider>
  );
}
