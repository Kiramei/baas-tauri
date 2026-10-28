import { createHash } from "node:crypto";
import { SEARCH_INDEX_FORMAT, searchIndexesSchema } from "./search-contract";

export function sortSearchPages<T extends { url: string }>(pages: readonly T[]): T[] {
  return pages.toSorted((left, right) => left.url < right.url ? -1 : left.url > right.url ? 1 : 0);
}

export function createSearchArtifact(indexes: unknown) {
  const content = { format: SEARCH_INDEX_FORMAT, indexes: searchIndexesSchema.parse(indexes) };
  const revision = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return { revision, filename: revision + ".json", json: JSON.stringify({ revision, ...content }) };
}
