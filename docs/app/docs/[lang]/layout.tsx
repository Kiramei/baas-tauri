import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
import { normalizeLocale, type Locale } from "@/lib/i18n";
import { LanguageMenu } from "@/components/LanguageMenu";
import { withDocsBasePath } from "@/lib/base-path";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{
    lang: string;
  }>;
};

/** Renders the layout component. */
export default async function Layout({ children, params }: LayoutProps) {
  const { lang } = await params;
  const locale = normalizeLocale(lang);

  return (
    <DocsLayout
      tree={source.getPageTree(locale)}
      nav={{
        title: (
          <span className="baas-doc-nav-brand">
            <img src={withDocsBasePath("/baas-icon.png")} alt="" />
            <span>{locale === "zh" ? "BAAS 文档" : "BAAS Docs"}</span>
          </span>
        ),
      }}
      sidebar={{
        defaultOpenLevel: 1,
        footer: <LanguageMenu key="baas-sidebar-language-menu" locale={locale as Locale} />,
      }}
    >
      {children}
    </DocsLayout>
  );
}
