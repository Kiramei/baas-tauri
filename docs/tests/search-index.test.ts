import { afterEach, expect, test } from "bun:test";
import { loadSearchIndexes } from "../lib/search-index";

const originalFetch = globalThis.fetch;
let sequence = 0;
const url = () => `https://docs.invalid/search-${sequence++}.json`;
const emptyIndex = () => Response.json({ type: "i18n", raw: { en: {}, zh: {} } });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("concurrent and successful searches share their index download", async () => {
  let requests = 0;
  let resolve!: (response: Response) => void;
  globalThis.fetch = (() => {
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
      return Response.json({ type: "i18n", raw: { en: null } });
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
    if (from === ready) {
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
