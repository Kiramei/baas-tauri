import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Android enables the official fs write-file API without broad filesystem scope", () => {
  const capability = JSON.parse(
    readFileSync(new URL("../../src-tauri/capabilities/android.json", import.meta.url), "utf8")
  );
  expect(capability.permissions).toContain("fs:allow-write-file");
  expect(
    capability.permissions.some(
      (permission: any) =>
        permission?.identifier?.startsWith("fs:") &&
        permission.allow?.some((entry: any) => entry.path === "**")
    )
  ).toBe(false);
});

test("Android SAF downloads preserve ZIP bytes, await writes, and propagate write failures", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/StorageDownloads.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
});
