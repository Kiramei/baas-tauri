import { expect, test } from "bun:test";

test("binary imports resolve integer backend responses and concurrent command IDs stay unique", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/WebsocketStoreCommandCallbacks.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
});
