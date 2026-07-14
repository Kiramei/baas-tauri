import { flexsearchFromSource } from "fumadocs-core/search/flexsearch";
import { source } from "@/lib/source";

export const dynamic = "force-static";

const search = flexsearchFromSource(source, {
  localeMap: {
    zh: "cjk",
  },
});

export async function GET() {
  return Response.json(await search.export());
}
