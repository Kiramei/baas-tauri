import { expect, test } from "bun:test";
import { remainingSyncOperations, syncPathsOverlap } from "../../src/shared/SyncPatchOrdering";

test("JSON pointer overlap respects decoded segments, parents and the root", () => {
  expect(syncPathsOverlap("/nested", "/nested/child")).toBe(true);
  expect(syncPathsOverlap("/nested/child", "/nested")).toBe(true);
  expect(syncPathsOverlap("/", "/nested/child")).toBe(true);
  expect(syncPathsOverlap("/nested", "")).toBe(true);
  expect(syncPathsOverlap("/nested", "/nestedOther")).toBe(false);
  expect(syncPathsOverlap("/a~1b", "/a/b")).toBe(false);
  expect(syncPathsOverlap("/a~1b", "/a~1b/child")).toBe(true);
  const independent = { op: "replace", path: "/other", value: 1 };
  expect(
    remainingSyncOperations(
      [{ op: "replace", path: "/nested", value: {} }, independent],
      [{ op: "replace", path: "/nested/child", value: 2 }]
    )
  ).toEqual([independent]);
});

test("real store sync retries preserve final task settings and cancelled ACKs cannot complete another save", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/WebsocketStoreSyncOrdering.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
});
