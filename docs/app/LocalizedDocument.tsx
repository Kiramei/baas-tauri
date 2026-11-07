import { notFound } from "next/navigation";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { DocumentLanguage } from "@/components/DocumentLanguage";
import { LanguageMenu } from "@/components/LanguageMenu";
import { LocalizedDocs } from "@/components/LocalizedDocs";
import { SidebarFolder } from "@/components/SidebarFolder";
import type { Locale } from "@/lib/locale";
import { source } from "@/lib/source";
import { mdxComponents } from "@/mdx-components";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

function Document({ locale, slug }: { locale: Locale; slug: string[] }) {
  const page = source.getPage(slug, locale);
  if (!page) notFound();
  const MDX = page.data.body;

  return (
    <DocsLayout
      tree={source.getPageTree(locale)}
      githubUrl="https://github.com/Kiramei/baas-tauri"
      nav={{
        title: (
          <span className="baas-doc-nav-brand">
            <img src={`${basePath}/baas-icon.webp`} alt="" />
            <span>{locale === "zh" ? "BAAS 文档" : "BAAS Docs"}</span>
          </span>
        ),
      }}
      sidebar={{
        defaultOpenLevel: 0,
        components: { Folder: SidebarFolder },
        footer: <LanguageMenu key="baas-sidebar-language-menu" locale={locale} />,
      }}
    >
      <DocumentLanguage locale={locale} />
      <DocsPage toc={page.data.toc}>
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
        <DocsBody>
          <MDX components={mdxComponents} />
        </DocsBody>
      </DocsPage>
    </DocsLayout>
  );
}

export function LocalizedDocument({ slug = [], locale }: { slug?: string[]; locale?: Locale }) {
  if (locale) return <Document locale={locale} slug={slug} />;
  return (
    <LocalizedDocs
      zh={<Document locale="zh" slug={slug} />}
      en={<Document locale="en" slug={slug} />}
    />
  );
}
