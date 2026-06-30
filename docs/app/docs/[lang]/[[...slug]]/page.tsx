import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { source } from "@/lib/source";
import { normalizeLocale } from "@/lib/i18n";
import { mdxComponents } from "@/mdx-components";

type PageProps = {
  params: Promise<{
    lang: string;
    slug?: string[];
  }>;
};

/** Handles the generate static params workflow. */
export async function generateStaticParams() {
  return source.generateParams("slug", "lang");
}

/** Handles the generate metadata workflow. */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { lang, slug } = await params;
  const locale = normalizeLocale(lang);
  const page = source.getPage(slug, locale);

  if (!page) return {};

  return {
    title: page.data.title,
    description: page.data.description,
  };
}

/** Renders the page component. */
export default async function Page({ params }: PageProps) {
  const { lang, slug } = await params;
  const locale = normalizeLocale(lang);
  const page = source.getPage(slug, locale);

  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={mdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}
