import { expect, test } from "bun:test";

test("the real Android store accepts an empty user-profile list and keeps late profile snapshots", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/WebsocketStoreProfileInitialization.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 15_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
});
