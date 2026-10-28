import { expect, test } from "bun:test";

test.each(["storage", "logs", "clipboard", "locale", "auth-retry"])(
  "WebUI %s preserves browser behavior without native services",
  (scenario) => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, `${import.meta.dir}/fixtures/BrowserReliability.ts`, scenario],
      cwd: `${import.meta.dir}/../..`,
      timeout: 10_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
  }
);
