import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
import { normalizeLocale, type Locale } from "@/lib/i18n";
import { LanguageMenu } from "@/components/LanguageMenu";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{
    lang: string;
  }>;
};

export default async function Layout({ children, params }: LayoutProps) {
  const { lang } = await params;
  const locale = normalizeLocale(lang);

  return (
    <DocsLayout
      tree={source.getPageTree(locale)}
      nav={{
        title: (
          <span className="baas-doc-nav-brand">
            <img src="/baas-icon.png" alt="" />
            <span>{locale === "zh" ? "BAAS 文档" : "BAAS Docs"}</span>
          </span>
        ),
      }}
      sidebar={{
        defaultOpenLevel: 1,
        footer: <LanguageMenu locale={locale as Locale} />,
      }}
    >
      {children}
    </DocsLayout>
  );
}
