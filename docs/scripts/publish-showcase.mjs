import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { losslessWebp, webpName } from "./convert-public-media.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cache = path.resolve(root, process.argv[2] || ".cache/dark-showcase");
assert.ok(path.relative(path.join(root, ".cache"), cache) && !path.relative(path.join(root, ".cache"), cache).startsWith(".."));
const hash = value => createHash("sha256").update(value).digest("hex");
const read = file => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const staged = path.join(cache, "public");
const manifestNames = ["manifest", "workspaces-manifest", "conditional-manifest", "installer-manifest", "remote-manifest", "settings-tail-manifest"];
const manifests = manifestNames
  .map(name => read(path.join(staged, "media/desktop", name + ".json")));
for (const manifest of manifests) assert.equal(manifest.sourceRevision, manifests[0].sourceRevision);
const conditional = manifests[2];
assert.ok(conditional.scenariosCompleted && conditional.restored && conditional.demoEventsUnchanged && conditional.protectedProfilesUnchanged);
assert.equal(conditional.originalFieldsSha256, conditional.restoredFieldsSha256);
const recordings = read(path.join(cache, "evidence/recordings.json"));
const shots = [...manifests.flatMap(manifest => [...manifest.shots, ...(manifest.recordings ?? [])]), ...recordings.results];
const unique = new Map(shots.map(shot => [shot.file, shot]));
const publicationFile = path.join(root, "docs/evidence/webp-publication.json");
const publication = read(publicationFile);
for (const record of publication.files)
  assert.equal(hash(readFileSync(path.join(root, "docs/public", record.file))), record.sha256, "An existing capture changed");
const outputFile = path.join(root, "docs/public/media/desktop/dark-manifest.json");
const previous = existsSync(outputFile) ? read(outputFile) : null;
if (previous) {
  assert.ok(process.argv.includes("--extend"), "Explicitly extend an existing reviewed publication");
  const prior = publication.additions.find(item => item.manifest === "media/desktop/dark-manifest.json");
  assert.equal(prior?.sha256, hash(readFileSync(outputFile)), "Existing manifest changed outside the publisher");
}
assert.ok(process.argv.includes("--reviewed"), "Finish OCR and visual review before publication");
const scan = read(path.join(cache, "ocr-reviewed.json"));
for (const shot of unique.values()) {
  const record = scan.files.find(file => file.file === shot.file);
  assert.ok(record && record.failure === null, "Missing successful OCR review: " + shot.file);
  assert.equal(record.sha256, hash(readFileSync(path.join(staged, shot.file))), "OCR review is stale");
}
const files = previous ? [...previous.files] : [];
for (const shot of unique.values()) {
  assert.equal(shot.native, true);
  assert.equal(shot.theme, "dark");
  assert.match(shot.file, /^media\/desktop\/(en|zh)\/[\w.-]+\.(png|gif)$/);
  const input = readFileSync(path.join(staged, shot.file));
  if (shot.sha256) assert.equal(hash(input), shot.sha256);
  const sourceFile = shot.file.replace(/\/(en|zh)\//, "/$1/dark/");
  const file = webpName(sourceFile);
  const destination = path.join(root, "docs/public", file);
  if (existsSync(destination)) {
    const prior = files.find(item => item.file === file);
    assert.ok(prior, "Refusing to overwrite an unknown asset");
    assert.equal(prior.sourceSha256, hash(input), "Existing capture source changed");
    assert.equal(prior.sha256, hash(readFileSync(destination)), "Existing publication changed");
    continue;
  }
  const { output, ...proof } = await losslessWebp(input);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, output);
  publication.files.push({ file, sourceFile, sourceSha256: hash(input), sha256: hash(output), sourceBytes: input.length,
    bytes: output.length, ...proof });
  files.push({ file, replaces: webpName(shot.file), sourceSha256: hash(input), sha256: hash(output),
    locale: shot.locale, state: shot.state ?? path.basename(shot.file), theme: "dark", native: true,
    frames: proof.frames, width: proof.width, height: proof.height });
}
files.sort((a, b) => a.file.localeCompare(b.file));
const scripts = ["capture-target", "capture-desktop", "capture-workspaces", "capture-conditional-config", "capture-installer", "capture-remote", "capture-settings-tail", "record-workspace"];
const report = { capturedAt: manifests.map(item => item.capturedAt).filter(Boolean).sort().at(-1),
  publishedAt: new Date().toISOString(), sourceRevision: manifests[0].sourceRevision,
  executableSha256: manifests[3].executableSha256, theme: "dark", native: true,
  scope: "Isolated native desktop release with real disposable backend, disabled demo tasks and empty credentials. Read-only dialogs, reversible configuration edits and a real emulator preview of the documentation app. No game launched, remote input, clipboard or power commands, Shizuku restart or performance measurement.",
  historicalCapturesPreserved: true, configurationRestored: true, demoEventsUnchanged: true,
  sourceManifests: manifests.map((item, index) => ({ name: manifestNames[index], capturedAt: item.capturedAt })),
  reviewedScripts: Object.fromEntries(scripts.map(name => { const file = `docs/scripts/${name}.mjs`; return [file, hash(readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n"))]; })),
  privacy: "Demo data and empty credentials; installer local paths, terminal identifiers and tooltip commands receive local 12px blur before capture. Original captures and OCR text remain private. All published images are metadata-free lossless WebP.",
  files };
writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
writeFileSync(path.join(root, "docs/lib/showcase-assets.json"), JSON.stringify(Object.fromEntries(files.map(file => ["/" + file.replaces, "/" + file.file])), null, 2) + "\n");
publication.additions = [...(publication.additions ?? []).filter(item => item.manifest !== "media/desktop/dark-manifest.json"), { publishedAt: report.publishedAt, manifest: "media/desktop/dark-manifest.json", sha256: hash(readFileSync(outputFile)), files: files.length }];
writeFileSync(publicationFile, JSON.stringify(publication, null, 2) + "\n");
console.log(JSON.stringify({ published: files.length, frames: files.reduce((sum, file) => sum + file.frames, 0) }));
