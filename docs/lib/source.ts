import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";
import { i18n } from "@/lib/i18n";

export const source = loader({
  baseUrl: "/docs",
  i18n,
  url: (slugs, locale) => {
    const lang = locale === "en" ? "en" : "zh";
    const path = slugs.length > 0 ? `/${slugs.join("/")}` : "";
    return `/docs/${lang}${path}`;
  },
  source: docs.toFumadocsSource(),
});
