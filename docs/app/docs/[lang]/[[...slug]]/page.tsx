import type { Metadata } from "next";
import { LocalizedDocument } from "@/app/LocalizedDocument";
import { isLocale } from "@/lib/locale";
import { source } from "@/lib/source";

type PageProps = {
  params: Promise<{
    lang: string;
    slug?: string[];
  }>;
};

function resolveRoute({ lang, slug = [] }: { lang: string; slug?: string[] }) {
  return isLocale(lang) ? { locale: lang, slug } : { locale: undefined, slug: [lang, ...slug] };
}

export async function generateStaticParams() {
  const localized = source.generateParams("slug", "lang");
  const paths = new Map<string, { lang: string; slug: string[] }>();
  for (const page of localized) {
    paths.set(`${page.lang}/${page.slug.join("/")}`, page);
    const [first, ...rest] = page.slug;
    if (first) paths.set(`/${page.slug.join("/")}`, { lang: first, slug: rest });
  }
  return [...paths.values()];
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, slug } = resolveRoute(await params);
  const page = source.getPage(slug, locale ?? "zh");
  return page ? { title: page.data.title, description: page.data.description } : {};
}

export default async function Page({ params }: PageProps) {
  const { locale, slug } = resolveRoute(await params);
  return <LocalizedDocument locale={locale} slug={slug} />;
}
