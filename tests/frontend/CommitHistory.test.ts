import { describe, expect, test } from "bun:test";
import { parseCommitHistory, requestWebCommitHistory } from "../../src/shared/CommitHistory";

const hash = "a".repeat(40);
const valid = () => ({
  entries: [{ hash, author: "Kiramei", message: "fix: metadata history" }],
  repository: "Kiramei/baas-dev",
  reference: "master",
  current: hash,
  source: "github",
  stale: false,
  partial: false,
  hasMore: true,
  issue: null,
});

function fixture() {
  let callback!: (response: any) => void;
  const calls: any[] = [];
  const state: any = {
    _auth_phase: "authenticated",
    _session: { sessionId: "first" },
    connections: { trigger: { readyState: 1 } },
    pendingCallbacks: {},
    trigger(request: any, listener: (response: any) => void) {
      calls.push(request);
      callback = listener;
      state.pendingCallbacks[42] = callback;
      return 42;
    },
  };
  return { state, calls, reply: (response: any) => callback(response) };
}
const request = { channel: "dev", limit: 100, refresh: false } as const;

describe("commit history metadata boundary", () => {
  test("retains only three entry fields and treats markup as text", () => {
    const metadata = valid();
    metadata.entries[0].message = '<script>alert("x")</script>';
    const report = parseCommitHistory({
      ...metadata,
      entries: [{ ...metadata.entries[0], diff: "discarded", email: "discarded" }],
      token: "discarded",
    });
    expect(Object.keys(report.entries[0])).toEqual(["hash", "author", "message"]);
    expect(report.entries[0].message).toBe(metadata.entries[0].message);
    expect(report).not.toHaveProperty("token");
    expect(report.entries[0].hash.slice(0, 6)).toBe("aaaaaa");
  });
  test("rejects malformed, excessive and mixed repository metadata", () => {
    for (const patch of [
      { repository: "attacker/repository" },
      { reference: "another-branch" },
      { current: "broken" },
      { source: "mirror-verified" },
      { entries: Array(501).fill(valid().entries[0]) },
      { entries: [valid().entries[0], valid().entries[0]] },
      { entries: [{ hash: "123456", author: "x", message: "x" }] },
      { entries: [{ hash, author: "x\ny", message: "x" }] },
      { entries: [{ hash, author: "x", message: "subject\nbody" }] },
      { entries: [{ hash, author: "x".repeat(257), message: "x" }] },
    ])
      expect(() => parseCommitHistory({ ...valid(), ...patch })).toThrow();
  });
  test("preserves offline/partial information instead of claiming complete history", () => {
    expect(
      parseCommitHistory({
        ...valid(),
        source: "bundle",
        stale: true,
        partial: true,
        issue: "offline",
      })
    ).toMatchObject({ source: "bundle", stale: true, partial: true, issue: "offline" });
  });
});

describe("authenticated WebUI history transport", () => {
  test("uses the authenticated command and clears its callback after success", async () => {
    const f = fixture();
    const result = requestWebCommitHistory(() => f.state, request);
    expect(f.calls[0]).toMatchObject({ command: "get_commit_history", payload: request });
    f.reply({ status: "ok", data: valid() });
    expect((await result).entries).toHaveLength(1);
    expect(f.state.pendingCallbacks[42]).toBeUndefined();
  });
  test("does not send for unauthenticated or disconnected sessions", async () => {
    for (const mutate of [
      (s: any) => {
        s._auth_phase = "challenge";
      },
      (s: any) => {
        s._session = null;
      },
      (s: any) => {
        s.connections.trigger.readyState = 3;
      },
    ]) {
      const f = fixture();
      mutate(f.state);
      await expect(requestWebCommitHistory(() => f.state, request)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
  });
  test("rejects a late response after a session change and hides raw backend errors", async () => {
    const f = fixture();
    const result = requestWebCommitHistory(() => f.state, request);
    f.state._session.sessionId = "second";
    f.reply({ status: "ok", data: valid() });
    await expect(result).rejects.toThrow("unavailable");
    const next = requestWebCommitHistory(() => f.state, request);
    f.reply({ status: "error", error: "private details must not reach UI" });
    await expect(next).rejects.toThrow("Commit history is unavailable");
  });
  test("timeout removes only its own pending callback and ignores late replies", async () => {
    const f = fixture();
    const other = () => {};
    f.state.pendingCallbacks[7] = other;
    const result = requestWebCommitHistory(() => f.state, request, 5);
    await expect(result).rejects.toThrow("timed out");
    expect(f.state.pendingCallbacks[42]).toBeUndefined();
    expect(f.state.pendingCallbacks[7]).toBe(other);
    f.reply({ status: "ok", data: valid() });
  });
});
