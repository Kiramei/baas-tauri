import { expect, test } from "bun:test";

test("documentation opens externally on WebUI, desktop and Android without embedding on failure", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/Documentation.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
});
