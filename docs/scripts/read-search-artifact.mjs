import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function readSearchArtifact(out) {
  const files = readdirSync(path.join(out, "search-index")).filter(file => /^[a-f0-9]{64}\.json$/.test(file));
  assert.equal(files.length, 1, "Each export must contain exactly one content-addressed search index");
  const relativePath = "search-index/" + files[0];
  const bytes = readFileSync(path.join(out, relativePath));
  const payload = JSON.parse(bytes.toString());
  assert.deepEqual(Object.keys(payload).sort(), ["format", "indexes", "revision"]);
  assert.equal(payload.revision + ".json", files[0]);
  assert.equal(hash(JSON.stringify({ format: payload.format, indexes: payload.indexes })), payload.revision);
  return { relativePath, revision: payload.revision, sha256: hash(bytes), payload, bytes };
}
