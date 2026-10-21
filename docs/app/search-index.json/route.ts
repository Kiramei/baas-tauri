import { flexsearchFromSource } from "fumadocs-core/search/flexsearch";
import { source } from "@/lib/source";
import { chineseSearchEncoder } from "@/lib/search-encoding";

export const dynamic = "force-static";

const search = flexsearchFromSource(source, {
  localeMap: {
    zh: { encoder: chineseSearchEncoder },
  },
});

export async function GET() {
  return Response.json(await search.export());
}
