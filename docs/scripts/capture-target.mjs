import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export function captureTarget(root) {
  const theme = process.env.DOCS_CAPTURE_THEME || "dark";
  assert.ok(["dark", "light"].includes(theme));
  const output = path.resolve(process.env.DOCS_CAPTURE_OUTPUT || path.join(root, ".cache/showcase-capture"));
  const relative = path.relative(path.join(root, ".cache"), output);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Capture into a private staging directory under .cache");
  const publicRoot = path.join(output, "public");
  const evidenceRoot = path.join(output, "evidence");
  for (const directory of [publicRoot, evidenceRoot]) mkdirSync(directory, { recursive: true });
  const proof = JSON.parse(readFileSync(path.join(root, "docs/public/media/desktop/installer-manifest.json")));
  return {
    theme, publicRoot, evidenceRoot, sourceRevision: proof.sourceRevision,
    async verify(page) {
      assert.ok(process.env.DOCS_CAPTURE_RUNTIME, "Supply the disposable capture runtime");
      const runtime = realpathSync(process.env.DOCS_CAPTURE_RUNTIME);
      const storage = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("updater_get_storage_state"));
      assert.equal(storage.portable, true);
      assert.equal(realpathSync(path.dirname(storage.storageFilePath)), runtime);
      assert.equal(createHash("sha256").update(readFileSync(path.join(runtime, "baas-tauri.exe"))).digest("hex"), proof.executableSha256);
      const profiles = JSON.parse(readFileSync(path.join(runtime, "config/documentation/config.json")));
      assert.equal(profiles.name, "Schale Demo");
      assert.equal(profiles.autostart, false);
      const events = JSON.parse(readFileSync(path.join(runtime, "config/documentation/event.json")));
      assert.ok(events.length > 0 && events.every(event => event.enabled === false));
    },
  };
}
