import { defineConfig, defineDocs, frontmatterSchema } from "fumadocs-mdx/config";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins/remark-mdx-mermaid";
import { remarkSteps } from "fumadocs-core/mdx-plugins/remark-steps";
import { transformerTwoslash } from "fumadocs-twoslash";
import { z } from "zod";

type HastNode = {
  type?: string;
  tagName?: string;
  name?: string;
  properties?: Record<string, unknown>;
  attributes?: Array<{ type?: string; name?: string; value?: unknown }>;
  children?: HastNode[];
};

/** Keeps root-relative MDX images inside the configured Pages mount. */
function rehypeBasePathImages() {
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
  return (tree: HastNode) => {
    if (!basePath) return;
    const prefix = (source: unknown) =>
      typeof source === "string" &&
      source.startsWith("/") &&
      !source.startsWith("//") &&
      source !== basePath &&
      !source.startsWith(`${basePath}/`)
        ? `${basePath}${source}`
        : source;
    const visit = (node: HastNode) => {
      const source = node.tagName === "img" ? node.properties?.src : undefined;
      const prefixedSource = prefix(source);
      if (prefixedSource !== source) {
        node.properties = { ...node.properties, src: prefixedSource };
      }
      if (node.name === "img") {
        const sourceAttribute = node.attributes?.find(
          (attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === "src",
        );
        if (sourceAttribute) sourceAttribute.value = prefix(sourceAttribute.value);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: frontmatterSchema.extend({
      badge: z.string().optional(),
    }),
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMdxMermaid, remarkSteps],
    rehypePlugins: [rehypeBasePathImages],
    rehypeCodeOptions: {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      transformers: [transformerTwoslash()],
    },
  },
});
