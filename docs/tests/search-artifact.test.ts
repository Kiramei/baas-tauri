import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createSearchArtifact, sortSearchPages } from "../lib/search-artifact.server";
import { flexsearchI18n } from "fumadocs-core/search/flexsearch";
import { parseSearchPayload, SEARCH_INDEX_FORMAT, SearchIndexChangedError } from "../lib/search-contract";

const indexes = { type: "i18n" as const, raw: { en: {}, zh: {} } };

test("page enumeration order does not change the exported search artifact", async () => {
  const pages = [
    { url: "/docs/zh/reference/client-api", locale: "zh", title: "Native API" },
    { url: "/docs/en/guide/install", locale: "en", title: "Install" },
    { url: "/docs/en/reference/client-api", locale: "en", title: "Native API" },
    { url: "/docs/zh/guide/install", locale: "zh", title: "Install" },
  ].map(page => ({ ...page, id: page.url, structuredData: { headings: [], contents: [] } }));
  const original = [...pages];
  const build = async (input: typeof pages) => createSearchArtifact(await flexsearchI18n({
    i18n: { languages: ["en", "zh"], defaultLanguage: "en" },
    indexes: sortSearchPages(input),
  }).export());
  const first = await build(pages);
  expect(await build(pages.toReversed())).toEqual(first);
  expect(await build([pages[1], pages[3], pages[0], pages[2]])).toEqual(first);
  expect(pages).toEqual(original);
  expect(sortSearchPages(pages).map(page => page.url)).toEqual([
    "/docs/en/guide/install", "/docs/en/reference/client-api",
    "/docs/zh/guide/install", "/docs/zh/reference/client-api",
  ]);
});

test("the immutable index address binds its data and encoder format", () => {
  const first = createSearchArtifact(indexes);
  const second = createSearchArtifact(indexes);
  expect(first).toEqual(second);
  expect(first.revision).toBe(createHash("sha256").update(JSON.stringify({ format: SEARCH_INDEX_FORMAT, indexes })).digest("hex"));
  expect(first.filename).toBe(first.revision + ".json");
  const payload = JSON.parse(first.json);
  expect(parseSearchPayload(payload, first.revision)).toEqual(indexes);
  const changed = createSearchArtifact({ type: "i18n", raw: { en: { reg: "[]" }, zh: {} } });
  expect(changed.revision).not.toBe(first.revision);
  expect(changed.filename).not.toBe(first.filename);
  expect(SEARCH_INDEX_FORMAT).toContain("numeric");
  expect(SEARCH_INDEX_FORMAT).toContain("dedupe");
});

test.each([
  {},
  indexes,
  { revision: "0".repeat(64), format: SEARCH_INDEX_FORMAT, indexes },
  { revision: "1".repeat(64), format: "old-encoder", indexes },
])("an incompatible or stale envelope is rejected before importing chunks: %j", (payload) => {
  expect(() => parseSearchPayload(payload, "1".repeat(64))).toThrow(SearchIndexChangedError);
});

test("a matching envelope still validates its serialized index structure", () => {
  expect(() => parseSearchPayload({ revision: "1".repeat(64), format: SEARCH_INDEX_FORMAT,
    indexes: { type: "i18n", raw: { zh: null } } }, "1".repeat(64))).toThrow();
});
