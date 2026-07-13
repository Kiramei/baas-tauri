"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Languages } from "lucide-react";
import { locales, switchLocalePath, type Locale } from "@/lib/i18n";

/** Renders the language menu component. */
export function LanguageMenu({ locale }: { locale: Locale }) {
  const pathname = usePathname();
  const activeName = locales.find((item) => item.locale === locale)?.name ?? "中文";

  return (
    <details className="baas-language-menu baas-sidebar-language-menu">
      <summary aria-label="Choose language">
        <Languages aria-hidden="true" />
        <span>{activeName}</span>
      </summary>
      <div>
        {locales.map((item) => (
          <Link
            key={item.locale}
            href={switchLocalePath(pathname ?? `/docs/${locale}`, item.locale)}
            aria-current={item.locale === locale ? "page" : undefined}
          >
            {item.name}
          </Link>
        ))}
      </div>
    </details>
  );
}
