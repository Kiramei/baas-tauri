import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Only public version release notes are shipped. No assets, credentials or Git objects.
const repository = "Kiramei/baas-tauri";
const maximumBytes = 2 * 1024 * 1024;
const output = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public/client-release-history.json"
);
const releases = [];
const seen = new Set();
let complete = false;
for (let page = 1; page <= 5; page++) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "BAAS-Release-History",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok) throw new Error(`Release history request failed (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error("Release history response exceeds 2 MiB");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const rows = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!Array.isArray(rows) || rows.length > 100)
    throw new Error("Invalid release history response");
  for (const row of rows) {
    if (
      !row ||
      row.draft ||
      typeof row.tag_name !== "string" ||
      !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(row.tag_name)
    )
      continue;
    if (seen.has(row.tag_name)) continue;
    const name = typeof row.name === "string" && row.name ? row.name : row.tag_name;
    const body = typeof row.body === "string" ? row.body : "";
    if (
      row.tag_name.length > 128 ||
      name.length > 256 ||
      body.length > 100_000 ||
      typeof row.published_at !== "string" ||
      !Number.isFinite(Date.parse(row.published_at))
    )
      throw new Error("Invalid version release metadata");
    seen.add(row.tag_name);
    releases.push({
      tag: row.tag_name,
      name,
      body,
      publishedAt: row.published_at,
      url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(row.tag_name)}`,
    });
  }
  if (rows.length < 100) {
    complete = true;
    break;
  }
}
if (!releases.length) throw new Error("No published version release notes were found");
const document =
  JSON.stringify(
    { schema: 1, repository, generatedAt: new Date().toISOString(), complete, releases },
    null,
    2
  ) + "\n";
if (Buffer.byteLength(document) > maximumBytes)
  throw new Error("Bundled release notes exceed 2 MiB");
await mkdir(dirname(output), { recursive: true });
await writeFile(`${output}.tmp`, document);
await rename(`${output}.tmp`, output);
console.log(
  `Bundled ${releases.length} version release notes (${complete ? "complete" : "partial"}).`
);
