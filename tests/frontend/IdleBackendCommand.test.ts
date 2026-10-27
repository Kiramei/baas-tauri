import { expect, test } from "bun:test";

test("idle updater timeout cleans the allocated command ID without removing another callback", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/IdleBackendCommand.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
});
