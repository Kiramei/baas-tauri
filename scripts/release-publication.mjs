import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseReleaseVersion } from "../src/shared/ReleaseVersion.mjs";
import { mayPromote, validateAssets } from "./ci/release-contract.mjs";

export function parseAppReleaseTag(tag) {
  const parsed = typeof tag === "string" && parseReleaseVersion(tag.replace(/^v/, ""));
  if (!parsed || (tag !== parsed.canonical && tag !== "v" + parsed.canonical))
    throw new Error("Expected an app release tag with one optional v prefix");
  return parsed;
}

export function existingRelease(tag, pages) {
  parseAppReleaseTag(tag);
  if (!Array.isArray(pages)) throw new Error("Expected paginated release metadata");
  const matches = pages.flat().filter(release => release?.tag_name === tag);
  if (matches.length !== 1) throw new Error("Expected exactly one existing release for " + tag);
  const release = matches[0];
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.draft !== "boolean")
    throw new Error("Invalid release identity or draft state");
  return release;
}

export function uploadedAssets(tag, pages) {
  if (!Array.isArray(pages)) throw new Error("Expected paginated asset metadata");
  const assets = pages.flat();
  const names = new Set(), ids = new Set();
  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || !asset.name || names.has(asset.name) ||
        !Number.isSafeInteger(asset.id) || asset.id <= 0 || ids.has(asset.id) ||
        asset.state !== "uploaded" || !Number.isSafeInteger(asset.size) || asset.size <= 0)
      throw new Error("Assets must be unique, completely uploaded and nonempty");
    names.add(asset.name);
    ids.add(asset.id);
  }
  validateAssets("app", tag, [...names]);
  return assets.map(({ id, name, size, state, digest, updated_at }) => ({ id, name, size, state,
    digest: digest ?? null, updated_at: updated_at ?? null })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Publish only an existing verified release; no assets, Git refs or missing releases are created. */
export function publishExistingRelease({ tag, repository, notesPath, tempRoot = os.tmpdir(), run = execFileSync }) {
  const parsed = parseAppReleaseTag(tag);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid source repository");
  const root = fs.mkdtempSync(path.join(tempRoot, "release-publication-"));
  let sequence = 0;
  const request = (endpoint, options = []) => {
    const file = path.join(root, String(sequence++) + ".json");
    const fd = fs.openSync(file, "w");
    try { run("gh", ["api", endpoint, ...options], { stdio: ["ignore", fd, "inherit"] }); }
    finally { fs.closeSync(fd); }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  const prefix = "repos/" + repository + "/releases";
  const pages = () => request(prefix + "?per_page=100", ["--paginate", "--slurp"]);
  const assets = id => uploadedAssets(tag, request(prefix + "/" + id + "/assets?per_page=100", ["--paginate", "--slurp"]));
  try {
    const release = existingRelease(tag, pages());
    const snapshot = assets(release.id);
    const fresh = request(prefix + "/" + release.id);
    existingRelease(tag, [fresh]);
    if (fresh.id !== release.id || fresh.draft !== release.draft)
      throw new Error("Release identity or publication state changed during verification");
    if (JSON.stringify(assets(release.id)) !== JSON.stringify(snapshot))
      throw new Error("Release assets changed during verification");
    const prerelease = parsed.kind === "rc";
    if (!fresh.draft) {
      if (fresh.prerelease !== prerelease) throw new Error("Published release has an unexpected channel");
      return { tag, id: release.id, assets: snapshot.length, changed: false };
    }
    if (fresh.immutable) throw new Error("An immutable draft cannot be published by recovery");
    const latestPages = pages();
    const latest = existingRelease(tag, latestPages);
    if (latest.id !== release.id || latest.draft !== fresh.draft || latest.immutable)
      throw new Error("Release identity or publication state changed before publication");
    const makeLatest = !prerelease && mayPromote(tag, latestPages.flat());
    const payload = { name: "BAAS Tauri App " + tag, body: fs.readFileSync(notesPath, "utf8"),
      draft: false, prerelease, make_latest: String(makeLatest) };
    const input = path.join(root, "publish.json");
    fs.writeFileSync(input, JSON.stringify(payload));
    const published = request(prefix + "/" + release.id, ["--method", "PATCH", "--input", input]);
    if (published.id !== release.id || published.tag_name !== tag || published.draft !== false ||
        published.prerelease !== prerelease || published.name !== payload.name || published.body !== payload.body)
      throw new Error("Published release metadata did not match the verified request");
    if (JSON.stringify(assets(release.id)) !== JSON.stringify(snapshot))
      throw new Error("Release assets changed while publishing");
    return { tag, id: release.id, assets: snapshot.length, changed: true, makeLatest };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(publishExistingRelease({ tag: process.argv[2], notesPath: process.argv[3],
    repository: process.env.GITHUB_REPOSITORY, tempRoot: process.env.RUNNER_TEMP })));
}
