import { afterEach, expect, test } from "bun:test";
import Search from "flexsearch";
import { chineseSearchEncoder } from "../lib/search-encoding";
import { loadSearchIndexes, type SearchDocument } from "../lib/search-index";
import { createSearchArtifact } from "../lib/search-artifact.server";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("mixed Chinese content preserves identifiers and numeric terms after export/import", async () => {
  const server = new Search.Document<SearchDocument>({
    tokenize: "full",
    encoder: chineseSearchEncoder,
    document: { id: "id", index: ["content"], tag: ["tags"], store: true },
  });
  server.add({
    id: "mixed",
    page_id: "mixed",
    type: "text",
    tags: [],
    url: "/docs/zh/",
    content:
      "截图与脚本 android_local restart_deferred 400 216 86 Python3.9.20 abcdefghijklmnopqrstuvwxyz_0123456789",
  });
  server.add({
    id: "other",
    page_id: "other",
    type: "text",
    tags: [],
    url: "/docs/zh/other/",
    content: "页面主题和语言设置",
  });
  const raw: Record<string, string> = {};
  await server.export((key, value) => {
    raw[key] = value;
  });
  const artifact = createSearchArtifact({ type: "i18n", raw: { zh: raw } });
  globalThis.fetch = (async () => new Response(artifact.json)) as typeof fetch;
  const index = (await loadSearchIndexes({ url: "https://docs.invalid/" + artifact.filename, revision: artifact.revision })).get("zh")!;
  for (const query of [
    "截图",
    "脚本",
    "截图 android_local",
    "RESTART_DEFERRED",
    "deferred",
    "216",
    "3.9.20",
  ]) {
    const results = await index.searchAsync(query, { index: "content" });
    expect(results.flatMap((row) => row.result)).toContain("mixed");
  }
  for (const query of [
    "zz_unmatched_updater_search_49375",
    "zz_unmatched_49375",
    "zzzzzzzzzz",
    "49375",
    "不存在的查询",
  ]) {
    expect(
      (await index.searchAsync(query, { index: "content" })).flatMap((row) => row.result)
    ).toEqual([]);
  }
});

test("Chinese splitting retains CJK characters and intact technical tokens", () => {
  const encoder = new Search.Encoder(chineseSearchEncoder);
  expect(encoder.encode("截图 android_local 49375")).toEqual([
    "截",
    "图",
    "android_local",
    "49375",
  ]);
});
