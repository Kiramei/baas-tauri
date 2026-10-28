import { defineConfig, defineDocs, frontmatterSchema } from "fumadocs-mdx/config";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins/remark-mdx-mermaid";
import { remarkSteps } from "fumadocs-core/mdx-plugins/remark-steps";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { transformerTwoslash } from "fumadocs-twoslash";
import { resolve } from "node:path";
import { z } from "zod";
import { remarkDocLinks } from "./lib/remark-doc-links.mjs";

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
    remarkPlugins: [remarkMdxMermaid, remarkSteps, remarkDocLinks],
    rehypeCodeOptions: {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      langs: ["js", "jsx", "ts", "tsx"],
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerTwoslash({
          twoslashOptions: {
            compilerOptions: {
              baseUrl: resolve(".."),
              paths: { "@/*": ["src/*"] },
            },
          },
        }),
      ],
    },
  },
});
