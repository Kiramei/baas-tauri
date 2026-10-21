import { afterEach, expect, test } from "bun:test";
import { loadSearchIndexes } from "../lib/search-index";
import { SEARCH_INDEX_FORMAT, SearchIndexChangedError } from "../lib/search-contract";

const originalFetch = globalThis.fetch;
let sequence = 0;
const revision = "1".repeat(64);
const url = () => ({ url: `https://docs.invalid/search-${sequence++}.json`, revision });
const payload = (indexes = { type: "i18n", raw: { en: {}, zh: {} } }) => ({ revision, format: SEARCH_INDEX_FORMAT, indexes });
const emptyIndex = () => Response.json(payload());

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("concurrent and successful searches share their index download", async () => {
  let requests = 0;
  let resolve!: (response: Response) => void;
  globalThis.fetch = ((_from, options) => {
    expect(options?.cache).toBe("no-store");
    requests++;
    return new Promise<Response>((done) => {
      resolve = done;
    });
  }) as typeof fetch;
  const from = url();
  const first = loadSearchIndexes(from);
  const second = loadSearchIndexes(from);
  expect(second).toBe(first);
  expect(requests).toBe(1);
  resolve(emptyIndex());
  const indexes = await first;
  expect([...indexes.keys()]).toEqual(["en", "zh"]);
  expect(await loadSearchIndexes(from)).toBe(indexes);
  expect(requests).toBe(1);
});

test.each(["http", "network", "json", "import"])(
  "a failed %s download can be retried",
  async (failure) => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      if (requests > 1) return emptyIndex();
      if (failure === "http") return new Response("Unavailable", { status: 503 });
      if (failure === "network") throw new TypeError("Failed to fetch");
      if (failure === "json")
        return new Response("{", { headers: { "Content-Type": "application/json" } });
      return Response.json({ ...payload(), indexes: { type: "i18n", raw: { en: null } } });
    }) as typeof fetch;
    const from = url();
    const first = loadSearchIndexes(from);
    const concurrent = loadSearchIndexes(from);
    expect(concurrent).toBe(first);
    await expect(first).rejects.toThrow();
    await expect(concurrent).rejects.toThrow();
    expect([...(await loadSearchIndexes(from)).keys()]).toEqual(["en", "zh"]);
    expect(requests).toBe(2);
  }
);

test("an unavailable endpoint does not evict a successful endpoint", async () => {
  const ready = url(),
    unavailable = url();
  let readyRequests = 0,
    unavailableRequests = 0;
  globalThis.fetch = (async (from) => {
    if (from === ready.url) {
      readyRequests++;
      return emptyIndex();
    }
    unavailableRequests++;
    return new Response("Unavailable", { status: 503 });
  }) as typeof fetch;
  const indexes = await loadSearchIndexes(ready);
  await expect(loadSearchIndexes(unavailable)).rejects.toThrow();
  expect(await loadSearchIndexes(ready)).toBe(indexes);
  await expect(loadSearchIndexes(unavailable)).rejects.toThrow();
  expect(readyRequests).toBe(1);
  expect(unavailableRequests).toBe(2);
});

test.each(["revision", "format", "missing"])("a stale %s is not imported or cached", async (failure) => {
  const reference = url();
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    if (requests > 1) return emptyIndex();
    if (failure === "missing") return new Response(null, { status: 404 });
    return Response.json({ ...payload(), [failure]: "0".repeat(64) });
  }) as typeof fetch;
  await expect(loadSearchIndexes(reference)).rejects.toThrow(SearchIndexChangedError);
  expect([...(await loadSearchIndexes(reference)).keys()]).toEqual(["en", "zh"]);
  expect(requests).toBe(2);
});

test("a different expected revision cannot reuse an already imported URL", async () => {
  const reference = url();
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return emptyIndex(); }) as typeof fetch;
  const ready = await loadSearchIndexes(reference);
  await expect(loadSearchIndexes({ ...reference, revision: "2".repeat(64) })).rejects.toThrow(SearchIndexChangedError);
  expect(await loadSearchIndexes(reference)).toBe(ready);
  expect(requests).toBe(2);
});
