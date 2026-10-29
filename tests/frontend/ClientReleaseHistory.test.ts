import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CLIENT_RELEASE_HISTORY_MAX_BYTES,
  currentClientRelease,
  loadClientReleaseHistory,
  parseClientReleaseSnapshot,
  readClientReleaseCache,
  saveClientReleaseCache,
  supplementCurrentRelease,
  type ClientReleaseSnapshot,
} from "../../src/shared/ClientReleaseHistory";

function githubRelease(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    name: `Client ${tag}`,
    body: `## ${tag}\n\nPublished changes`,
    published_at: "2026-07-01T12:00:00Z",
    html_url: `https://github.com/Kiramei/baas-tauri/releases/tag/${tag}`,
    draft: false,
    prerelease: tag.includes("-"),
    assets: [{ name: "unused-binary", size: 123456789 }],
    ...extra,
  };
}

function cachedRelease(tag: string): ClientReleaseSnapshot {
  return {
    schema: 1,
    repository: "Kiramei/baas-tauri",
    complete: true,
    releases: [
      {
        tag,
        name: `Client ${tag}`,
        body: "Cached changes",
        publishedAt: "2026-07-01T12:00:00Z",
        url: `https://github.com/Kiramei/baas-tauri/releases/tag/${tag}`,
      },
    ],
  };
}

const bundledUrl = "/client-release-history.json";
const bundled = JSON.parse(
  readFileSync(new URL("../../public/client-release-history.json", import.meta.url), "utf8")
);

describe("client release-note sources", () => {
  test("new dotted releases and historical tags retain their original history links", async () => {
    const tags = ["0.0.9.post2", "0.0.9.rc1", "v0.0.8-rc"];
    const result = await loadClientReleaseHistory({
      bundledUrl,
      currentMarkdown: "## 0.0.9.post2\n\nCurrent post release\n\n## 0.0.9.rc1\n\nOlder notes",
      readCache: () => null,
      saveCache: () => {},
      fetcher: (async (url) => String(url) === bundledUrl
        ? Response.json(bundled)
        : Response.json(tags.map((tag) => githubRelease(tag)))) as typeof fetch,
    });
    expect(result.snapshot.releases.map(({ tag }) => tag)).toEqual(tags);
    expect(result.snapshot.releases.at(-1)?.url).toEndWith("/v0.0.8-rc");
    const current = currentClientRelease("## 0.0.9.post2\n\nCurrent\n\n## 0.0.9.rc1\n\nOlder");
    expect(current.releases[0].tag).toBe("0.0.9.post2");
    expect(current.releases[0].body).toBe("Current");
  });

  test("the bundled snapshot contains actual published early and prerelease notes", () => {
    const parsed = parseClientReleaseSnapshot(bundled);
    expect(parsed?.complete).toBe(true);
    expect(parsed?.releases.some(({ tag, body }) => tag === "v0.0.1" && body.length > 0)).toBe(
      true
    );
    expect(parsed?.releases.some(({ tag, body }) => tag === "v0.0.8-rc" && body.length > 0)).toBe(
      true
    );
    expect(
      parsed?.releases.some(({ tag }) => ["updater", "20201020", "uv-down"].includes(tag))
    ).toBe(false);
  });

  test("GitHub pagination includes prereleases and excludes drafts and utility releases", async () => {
    const firstPage = [
      ...Array.from({ length: 97 }, (_, index) => githubRelease(`v1.0.${100 - index}`)),
      githubRelease("updater"),
      githubRelease("uv-down"),
      githubRelease("v9.0.0", { draft: true }),
    ];
    const urls: string[] = [];
    const requests: RequestInit[] = [];
    let saved: ClientReleaseSnapshot | undefined;
    const result = await loadClientReleaseHistory({
      bundledUrl,
      currentMarkdown: "## v1.0.100\n\nCurrent working notes",
      readCache: () => null,
      saveCache: (value) => {
        saved = value;
      },
      fetcher: (async (url, init) => {
        urls.push(String(url));
        requests.push(init!);
        if (url === bundledUrl) return Response.json(bundled);
        return Response.json(
          String(url).endsWith("page=1") ? firstPage : [githubRelease("v0.0.8-rc")]
        );
      }) as typeof fetch,
    });
    expect(urls).toHaveLength(3);
    expect(urls[1]).toBe(
      "https://api.github.com/repos/Kiramei/baas-tauri/releases?per_page=100&page=1"
    );
    expect(urls[2]).toEndWith("page=2");
    expect(result.source).toBe("github");
    expect(result.snapshot.complete).toBe(true);
    expect(result.snapshot.releases).toHaveLength(98);
    expect(result.snapshot.releases.at(-1)?.tag).toBe("v0.0.8-rc");
    expect(result.snapshot.releases[0].body).toContain("Published changes");
    expect(JSON.stringify(saved)).not.toContain("assets");
    expect(JSON.stringify(saved)).not.toContain("unused-binary");
    expect(Object.keys(saved!.releases[0]).sort()).toEqual([
      "body",
      "name",
      "publishedAt",
      "tag",
      "url",
    ]);
    expect(requests.every((request) => request.credentials === "omit")).toBe(true);
    expect(requests.every((request) => !new Headers(request.headers).has("Authorization"))).toBe(
      true
    );
  });

  test("a rate-limited or offline API keeps the complete bundled history available", async () => {
    const sources: string[] = [];
    const result = await loadClientReleaseHistory({
      bundledUrl,
      currentMarkdown: "## v0.0.8-rc\n\nCurrent working notes",
      readCache: () => cachedRelease("v0.0.8-rc"),
      onAvailable: (value) => sources.push(value.source),
      fetcher: (async (url) =>
        url === bundledUrl
          ? Response.json(bundled)
          : new Response("Rate limited", { status: 403 })) as typeof fetch,
    });
    expect(sources).toEqual(["cache", "bundled"]);
    expect(result.source).toBe("bundled");
    expect(result.unavailable).toBe(true);
    expect(result.snapshot.complete).toBe(true);
    expect(result.snapshot.releases).toHaveLength(bundled.releases.length);
  });

  test("an older client without a bundled snapshot uses its durable cache", async () => {
    const result = await loadClientReleaseHistory({
      bundledUrl,
      currentMarkdown: "## v0.0.8-rc\n\nCurrent working notes",
      readCache: () => cachedRelease("v0.0.8-rc"),
      fetcher: (async () => {
        throw new TypeError("Offline");
      }) as typeof fetch,
    });
    expect(result.source).toBe("cache");
    expect(result.unavailable).toBe(true);
    expect(result.snapshot.releases).toHaveLength(1);
    expect(result.snapshot.releases[0].body).toBe("Cached changes");
  });

  test.each([
    ["2026-07-01T12:00:00Z", "2026-08-01T12:00:00Z", "bundled", "Revised bundled notes"],
    ["2026-09-01T12:00:00Z", "2026-08-01T12:00:00Z", "cache", "Cached changes"],
    [undefined, "2026-08-01T12:00:00Z", "bundled", "Revised bundled notes"],
  ] as const)(
    "same-count histories prefer newer notes: cache=%s bundle=%s",
    async (fetchedAt, generatedAt, source, body) => {
      const cached = { ...cachedRelease("v0.0.8-rc"), fetchedAt };
      const local = {
        ...cachedRelease("v0.0.8-rc"),
        generatedAt,
        releases: [{ ...cached.releases[0], body: "Revised bundled notes" }],
      };
      const result = await loadClientReleaseHistory({
        bundledUrl,
        currentMarkdown: "## v0.0.8-rc\n\nCurrent working notes",
        readCache: () => cached,
        fetcher: (async (url) =>
          url === bundledUrl
            ? Response.json(local)
            : new Response("Offline", { status: 503 })) as typeof fetch,
      });
      expect(result.source).toBe(source);
      expect(result.snapshot.releases).toHaveLength(1);
      expect(result.snapshot.releases[0].body).toBe(body);
      expect(result.snapshot.fetchedAt).toBe(source === "bundled" ? generatedAt : fetchedAt);
    }
  );

  test("only the current UPDATE.md version supplements missing published versions", () => {
    const current = currentClientRelease(
      "## v1.0.0-rc\n\nCurrent changes\n\n## v0.9.0\nOld file notes"
    );
    expect(current.releases).toHaveLength(1);
    expect(current.releases[0].body).toBe("Current changes");
    expect(current.complete).toBe(false);
    const older = cachedRelease("v0.0.8-rc");
    const merged = supplementCurrentRelease(older, current);
    expect(merged.releases.map(({ tag }) => tag)).toEqual(["v1.0.0-rc", "v0.0.8-rc"]);
    expect(supplementCurrentRelease(merged, current)).toBe(merged);
  });

  test("total failure clearly returns a partial current-version fallback", async () => {
    const result = await loadClientReleaseHistory({
      bundledUrl,
      currentMarkdown: "## v0.0.8-rc\n\nCurrent notes",
      readCache: () => null,
      fetcher: (async () => new Response("Missing", { status: 404 })) as typeof fetch,
    });
    expect(result.source).toBe("current");
    expect(result.snapshot.complete).toBe(false);
    expect(result.unavailable).toBe(true);
    expect(result.snapshot.releases[0].body).toBe("Current notes");
  });

  test("large repositories stop after five API pages and disclose partial results", async () => {
    let pages = 0;
    const result = await loadClientReleaseHistory({
      bundledUrl,
      currentMarkdown: "## v1.0.0\n\nCurrent notes",
      readCache: () => null,
      saveCache: () => {},
      fetcher: (async (url) => {
        if (url === bundledUrl) return new Response("Missing", { status: 404 });
        const page = pages++;
        return Response.json(
          Array.from({ length: 100 }, (_, index) => githubRelease(`v1.0.${page * 100 + index}`))
        );
      }) as typeof fetch,
    });
    expect(pages).toBe(5);
    expect(result.source).toBe("github");
    expect(result.snapshot.complete).toBe(false);
    expect(result.snapshot.releases).toHaveLength(500);
  });

  test("note storage stays within two MiB without retaining binary asset metadata", async () => {
    let saved = "";
    const result = await loadClientReleaseHistory({
      bundledUrl,
      currentMarkdown: "## v1.0.0\n\nCurrent notes",
      readCache: () => null,
      saveCache: (value) =>
        saveClientReleaseCache(value, (text) => {
          saved = text;
        }),
      fetcher: (async (url) =>
        url === bundledUrl
          ? new Response("Missing", { status: 404 })
          : Response.json(
              Array.from({ length: 100 }, (_, index) =>
                githubRelease(`v1.0.${index}`, { body: "x".repeat(22_000) })
              )
            )) as typeof fetch,
    });
    expect(result.source).toBe("github");
    expect(result.snapshot.complete).toBe(false);
    expect(result.snapshot.releases.length).toBeLessThan(100);
    expect(saved.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(saved).byteLength).toBeLessThanOrEqual(
      CLIENT_RELEASE_HISTORY_MAX_BYTES
    );
    expect(saved).not.toContain("assets");
  });

  test("closing the dialog aborts loading instead of publishing stale fallback state", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadClientReleaseHistory({
        bundledUrl,
        currentMarkdown: "## v1.0.0\n\nCurrent notes",
        signal: controller.signal,
        readCache: () => null,
        fetcher: (async (_url, options) => {
          if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
          return Response.json([]);
        }) as typeof fetch,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("release-note cache validation", () => {
  test("bad schemas, foreign repositories, oversized notes and corrupt storage are ignored", () => {
    const value = cachedRelease("v0.0.8-rc");
    expect(parseClientReleaseSnapshot({ ...value, schema: 2 })).toBeNull();
    expect(parseClientReleaseSnapshot({ ...value, repository: "unrelated/repository" })).toBeNull();
    expect(
      parseClientReleaseSnapshot({
        ...value,
        releases: [{ ...value.releases[0], body: "x".repeat(CLIENT_RELEASE_HISTORY_MAX_BYTES) }],
      })
    ).toBeNull();
    expect(readClientReleaseCache(() => "{broken")).toBeNull();
    expect(
      readClientReleaseCache(() => {
        throw new DOMException("Denied", "SecurityError");
      })
    ).toBeNull();
    expect(readClientReleaseCache(() => JSON.stringify(value))).toEqual(value);
  });

  test("quota failures do not discard usable notes or leak extra cached fields", () => {
    const value = cachedRelease("v0.0.8-rc");
    expect(() =>
      saveClientReleaseCache(value, () => {
        throw new DOMException("Full", "QuotaExceededError");
      })
    ).not.toThrow();
    const polluted = {
      ...value,
      assets: ["unnecessary"],
      releases: [{ ...value.releases[0], token: "unexpected" }],
    };
    const parsed = parseClientReleaseSnapshot(polluted);
    expect(JSON.stringify(parsed)).not.toContain("unnecessary");
    expect(JSON.stringify(parsed)).not.toContain("unexpected");
  });
});
