import { createHash } from "node:crypto";
import { SEARCH_INDEX_FORMAT, searchIndexesSchema } from "./search-contract";

export function createSearchArtifact(indexes: unknown) {
  const content = { format: SEARCH_INDEX_FORMAT, indexes: searchIndexesSchema.parse(indexes) };
  const revision = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return { revision, filename: revision + ".json", json: JSON.stringify({ revision, ...content }) };
}
