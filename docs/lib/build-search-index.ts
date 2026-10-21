import { flexsearchFromSource } from "fumadocs-core/search/flexsearch";
import { source } from "./source";
import { chineseSearchEncoder } from "./search-encoding";
import { createSearchArtifact } from "./search-artifact.server";

let artifact: Promise<ReturnType<typeof createSearchArtifact>> | undefined;

export function getSearchArtifact() {
  return (artifact ??= flexsearchFromSource(source, {
    localeMap: { zh: { encoder: chineseSearchEncoder } },
  }).export().then(createSearchArtifact));
}
