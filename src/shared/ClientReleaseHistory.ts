import { parseReleaseVersion } from "./ReleaseVersion.mjs";

export interface ClientRelease {
  tag: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
}

export interface ClientReleaseSnapshot {
  schema: 1;
  repository: "Kiramei/baas-tauri";
  releases: ClientRelease[];
  complete: boolean;
  fetchedAt?: string;
}

export interface ClientReleaseResult {
  snapshot: ClientReleaseSnapshot;
  source: "github" | "cache" | "bundled" | "current";
  unavailable?: boolean;
}

const repository = "Kiramei/baas-tauri";
const cacheKey = "baas.clientReleaseHistory.v1";
const isVersionTag = (value: string) => parseReleaseVersion(value, { allowLegacy: true }) !== null;
const maxPages = 5;
const pageSize = 100;
export const CLIENT_RELEASE_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshot(releases: ClientRelease[], complete: boolean): ClientReleaseSnapshot {
  return { schema: 1, repository, releases, complete };
}

function validRelease(value: unknown): value is ClientRelease {
  if (!record(value)) return false;
  return (
    typeof value.tag === "string" &&
    isVersionTag(value.tag) &&
    value.tag.length <= 128 &&
    typeof value.name === "string" &&
    value.name.length <= 512 &&
    typeof value.body === "string" &&
    encoder.encode(value.body).byteLength <= CLIENT_RELEASE_HISTORY_MAX_BYTES &&
    typeof value.publishedAt === "string" &&
    (value.publishedAt === "" || Number.isFinite(Date.parse(value.publishedAt))) &&
    typeof value.url === "string" &&
    value.url.startsWith("https://github.com/Kiramei/baas-tauri/releases/tag/")
  );
}

/** Only retain release-note metadata; assets, tokens and arbitrary fields never enter the cache. */
export function parseClientReleaseSnapshot(value: unknown): ClientReleaseSnapshot | null {
  if (
    !record(value) ||
    value.schema !== 1 ||
    value.repository !== repository ||
    !Array.isArray(value.releases) ||
    value.releases.length > maxPages * pageSize ||
    !value.releases.every(validRelease)
  )
    return null;
  const tags = new Set<string>();
  const releases = value.releases
    .filter((release) => {
      if (tags.has(release.tag)) return false;
      tags.add(release.tag);
      return true;
    })
    .map(({ tag, name, body, publishedAt, url }) => ({ tag, name, body, publishedAt, url }));
  const result = snapshot(releases, value.complete === true);
  const fetchedAt = [value.fetchedAt, value.generatedAt].find(
    (timestamp) => typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))
  );
  if (typeof fetchedAt === "string") result.fetchedAt = fetchedAt;
  return byteLength(result) <= CLIENT_RELEASE_HISTORY_MAX_BYTES ? result : null;
}

export function readClientReleaseCache(
  read: () => string | null = () => localStorage.getItem(cacheKey)
): ClientReleaseSnapshot | null {
  try {
    const saved = read();
    if (!saved || encoder.encode(saved).byteLength > CLIENT_RELEASE_HISTORY_MAX_BYTES) return null;
    return parseClientReleaseSnapshot(JSON.parse(saved));
  } catch {
    return null;
  }
}

export function saveClientReleaseCache(
  value: ClientReleaseSnapshot,
  write: (serialized: string) => void = (serialized) => localStorage.setItem(cacheKey, serialized)
): void {
  const parsed = parseClientReleaseSnapshot(value);
  if (!parsed) return;
  try {
    write(JSON.stringify(parsed));
  } catch {
    // Release notes remain usable when storage is unavailable or full.
  }
}

/** UPDATE.md supplements the current version only; it is not the entire release history. */
export function currentClientRelease(markdown: string): ClientReleaseSnapshot {
  const heading = [...markdown.matchAll(/^## (\S+)\s*$/gm)].find((match) => isVersionTag(match[1]));
  if (!heading) return snapshot([], false);
  const remainder = markdown.slice(heading.index + heading[0].length).trim();
  const nextVersion = [...remainder.matchAll(/^## (\S+)\s*$/gm)].find((match) => isVersionTag(match[1]));
  return snapshot(
    [
      {
        tag: heading[1],
        name: heading[1],
        body: (nextVersion ? remainder.slice(0, nextVersion.index) : remainder).trim(),
        publishedAt: "",
        url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(heading[1])}`,
      },
    ],
    false
  );
}

export function supplementCurrentRelease(
  history: ClientReleaseSnapshot,
  current: ClientReleaseSnapshot
): ClientReleaseSnapshot {
  const missing = current.releases.filter(
    (release) => !history.releases.some(({ tag }) => tag === release.tag)
  );
  return missing.length ? { ...history, releases: [...missing, ...history.releases] } : history;
}

async function fetchJson(
  url: string,
  fetcher: typeof fetch,
  signal?: AbortSignal
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Release notes unavailable");
    if (!response.body) throw new Error("Release notes response is empty");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > CLIENT_RELEASE_HISTORY_MAX_BYTES * 2)
          throw new Error("Release notes response is too large");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export interface ClientReleaseLoadOptions {
  currentMarkdown: string;
  bundledUrl: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  readCache?: () => ClientReleaseSnapshot | null;
  saveCache?: (value: ClientReleaseSnapshot) => void;
  onAvailable?: (value: ClientReleaseResult) => void;
}

/** Public GitHub notes share one bounded, credential-free path across all platforms. */
export async function loadClientReleaseHistory(
  options: ClientReleaseLoadOptions
): Promise<ClientReleaseResult> {
  const fetcher = options.fetcher ?? fetch;
  const current = currentClientRelease(options.currentMarkdown);
  const cached = (options.readCache ?? readClientReleaseCache)();
  let fallback: ClientReleaseResult = cached
    ? { snapshot: cached, source: "cache" }
    : { snapshot: current, source: "current" };
  const present = (value: ClientReleaseResult): ClientReleaseResult => ({
    ...value,
    snapshot: supplementCurrentRelease(value.snapshot, current),
  });
  options.onAvailable?.(present(fallback));

  try {
    const bundled = parseClientReleaseSnapshot(
      await fetchJson(options.bundledUrl, fetcher, options.signal)
    );
    if (
      bundled &&
      (!cached ||
        bundled.releases.length > cached.releases.length ||
        (bundled.complete && !cached.complete) ||
        (bundled.releases.length === cached.releases.length &&
          (Date.parse(bundled.fetchedAt ?? "") || 0) > (Date.parse(cached.fetchedAt ?? "") || 0)))
    ) {
      fallback = { snapshot: bundled, source: "bundled" };
      options.onAvailable?.(present(fallback));
    }
  } catch {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    // Older clients may not contain a release snapshot yet.
  }

  try {
    const releases: ClientRelease[] = [];
    const tags = new Set<string>();
    let complete = false;
    let capped = false;
    // Reserve room for the fetchedAt timestamp, then count each note only once.
    let bytes = byteLength(snapshot([], false)) + 128;
    for (let page = 1; page <= maxPages && !capped; page++) {
      const values = await fetchJson(
        `https://api.github.com/repos/${repository}/releases?per_page=${pageSize}&page=${page}`,
        fetcher,
        options.signal
      );
      if (!Array.isArray(values) || values.length > pageSize)
        throw new Error("Invalid release notes response");
      for (const value of values) {
        if (!record(value) || value.draft === true || typeof value.tag_name !== "string") continue;
        if (!isVersionTag(value.tag_name) || tags.has(value.tag_name)) continue;
        const release = {
          tag: value.tag_name,
          name: typeof value.name === "string" && value.name ? value.name : value.tag_name,
          body: typeof value.body === "string" ? value.body : "",
          publishedAt: typeof value.published_at === "string" ? value.published_at : "",
          url: value.html_url,
        };
        if (!validRelease(release)) throw new Error("Invalid client release metadata");
        const releaseBytes = byteLength(release) + 1;
        if (bytes + releaseBytes > CLIENT_RELEASE_HISTORY_MAX_BYTES) {
          capped = true;
          break;
        }
        bytes += releaseBytes;
        releases.push(release);
        tags.add(release.tag);
      }
      if (values.length < pageSize && !capped) {
        complete = true;
        break;
      }
    }
    if (!releases.length) throw new Error("No client releases returned");
    const result = snapshot(releases, complete);
    result.fetchedAt = new Date().toISOString();
    try {
      (options.saveCache ?? saveClientReleaseCache)(result);
    } catch {
      // A cache write failure must not discard successfully fetched release notes.
    }
    return present({ snapshot: result, source: "github" });
  } catch {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return present({ ...fallback, unavailable: true });
  }
}
