import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import ts from "typescript";
import publication from "../evidence/webp-publication.json";

// Include application entry-link coverage in the documentation-only CI job.
import "../../tests/frontend/Documentation.test";

const root = new URL("../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), "utf8");
const documents = ["README.md", "README_zh.md"].map(file => ({ file, content: read(file) }));
type Reference = { type: "image" | "link"; url: string; alt?: string };

function* nodes(node: any): Generator<any> {
  yield node;
  for (const child of node.children ?? []) yield* nodes(child);
}

async function references(content: string): Promise<Reference[]> {
  const refs: Reference[] = [];
  const tree = fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  for (const node of nodes(tree)) {
    if (node.type === "link") refs.push({ type: "link", url: node.url });
    if (node.type === "image") refs.push({ type: "image", url: node.url, alt: node.alt });
    if (node.type !== "html") continue;
    await new HTMLRewriter()
      .on("img", { element(element) {
        refs.push({ type: "image", url: element.getAttribute("src") ?? "", alt: element.getAttribute("alt") ?? "" });
      } })
      .on("a", { element(element) {
        const url = element.getAttribute("href");
        if (url) refs.push({ type: "link", url });
      } })
      .transform(new Response(node.value)).text();
  }
  return refs;
}

test("both READMEs use existing localized WebP images bound to publication provenance", async () => {
  for (const { file, content } of documents) {
    const refs = await references(content);
    const images = refs.filter(ref => ref.type === "image" && !ref.url.startsWith("https://"));
    expect(images).toHaveLength(6);
    const locale = file === "README.md" ? "en" : "zh";
    for (const image of images) {
      expect(image.alt?.trim().length).toBeGreaterThan(0);
      expect(image.url).toEndWith(".webp");
      const record = publication.files.find(item => "docs/public/" + item.file === image.url);
      expect(record, image.url).toBeDefined();
      const bytes = readFileSync(new URL(image.url, root));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(record!.sha256);
      expect(record!.changedVisiblePixels).toBe(0);
      if (image.url.includes("/media/")) expect(image.url).toContain(`/media/desktop/${locale}/dark/`);
    }
    for (const ref of refs) {
      if (/^(https?:|mailto:|#)/.test(ref.url)) continue;
      const destination = new URL(ref.url, root);
      expect(fileURLToPath(destination).startsWith(fileURLToPath(root))).toBe(true);
      expect(existsSync(destination), `${file}: ${ref.url}`).toBe(true);
    }
  }
});

test("README language entries agree with the application's default documentation host", async () => {
  const source = ts.createSourceFile("Documentation.ts", read("src/shared/Documentation.ts"), ts.ScriptTarget.Latest, true);
  const literals: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node)) literals.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const base = "https://baas.kiramei.moe";
  expect(literals).toContain(base);
  for (const { content } of documents) {
    const urls = (await references(content)).map(ref => ref.url);
    for (const locale of ["en", "zh"]) expect(urls).toContain(`${base}/docs/${locale}/`);
    expect(content).not.toContain("baas.kiramei.cn");
    expect(content).not.toContain("kiramei.cn/baas-tauri");
    expect(content).not.toMatch(/docs\/public\/(?:cn|en)\//);
  }
});

test("READMEs link the current Android handoff without exposing private validation data", async () => {
  for (const { content } of documents) {
    const urls = (await references(content)).map(ref => ref.url);
    expect(urls).toContain("https://github.com/Kiramei/baas-tauri/blob/android-dev/docs/ANDROID_PREVIEW_HANDOFF.md");
    for (const branch of ["main", "dev", "android-dev"])
      expect(urls).toContain(`https://github.com/Kiramei/baas-tauri/tree/${branch}`);
    expect(content).not.toMatch(/(?:[a-z]:[\\/]+(?:workspace|users)[\\/]|\.cache\/|\.codex_tmp|file:\/\/)/i);
    expect(content).not.toContain("fix/android-trusted-display-and-insets");
    expect(content).not.toContain("docs/dev-refresh");
  }
  expect(read("docs/README.md")).not.toContain("`docs/dev-refresh`");
});
