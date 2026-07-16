import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories = [];
const checker = join(import.meta.dir, "check-static-links.mjs");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "baas-doc-links-"));
  temporaryDirectories.push(directory);
  const output = join(directory, "out");
  await mkdir(output);
  return { directory, output };
}

async function runChecker(output) {
  const child = spawnSync(process.execPath, [checker, output], {
    encoding: "utf8",
    env: { ...process.env, NEXT_PUBLIC_BASE_PATH: "/repo" },
  });
  return {
    exitCode: child.status,
    output: `${child.stdout}${child.stderr}`,
  };
}

test("accepts a local route contained by the export root", async () => {
  const { output } = await fixture();
  await mkdir(join(output, "page"));
  await writeFile(join(output, "index.html"), '<a href="/repo/page/">page</a>');
  await writeFile(join(output, "page", "index.html"), '<h1 id="page">page</h1>');

  const result = await runChecker(output);

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("Static documentation check passed");
});

test("rejects percent-encoded traversal outside the export root", async () => {
  const { directory, output } = await fixture();
  await writeFile(
    join(output, "index.html"),
    '<a href="/repo/%2e%2e%2foutside.html#secret">outside</a>',
  );
  await writeFile(join(directory, "outside.html"), '<h1 id="secret">secret</h1>');

  const result = await runChecker(output);

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("invalid local path");
});
