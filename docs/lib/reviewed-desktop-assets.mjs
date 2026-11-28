import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// These are macOS system dialogs, not BAAS dark-theme showcase captures.
const systemScreenshots = [
  "/media/desktop/zh/macos-gatekeeper-blocked.webp",
  "/media/desktop/zh/macos-gatekeeper-privacy-security.webp",
  "/media/desktop/zh/macos-gatekeeper-open-anyway.webp",
];

export function reviewedDesktopAssets(showcase, publication, readAsset) {
  const reviewed = new Set(Object.values(showcase));
  for (const src of systemScreenshots) {
    const records = publication.files.filter(item => `/${item.file}` === src);
    assert.equal(records.length, 1, `Missing or duplicate publication record: ${src}`);
    const digest = createHash("sha256").update(readAsset(src)).digest("hex");
    assert.equal(digest, records[0].sha256, `Desktop system screenshot changed: ${src}`);
    assert.equal(records[0].changedVisiblePixels, 0, `Desktop screenshot publication changed pixels: ${src}`);
    reviewed.add(src);
  }
  return reviewed;
}
