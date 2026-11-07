import { flexsearchFromSource } from "fumadocs-core/search/flexsearch";
import { source } from "./source";
import { chineseSearchEncoder } from "./search-encoding";
import { createSearchArtifact, sortSearchPages } from "./search-artifact.server";

const searchSource: typeof source = {
  ...source,
  getPages: (language) =>
    sortSearchPages(
      source.getPages(language).filter((page) =>
        !["/docs/guide/android", "/docs/guide/webui"].includes(page.url.replace(/\/$/, ""))
      )
    ),
};

let artifact: Promise<ReturnType<typeof createSearchArtifact>> | undefined;

export function getSearchArtifact() {
  return (artifact ??= flexsearchFromSource(searchSource, {
    localeMap: { zh: { encoder: chineseSearchEncoder } },
  }).export().then(createSearchArtifact));
}
