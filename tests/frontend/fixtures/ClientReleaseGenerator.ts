import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];
const publishedAt = "2026-07-01T12:00:00Z";
// Execute an exact source copy in its own project directory. The generator's
// import.meta.url output path must never resolve to the actual bundled snapshot.
const tempRoot = await mkdtemp(join(tmpdir(), "baas-client-release-history-"));
const scriptPath = join(tempRoot, "scripts", "update-client-release-history.mjs");
const outputPath = join(tempRoot, "public", "client-release-history.json");
const bundledPath = new URL("../../../public/client-release-history.json", import.meta.url);
const originalBundled = await readFile(bundledPath, "utf8");
await mkdir(join(tempRoot, "scripts"));
await writeFile(
  scriptPath,
  await readFile(new URL("../../../scripts/update-client-release-history.mjs", import.meta.url))
);
const rows =
  mode === "nullable"
    ? [
        { tag_name: "v2.0.0", name: null, body: null, published_at: publishedAt },
        { tag_name: "v1.0.0-rc", name: "", published_at: publishedAt },
        { tag_name: "updater", name: null, body: null, published_at: publishedAt },
        null,
      ]
    : [
        {
          tag_name: `v2.0.0-${"x".repeat(129)}`,
          name: null,
          body: null,
          published_at: publishedAt,
        },
      ];
globalThis.fetch = (async (url) => {
  assert.equal(
    String(url),
    "https://api.github.com/repos/Kiramei/baas-tauri/releases?per_page=100&page=1"
  );
  return Response.json(rows);
}) as typeof fetch;

try {
  if (mode === "nullable") {
    await import(pathToFileURL(scriptPath).href);
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    await assert.rejects(readFile(`${outputPath}.tmp`), { code: "ENOENT" });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.releases.map(({ tag, name, body }: { tag: string; name: string; body: string }) => ({
        tag,
        name,
        body,
      })),
      [
        { tag: "v2.0.0", name: "v2.0.0", body: "" },
        { tag: "v1.0.0-rc", name: "v1.0.0-rc", body: "" },
      ]
    );
  } else {
    assert.equal(mode, "long-tag");
    await assert.rejects(
      import(pathToFileURL(scriptPath).href),
      /Invalid version release metadata/
    );
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
    await assert.rejects(readFile(`${outputPath}.tmp`), { code: "ENOENT" });
  }
  assert.equal(await readFile(bundledPath, "utf8"), originalBundled);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
