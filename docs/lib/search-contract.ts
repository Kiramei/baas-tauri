import { z } from "zod";
import { chineseSearchEncoder } from "./search-encoding";

export const SEARCH_INDEX_FORMAT = JSON.stringify({
  version: 1,
  engine: "flexsearch/0.8",
  tokenize: "full",
  chineseEncoder: {
    split: String(chineseSearchEncoder.split),
    numeric: chineseSearchEncoder.numeric,
    dedupe: chineseSearchEncoder.dedupe,
  },
});

const raw = z.record(z.string(), z.string());
export const searchIndexesSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("default"), raw }),
  z.object({ type: z.literal("i18n"), raw: z.record(z.string(), raw) }),
]);
const envelopeSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), format: z.string(), indexes: z.unknown() });

export type ExportedSearchData = z.infer<typeof searchIndexesSchema>;
export type SearchIndexReference = { url: string; revision: string };

export class SearchIndexChangedError extends Error {
  constructor() {
    super("The search index no longer matches this documentation page.");
    this.name = "SearchIndexChangedError";
  }
}

export function parseSearchPayload(value: unknown, revision: string): ExportedSearchData {
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success || envelope.data.revision !== revision || envelope.data.format !== SEARCH_INDEX_FORMAT)
    throw new SearchIndexChangedError();
  return searchIndexesSchema.parse(envelope.data.indexes);
}
