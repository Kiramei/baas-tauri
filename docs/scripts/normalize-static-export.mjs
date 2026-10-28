import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  convertSegmentPathToStaticExportFilename,
} = require("next/dist/shared/lib/segment-cache/segment-value-encoding.js");

function child(root, relative) {
  const target = path.resolve(root, relative);
  const check = path.relative(root, target);
  assert.ok(
    check !== ".." && !check.startsWith(".." + path.sep) && !path.isAbsolute(check),
    "Export path escapes its root"
  );
  return target;
}

export function normalizeStaticExport({ out, app, manifest }) {
  out = path.resolve(out);
  app = path.resolve(app);
  let routes = 0,
    segments = 0,
    copied = 0;
  const pending = [];
  for (const [route, entry] of Object.entries(manifest.routes)) {
    if (!entry.dataRoute?.endsWith(".rsc") || entry.initialStatus >= 400) continue;
    assert.ok(route.startsWith("/") && !route.includes("\\"), "Invalid prerendered route");
    const relative = route === "/" ? "index" : route.slice(1);
    const metadata = JSON.parse(readFileSync(child(app, relative + ".meta"), "utf8"));
    assert.ok(Array.isArray(metadata.segmentPaths), "Missing segment manifest");
    const destination = route === "/" ? out : child(out, route.slice(1));
    if (!existsSync(child(destination, "index.html"))) continue;
    routes++;
    for (const segment of metadata.segmentPaths) {
      assert.ok(
        typeof segment === "string" && segment.startsWith("/") && !segment.includes("\\"),
        "Invalid segment path"
      );
      const source = child(child(app, relative + ".segments"), segment.slice(1) + ".segment.rsc");
      const filename = convertSegmentPathToStaticExportFilename(segment);
      assert.equal(path.basename(filename), filename, "Segment filename must be flat");
      const target = child(destination, filename),
        bytes = readFileSync(source);
      segments++;
      if (existsSync(target))
        assert.ok(
          readFileSync(target).equals(bytes),
          "Existing segment payload differs from the build manifest"
        );
      else pending.push({ target, bytes });
    }
  }
  assert.ok(routes > 0, "No prerendered HTML routes found in the export");
  // Check every source and existing destination before adding generated files.
  for (const { target, bytes } of pending) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: "wx" });
    copied++;
  }
  return { routes, segments, copied };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const report = normalizeStaticExport({
    out: path.resolve(docs, process.env.DOCS_EXPORT_DIR || "out"),
    app: path.join(docs, ".next/server/app"),
    manifest: JSON.parse(readFileSync(path.join(docs, ".next/prerender-manifest.json"), "utf8")),
  });
  console.log(JSON.stringify({ staticExportSegments: report }));
}
