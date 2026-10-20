import { expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkParse from "remark-parse";
import captures from "../public/media/desktop/installer-manifest.json";
import privacyReview from "../evidence/privacy-review.json";
import legacyBlur from "../evidence/legacy-media-blur.json";
import { plans as legacyBlurPlans } from "../scripts/blur-private-media.mjs";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const documents = (locale: string) => read(`docs/content/docs/${locale}/reference/setup-toml.mdx`);

test("bilingual setup examples parse as the same complete current TOML schema", () => {
  const examples = ["en", "zh"].map((locale) => {
    const tree = unified().use(remarkParse).parse(documents(locale));
    const blocks = tree.children
      .filter((node) => node.type === "code")
      .filter((node) => node.lang === "toml");
    expect(blocks).toHaveLength(1);
    return Bun.TOML.parse(blocks[0].value) as Record<string, any>;
  });
  expect(examples[0]).toEqual(examples[1]);
  const example = examples[0];
  expect(Object.keys(example).sort()).toEqual([
    "general",
    "paths",
    "python",
    "repositories",
    "schema_version",
  ]);
  expect(example.schema_version).toBe(1);
  expect(Object.keys(example.general).sort()).toEqual([
    "channel",
    "current_baas_cpp_sha",
    "current_baas_sha",
    "debug",
    "force_launch",
    "get_remote_sha_method",
    "git_backend",
    "launch",
    "mirrorc_cdk",
    "no_update",
    "source_list",
    "transport",
    "transport_version",
  ]);
  expect(Object.keys(example.paths).sort()).toEqual(["baas_root_path", "tmp_path", "toolkit_path"]);
  expect(Object.keys(example.python).sort()).toEqual(["python_version", "runtime_path"]);
  expect(Object.keys(example.repositories).sort()).toEqual(["cpp_sources", "main_sources"]);
  expect(example.general.transport).toBe("websocket");
  expect(example.general.mirrorc_cdk).toBe("");
  expect(example.general.no_update).toBe(false);
  expect(example.general.launch).toBe(true);
  expect(example.python.runtime_path).toBe("default");
});

test("installer capture inventory has both languages and explicit blur provenance", () => {
  expect(captures.shots).toHaveLength(14);
  for (const locale of ["en", "zh"]) {
    const shots = captures.shots.filter((shot) => shot.locale === locale);
    expect(shots).toHaveLength(7);
    for (const shot of shots) {
      expect(shot.privacy).toContain("12px blur");
      expect(existsSync(new URL("docs/public/" + shot.file, root))).toBe(true);
    }
  }
  expect(JSON.stringify(captures)).not.toMatch(/WorkSpace|[A-Z]:\\Users\\/i);
  expect(captures.verified).toHaveLength(4);
  expect(new Set(captures.verified.map((check) => check.locale + check.scenario)).size).toBe(4);
  expect(captures.executableSha256).toMatch(/^[a-f0-9]{64}$/);
});

test("privacy review covers the current image inventory without publishing OCR text", () => {
  const directory = new URL("docs/public/", root);
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const files = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(png|jpe?g|gif|webp)$/i.test(file))
    .map((file) => file.replaceAll("\\", "/"));
  const inventory = files
    .map((file) => ({ file, sha256: digest(readFileSync(new URL(file, directory))) }))
    .sort((left, right) => left.file.localeCompare(right.file));
  expect(privacyReview.inventorySha256).toBe(digest(JSON.stringify(inventory)));
  expect(privacyReview.imageFiles).toBe(files.length);
  expect(privacyReview.decodedFrames).toBeGreaterThanOrEqual(files.length);
  expect(privacyReview.decodingFailures).toBe(0);
  expect(privacyReview.unresolvedPatternFindings).toBe(0);
  expect(privacyReview).not.toHaveProperty("frames");
  expect(privacyReview).not.toHaveProperty("text");
  for (const finding of privacyReview.reviewedFindings) {
    expect(digest(readFileSync(new URL(finding.file, directory)))).toBe(finding.sha256);
    expect(finding.category).toBe("generic-path-placeholder");
  }
  expect(privacyReview.pendingVisualFindings).toHaveLength(0);
  expect(privacyReview.reviewedRedactions).toHaveLength(2);
  expect(privacyReview.publicationReviewComplete).toBe(false);
  expect(legacyBlur.files).toHaveLength(legacyBlurPlans.length);
  for (const plan of legacyBlurPlans) {
    const record = legacyBlur.files.find((file) => file.file === plan.file)!;
    expect(record).toMatchObject(plan);
    expect(record.sha256).toBe(digest(readFileSync(new URL(record.file, directory))));
    expect(record.sha256).not.toBe(record.sourceSha256);
    expect(record.outsideChangedPixels).toBe(0);
    expect(record.changedPixelsByRegion).toHaveLength(record.regions.length);
    expect(record.changedPixelsByRegion.every((count) => count > 0)).toBe(true);
    expect(record.visualReview?.checkedAt).toBeTruthy();
    expect(record.visualReview?.result).toBeTruthy();
    expect(privacyReview.reviewedRedactions.find((file) => file.file === record.file)?.sha256).toBe(
      record.sha256
    );
  }
});

test("published JSON and reader pages exclude local private workspace paths", () => {
  for (const relative of ["docs/public/", "docs/content/docs/"]) {
    const directory = new URL(relative, root);
    const files = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((file) =>
      /\.(json|mdx)$/i.test(file)
    );
    for (const file of files) {
      const content = readFileSync(new URL(file.replaceAll("\\", "/"), directory), "utf8");
      expect(content).not.toMatch(/[a-z]:[\\/]+(?:workspace|users)[\\/]|\.codex_tmp/i);
    }
  }
});

test("reader pages exclude authoring instructions and the rejected contrast formula", () => {
  const directory = new URL("docs/content/docs/", root);
  const files = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".mdx")
  );
  for (const file of files) {
    const content = readFileSync(new URL(file.replaceAll("\\", "/"), directory), "utf8");
    expect(content).not.toMatch(
      /本套文档以当前|本次更新的验证边界|Capture and Validation Boundary|This Refresh's Verification Boundary/
    );
    expect(content).not.toMatch(/不是[^。\n]{0,120}而是/);
  }
  for (const locale of ["en", "zh"]) {
    const index = read(`docs/content/docs/${locale}/index.mdx`);
    expect(index).not.toContain("browser language preferences");
    expect(index).not.toContain("文档入口优先");
  }
});
