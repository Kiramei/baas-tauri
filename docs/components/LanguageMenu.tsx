"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { locales, switchLocalePath, type Locale } from "@/lib/i18n";
import { useDocsLocale } from "@/components/DocsProvider";

/** Renders the language menu component. */
export function LanguageMenu({ locale }: { locale: Locale }) {
  const pathname = usePathname();
  const router = useRouter();
  const { setLocale } = useDocsLocale();
  const activeName = locales.find((item) => item.locale === locale)?.name ?? "English";

  return (
    <details className="baas-language-menu baas-sidebar-language-menu">
      <summary aria-label={locale === "zh" ? "选择语言" : "Choose language"}>
        <Languages aria-hidden="true" />
        <span>{activeName}</span>
      </summary>
      <div>
        {locales.map((item) => (
          <Link
            key={item.locale}
            href={switchLocalePath(pathname ?? `/docs/${locale}`, item.locale)}
            onClick={(event) => {
              setLocale(item.locale);
              event.currentTarget.closest("details")?.removeAttribute("open");
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              const target = switchLocalePath(pathname ?? "/docs/", item.locale);
              if (target !== pathname)
                router.push(target + window.location.search + window.location.hash);
            }}
            aria-current={item.locale === locale ? "page" : undefined}
          >
            {item.name}
          </Link>
        ))}
      </div>
    </details>
  );
}
