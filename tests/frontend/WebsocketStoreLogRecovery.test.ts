import { expect, test } from "bun:test";

test("provider logs survive recovery initiated by another channel", () => {
  // Module mocks live in a separate process so other frontend tests keep the
  // real transport factory, storage helpers, and environment flags.
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/WebsocketStoreLogRecovery.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
});
