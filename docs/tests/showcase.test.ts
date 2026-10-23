import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import captures from "../public/media/desktop/dark-manifest.json";
import assets from "../lib/showcase-assets.json";
import publication from "../evidence/webp-publication.json";
import layout from "../evidence/showcase-layout.json";
import { showcaseMedia } from "../lib/showcase-media.mjs";
import { remarkDocLinks } from "../lib/remark-doc-links.mjs";
import { captureTarget } from "../scripts/capture-target.mjs";

const root = new URL("../../", import.meta.url);
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

test("desktop showcase assets are native dark captures with intact historical evidence", async () => {
  expect(captures.theme).toBe("dark");
  expect(captures.native).toBe(true);
  expect(captures.historicalCapturesPreserved).toBe(true);
  expect(captures.configurationRestored).toBe(true);
  expect(captures.demoEventsUnchanged).toBe(true);
  expect(captures.files.length).toBeGreaterThan(150);
  expect(Object.keys(assets)).toHaveLength(captures.files.length);
  for (const [file, sha] of Object.entries(captures.reviewedScripts))
    expect(hash(readFileSync(new URL(file, root), "utf8").replaceAll("\r\n", "\n"))).toBe(sha);
  for (const file of captures.files) {
    expect(file.theme).toBe("dark");
    expect(file.native).toBe(true);
    expect(file.file).toContain(`/${file.locale}/dark/`);
    const bytes = readFileSync(new URL("docs/public/" + file.file, root));
    expect(hash(bytes)).toBe(file.sha256);
    const record = publication.files.find(item => item.file === file.file)!;
    expect(record.sourceSha256).toBe(file.sourceSha256);
    expect(record.changedVisiblePixels).toBe(0);
    expect(assets["/" + file.replaces as keyof typeof assets]).toBe("/" + file.file);
    const stats = await sharp(bytes).stats();
    const channels = stats.channels.slice(0, 3);
    expect(channels.every(channel => channel.mean < 110), file.file).toBe(true);
    expect(channels.some(channel => channel.max - channel.min > 64), file.file).toBe(true);
  }
}, 30000);

test("showcase rewriting preserves queries, fragments, external media and deployment prefixes", () => {
  const source = "/media/desktop/en/config-cafe.webp";
  const target = "/media/desktop/en/dark/config-cafe.webp";
  expect(showcaseMedia(source + "?download=1#image")).toBe(target + "?download=1#image");
  expect(showcaseMedia(target)).toBe(target);
  for (const value of ["https://example.com" + source, "//example.com" + source, "/media/android/en/workspace.webp", "/benchmarks/device-current.json"])
    expect(showcaseMedia(value)).toBe(value);
  const previous = process.env.NEXT_PUBLIC_BASE_PATH;
  try {
    for (const prefix of ["", "/baas-tauri"]) {
      process.env.NEXT_PUBLIC_BASE_PATH = prefix;
      const tree = { type: "root", children: [
        { type: "image", url: source },
        { type: "mdxJsxFlowElement", name: "img", attributes: [{ type: "mdxJsxAttribute", name: "src", value: source }] },
      ] };
      remarkDocLinks()(tree, { path: "/repo/docs/content/docs/en/features/cafe.mdx" });
      expect(tree.children[0].url).toBe(prefix + target);
      expect(tree.children[1].attributes?.[0].value).toBe(prefix + target);
    }
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
    else process.env.NEXT_PUBLIC_BASE_PATH = previous;
  }
});

test("showcase browser evidence covers both document themes, languages and viewport sizes", () => {
  expect(layout.cases).toBe(40);
  expect(layout.failures).toBe(0);
  expect(layout.staticReferences).toBeGreaterThan(100);
  for (const [file, sha] of Object.entries(layout.testedSources))
    expect(hash(readFileSync(new URL(file, root), "utf8").replaceAll("\r\n", "\n"))).toBe(sha);
  const combinations = new Set(layout.results.map(result => [result.locale, result.theme, result.mobile, result.route].join("/")));
  expect(combinations.size).toBe(40);
  expect(layout.results.every(result => result.passed && result.images > 0)).toBe(true);
});

test("native capture output refuses public destinations and unsupported themes", () => {
  const previousOutput = process.env.DOCS_CAPTURE_OUTPUT;
  const previousTheme = process.env.DOCS_CAPTURE_THEME;
  try {
    process.env.DOCS_CAPTURE_THEME = "dark";
    for (const destination of ["docs", "docs/public", ".cache/../docs", ".cache"])
      {
        process.env.DOCS_CAPTURE_OUTPUT = fileURLToPath(new URL(destination, root));
        expect(() => captureTarget(fileURLToPath(root))).toThrow("private staging directory");
      }
    process.env.DOCS_CAPTURE_THEME = "invalid";
    expect(() => captureTarget(fileURLToPath(root))).toThrow();
  } finally {
    if (previousOutput === undefined) delete process.env.DOCS_CAPTURE_OUTPUT;
    else process.env.DOCS_CAPTURE_OUTPUT = previousOutput;
    if (previousTheme === undefined) delete process.env.DOCS_CAPTURE_THEME;
    else process.env.DOCS_CAPTURE_THEME = previousTheme;
  }
});
