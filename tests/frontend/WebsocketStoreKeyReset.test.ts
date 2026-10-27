import { expect, test } from "bun:test";

test("Key reset requires an authenticated WebUI session and confirmed backend response", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/WebsocketStoreKeyReset.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
});
