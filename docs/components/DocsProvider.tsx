"use client";

import {
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import Link from "next/link";
import Image from "next/image";
import { useParams, usePathname, useRouter } from "next/navigation";
import { FrameworkProvider, type Framework } from "fumadocs-core/framework";
import { RootProvider } from "fumadocs-ui/provider/next";
import {
  detectLocale,
  explicitLocaleFromPathname,
  localePreferenceKey,
  type Locale,
} from "@/lib/locale";
import { chineseUiTranslations } from "@/lib/ui-translations";
import type { SharedProps } from "fumadocs-ui/contexts/search";
import type { SearchIndexReference } from "@/lib/search-contract";

const FlexSearchDialog = lazy(() =>
  import("@/components/FlexSearchDialog").then((module) => ({ default: module.FlexSearchDialog }))
);

type LocaleState = { locale: Locale; setLocale: (locale: Locale) => void };
const LocaleContext = createContext<LocaleState>({ locale: "zh", setLocale: () => {} });

export function useDocsLocale() {
  return useContext(LocaleContext);
}

function DocumentationNavigationLink({
  href = "",
  prefetch,
  ...props
}: ComponentProps<"a"> & { prefetch?: boolean }) {
  return <Link {...props} href={href} prefetch={prefetch ?? false} />;
}

function useDocumentationPathname() {
  return (usePathname() ?? "/").replace(/(\/docs)\/(?:zh|en)(?=\/|$)/, "$1");
}

export function DocsProvider({
  children,
  searchIndex,
}: {
  children: ReactNode;
  searchIndex: SearchIndexReference;
}) {
  const pathname = usePathname();
  const explicitLocale = explicitLocaleFromPathname(pathname);
  const [selectedLocale, setSelectedLocale] = useState<Locale>(explicitLocale ?? "zh");
  const initialized = useRef(false);
  const locale = explicitLocale ?? selectedLocale;
  const setLocale = useCallback((nextLocale: Locale) => {
    try {
      localStorage.setItem(localePreferenceKey, nextLocale);
    } catch {
      // The language still applies for this session when storage is unavailable.
    }
    setSelectedLocale(nextLocale);
  }, []);
  useEffect(() => {
    if (initialized.current && !explicitLocale) return;
    let preference: string | null = null;
    try {
      preference = localStorage.getItem(localePreferenceKey);
      if (explicitLocale) localStorage.setItem(localePreferenceKey, explicitLocale);
    } catch {
      // Browser language remains available without persistent storage.
    }
    setSelectedLocale(
      explicitLocale ?? detectLocale(preference, navigator.languages ?? [navigator.language])
    );
    initialized.current = true;
  }, [explicitLocale]);
  const SearchDialog = useMemo(
    () =>
      function DocumentationSearchDialog(props: SharedProps) {
        return <FlexSearchDialog {...props} searchIndex={searchIndex} />;
      },
    [searchIndex.url, searchIndex.revision]
  );
  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <RootProvider
        components={{ Link: DocumentationNavigationLink }}
        i18n={{ locale, translations: locale === "zh" ? chineseUiTranslations : undefined }}
        search={{ SearchDialog, preload: false }}
      >
        <FrameworkProvider
          usePathname={useDocumentationPathname}
          useRouter={useRouter}
          useParams={useParams}
          Link={DocumentationNavigationLink}
          Image={Image as Framework["Image"]}
        >
          {children}
        </FrameworkProvider>
      </RootProvider>
    </LocaleContext.Provider>
  );
}
