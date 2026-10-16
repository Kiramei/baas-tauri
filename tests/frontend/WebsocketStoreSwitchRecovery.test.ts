import { expect, test } from "bun:test";

test("the real store switches once and cancels stale initialization and callbacks", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/WebsocketStoreSwitchRecovery.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 15_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
});
