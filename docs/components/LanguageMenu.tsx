"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Languages } from "lucide-react";
import { locales, switchLocalePath, type Locale } from "@/lib/i18n";
import { localePreferenceKey } from "@/lib/locale";

/** Renders the language menu component. */
export function LanguageMenu({ locale }: { locale: Locale }) {
  const pathname = usePathname();
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
              try {
                localStorage.setItem(localePreferenceKey, item.locale);
              } catch {
                // Navigation still works without saving a preference.
              }
              event.currentTarget.closest("details")?.removeAttribute("open");
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
