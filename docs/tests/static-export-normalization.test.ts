import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeStaticExport } from "../scripts/normalize-static-export.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "baas-docs-export-"));
  const out = path.join(root, "out"),
    app = path.join(root, "app");
  const page = "docs/en/guide/install",
    segment = "/docs/$d$lang/$oc$slug/__PAGE__";
  const bytes = Buffer.from([0, 10, 13, 127, 128, 255]);
  const put = (name: string, value: Buffer | string) => {
    mkdirSync(path.dirname(name), { recursive: true });
    writeFileSync(name, value);
  };
  put(path.join(out, page, "index.html"), "<h1>Fixture</h1>");
  put(path.join(app, page + ".meta"), JSON.stringify({ segmentPaths: [segment] }));
  put(path.join(app, page + ".segments", segment.slice(1) + ".segment.rsc"), bytes);
  const target = path.join(out, page, "__next.docs.$d$lang.$oc$slug.__PAGE__.txt");
  const manifest = {
    routes: { ["/" + page]: { dataRoute: "/" + page + ".rsc" }, "/data.json": { dataRoute: null } },
  };
  const run = () => normalizeStaticExport({ out, app, manifest });
  const cleanup = () => {
    const temp = path.resolve(os.tmpdir());
    if (!root.startsWith(temp + path.sep) || !path.basename(root).startsWith("baas-docs-export-"))
      throw Error("Unexpected fixture cleanup path");
    rmSync(root, { recursive: true, force: true });
  };
  return { root, out, app, page, segment, bytes, target, put, run, cleanup };
}

test("missing Windows-style segment filenames are added with identical bytes", () => {
  const f = fixture();
  try {
    f.put(path.join(f.out, f.page, "__next.docs", "$d$lang", "$oc$slug", "__PAGE__.txt"), f.bytes);
    expect(f.run()).toEqual({ routes: 1, segments: 1, copied: 1 });
    expect(readFileSync(f.target)).toEqual(f.bytes);
    expect(f.run()).toEqual({ routes: 1, segments: 1, copied: 0 });
  } finally {
    f.cleanup();
  }
});

test("already-correct exports are unchanged", () => {
  const f = fixture();
  try {
    f.put(f.target, f.bytes);
    expect(f.run().copied).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("conflicting destinations are never overwritten", () => {
  const f = fixture();
  try {
    f.put(f.target, "different");
    expect(f.run).toThrow("differs");
    expect(readFileSync(f.target, "utf8")).toBe("different");
  } finally {
    f.cleanup();
  }
});

test.each(["/../../outside", "/docs\\outside"])(
  "invalid segment %p is rejected before writing",
  (segment) => {
    const f = fixture();
    try {
      f.put(
        path.join(f.app, f.page + ".meta"),
        JSON.stringify({ segmentPaths: [f.segment, segment] })
      );
      expect(f.run).toThrow();
      expect(existsSync(f.target)).toBe(false);
    } finally {
      f.cleanup();
    }
  }
);

test("a missing segment fails before any output is added", () => {
  const f = fixture();
  try {
    f.put(
      path.join(f.app, f.page + ".meta"),
      JSON.stringify({ segmentPaths: [f.segment, "/missing"] })
    );
    expect(f.run).toThrow();
    expect(existsSync(f.target)).toBe(false);
  } finally {
    f.cleanup();
  }
});
