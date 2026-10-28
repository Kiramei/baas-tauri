import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publication = JSON.parse(readFileSync(path.join(root, "docs/evidence/webp-publication.json"), "utf8"));

// Capture manifests retain their original encoding and digest. Publication is a separate transform.
export function readPublishedMedia(sourceFile, sourceSha256) {
  const record = publication.files.find(file => file.sourceFile === sourceFile);
  assert.ok(record, "No reviewed publication for " + sourceFile);
  if (sourceSha256 !== undefined) assert.equal(record.sourceSha256, sourceSha256, "Capture digest changed");
  assert.equal(record.changedVisiblePixels, 0);
  const filename = path.resolve(root, "docs/public", record.file);
  assert.ok(filename.startsWith(path.join(root, "docs/public") + path.sep));
  const bytes = readFileSync(filename);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256, "Published bytes changed");
  return { record, bytes };
}
