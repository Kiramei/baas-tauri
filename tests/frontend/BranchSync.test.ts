import { describe, expect, test } from "bun:test";
import { createGitHubClient, syncDev, validateSyncEvent } from "../../scripts/ci/sync-dev.mjs";

const main = "1".repeat(40);
const dev = "2".repeat(40);
const previousMain = "3".repeat(40);
const tree = "4".repeat(40);
const other = "5".repeat(40);
const ref = (branch: string, sha: string) => ({ ref: `refs/heads/${branch}`, object: { type: "commit", sha } });
const commit = (sha: string, parents: string[], treeSha = tree) => ({ sha, tree: { sha: treeSha }, parents: parents.map(sha => ({ sha })) });
type Reply = { body?: unknown; status?: number; error?: Error; invalidJson?: boolean };

function fixture(overrides: Record<string, Reply[]> = {}) {
  const requests: { method: string; path: string; body?: any }[] = [];
  const counts = new Map<string, number>();
  const defaults: Record<string, unknown> = {
    "GET /git/ref/heads/main": ref("main", main),
    "GET /git/ref/heads/dev": ref("dev", dev),
    [`GET /git/commits/${main}`]: commit(main, [previousMain, dev]),
    [`GET /git/commits/${dev}`]: commit(dev, [previousMain]),
    "PATCH /git/refs/heads/dev": ref("dev", main),
  };
  const client = createGitHubClient({
    repository: "owner/repo",
    token: "private-test-token",
    fetchImpl: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname.replace("/repos/owner/repo", "");
      const method = init.method!;
      requests.push({ method, path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const key = `${method} ${path}`;
      const count = counts.get(key) ?? 0;
      counts.set(key, count + 1);
      const reply = overrides[key]?.[count];
      if (reply?.error) throw reply.error;
      if (!reply && !(key in defaults)) throw new Error(`Unexpected request: ${key}`);
      return new Response(reply?.invalidJson ? "not JSON" : JSON.stringify(reply && "body" in reply ? reply.body : defaults[key]), {
        status: reply?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { run: () => syncDev({ client, expectedMainSha: main }), requests,
    writes: () => requests.filter(request => request.method !== "GET") };
}

describe("protected Dev fast-forward", () => {
  test("validates both commit trees and fresh tips before the only non-forced write", async () => {
    const state = fixture();
    expect(await state.run()).toEqual({ result: "fast-forwarded", main, previousDev: dev, dev: main });
    expect(state.requests.map(request => `${request.method} ${request.path}`)).toEqual([
      "GET /git/ref/heads/main", "GET /git/ref/heads/dev",
      `GET /git/commits/${main}`, `GET /git/commits/${dev}`,
      "GET /git/ref/heads/main", "GET /git/ref/heads/dev", "PATCH /git/refs/heads/dev",
    ]);
    expect(state.writes()).toEqual([{ method: "PATCH", path: "/git/refs/heads/dev", body: { sha: main, force: false } }]);
  });

  test("already equal is idempotent and needs no commit lookup", async () => {
    const state = fixture({ "GET /git/ref/heads/dev": [{ body: ref("dev", main) }] });
    expect(await state.run()).toEqual({ result: "equal", main, dev: main });
    expect(state.requests).toHaveLength(2);
    expect(state.writes()).toEqual([]);
  });

  test("a superseded main event does not update either branch", async () => {
    const state = fixture({ "GET /git/ref/heads/main": [{ body: ref("main", other) }] });
    expect(await state.run()).toEqual({ result: "stale", main: other, dev });
    expect(state.requests).toHaveLength(2);
    expect(state.writes()).toEqual([]);
  });

  for (const [name, metadata] of [
    ["a squash commit", commit(main, [previousMain])],
    ["an octopus merge", commit(main, [previousMain, dev, other])],
    ["duplicate parents", commit(main, [dev, dev])],
    ["a different Dev tip", commit(main, [previousMain, other])],
    ["Dev in the first-parent position", commit(main, [dev, previousMain])],
    ["a changed product tree", commit(main, [previousMain, dev], other)],
  ]) test(`rejects ${name}`, async () => {
    const state = fixture({ [`GET /git/commits/${main}`]: [{ body: metadata }] });
    await expect(state.run()).rejects.toThrow();
    expect(state.writes()).toEqual([]);
  });

  for (const branch of ["main", "dev"]) test(`refuses a concurrent ${branch} move after inspecting commits`, async () => {
    const sha = branch === "main" ? main : dev;
    const state = fixture({ [`GET /git/ref/heads/${branch}`]: [{ body: ref(branch, sha) }, { body: ref(branch, other) }] });
    await expect(state.run()).rejects.toThrow("changed during validation");
    expect(state.writes()).toEqual([]);
  });

  for (const [name, path, metadata] of [
    ["missing ref", "GET /git/ref/heads/dev", {}],
    ["wrong ref", "GET /git/ref/heads/dev", ref("main", dev)],
    ["non-commit ref", "GET /git/ref/heads/dev", { ...ref("dev", dev), object: { type: "tag", sha: dev } }],
    ["invalid SHA", "GET /git/ref/heads/main", ref("main", "unknown")],
    ["wrong commit", `GET /git/commits/${main}`, commit(other, [previousMain, dev])],
    ["missing parents", `GET /git/commits/${main}`, { sha: main, tree: { sha: tree } }],
    ["missing tree", `GET /git/commits/${dev}`, { sha: dev, parents: [] }],
    ["invalid parent", `GET /git/commits/${main}`, { ...commit(main, [previousMain, dev]), parents: [{ sha: previousMain }, {}] }],
  ] as const) test(`fails closed on ${name} metadata`, async () => {
    const state = fixture({ [path]: [{ body: metadata }] });
    await expect(state.run()).rejects.toThrow();
    expect(state.writes()).toEqual([]);
  });

  for (const status of [403, 404, 429, 500]) test(`does not reinterpret HTTP ${status} as missing or retry`, async () => {
    const state = fixture({ "GET /git/ref/heads/main": [{ status, body: { message: "private-test-token" } }] });
    await expect(state.run()).rejects.toThrow(`HTTP ${status}`);
    expect(state.writes()).toEqual([]);
    expect(state.requests.filter(request => request.path === "/git/ref/heads/main")).toHaveLength(1);
  });

  test("network failures and malformed API JSON cannot reach the write", async () => {
    for (const reply of [{ error: new Error("network unavailable") }, { invalidJson: true }]) {
      const state = fixture({ [`GET /git/commits/${main}`]: [reply] });
      await expect(state.run()).rejects.toThrow();
      expect(state.writes()).toEqual([]);
    }
  });

  for (const status of [403, 422, 500]) test(`a rejected write (${status}) is never retried or forced`, async () => {
    const state = fixture({ "PATCH /git/refs/heads/dev": [{ status }] });
    await expect(state.run()).rejects.toThrow(`HTTP ${status}`);
    expect(state.writes()).toEqual([{ method: "PATCH", path: "/git/refs/heads/dev", body: { sha: main, force: false } }]);
  });

  test("unexpected update confirmation fails without another write", async () => {
    const state = fixture({ "PATCH /git/refs/heads/dev": [{ body: ref("dev", other) }] });
    await expect(state.run()).rejects.toThrow("unexpected Dev SHA");
    expect(state.writes()).toHaveLength(1);
    expect(state.writes()[0].body.force).toBe(false);
  });
});

describe("trusted sync events", () => {
  const repository = "owner/repo";
  const input = { eventName: "push", ref: "refs/heads/main", repository, expectedMainSha: main,
    event: { repository: { full_name: repository }, ref: "refs/heads/main", after: main, forced: false, deleted: false } };
  test("accepts a complete normal main push and an explicit manual branches operation", () => {
    expect(validateSyncEvent(input)).toEqual({ repository, expectedMainSha: main });
    expect(validateSyncEvent({ ...input, eventName: "workflow_dispatch", event: { repository: input.event.repository, inputs: { operation: "branches" } } }))
      .toEqual({ repository, expectedMainSha: main });
  });
  for (const [name, value] of [
    ["a different workflow ref", { ...input, ref: "refs/heads/dev" }],
    ["an unrelated event", { ...input, eventName: "pull_request" }],
    ["a different repository", { ...input, repository: "fork/repo" }],
    ["a forced push", { ...input, event: { ...input.event, forced: true } }],
    ["a deletion", { ...input, event: { ...input.event, deleted: true } }],
    ["missing push metadata", { ...input, event: { ...input.event, forced: undefined } }],
    ["a different pushed SHA", { ...input, event: { ...input.event, after: other } }],
    ["an invalid event SHA", { ...input, expectedMainSha: "main" }],
    ["an unrelated manual operation", { ...input, eventName: "workflow_dispatch", event: { ...input.event, inputs: { operation: "all" } } }],
  ]) test(`rejects ${name}`, () => expect(() => validateSyncEvent(value)).toThrow());
});
