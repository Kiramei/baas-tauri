import { showcaseMedia } from "./showcase-media.mjs";

const sourceMarker = "/content/docs/";

export function resolveDocLink(href, sourcePath, basePath = "") {
  if (href.startsWith("//")) return href;
  if (href.startsWith("/")) return `${basePath}${href}`;
  if (!href.startsWith(".")) return href;
  const locale = sourcePath.split("/")[0];
  const target = new URL(href, `https://docs.invalid/docs/${sourcePath.replace(/\.mdx?$/, "")}`);
  if (!target.pathname.startsWith(`/docs/${locale}/`)) {
    throw new Error(`Documentation link escapes its locale: ${sourcePath} -> ${href}`);
  }
  let pathname = target.pathname.replace(/\.mdx?$/, "").replace(/\/index$/, "/");
  if (!pathname.endsWith("/")) pathname += "/";
  return `${basePath}${pathname}${target.search}${target.hash}`;
}

/** Source-relative document links must not depend on the exported page's trailing slash. */
export function remarkDocLinks() {
  return (tree, file) => {
    const normalized = String(file.path).replaceAll("\\", "/");
    const marker = normalized.lastIndexOf(sourceMarker);
    if (marker < 0) throw new Error(`Missing documentation source path: ${file.path}`);
    const sourcePath = normalized.slice(marker + sourceMarker.length);
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
    const prefixAsset = (value) =>
      value.startsWith("/") && !value.startsWith("//") ? `${basePath}${showcaseMedia(value)}` : value;
    // Fumadocs anchors use Next Link, which applies basePath; media URLs need it explicitly.
    function visit(node) {
      if (node.type === "link" || node.type === "definition")
        node.url = resolveDocLink(node.url, sourcePath);
      if (node.type === "image") node.url = prefixAsset(node.url);
      if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
        for (const attribute of node.attributes ?? []) {
          if (attribute.type !== "mdxJsxAttribute" || typeof attribute.value !== "string") continue;
          if (node.name === "a" && attribute.name === "href")
            attribute.value = resolveDocLink(attribute.value, sourcePath);
          if (
            ["img", "video", "source"].includes(node.name) &&
            ["src", "poster"].includes(attribute.name)
          )
            attribute.value = prefixAsset(attribute.value);
        }
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(tree);
  };
}
