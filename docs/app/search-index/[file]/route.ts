import { getSearchArtifact } from "@/lib/build-search-index";

export const dynamic = "force-static";
export const dynamicParams = false;

export async function generateStaticParams() {
  return [{ file: (await getSearchArtifact()).filename }];
}

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const artifact = await getSearchArtifact();
  if ((await params).file !== artifact.filename) return new Response(null, { status: 404 });
  return new Response(artifact.json, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
