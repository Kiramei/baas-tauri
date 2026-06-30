import { createMDX } from "fumadocs-mdx/next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const root = dirname(fileURLToPath(import.meta.url));

const withMDX = createMDX();

export default function config(phase) {
  return withMDX({
    output: phase === PHASE_DEVELOPMENT_SERVER ? undefined : "export",
    trailingSlash: true,
    basePath,
    assetPrefix: basePath ? `${basePath}/` : undefined,
    serverExternalPackages: ["typescript", "twoslash"],
    turbopack: {
      root,
    },
    images: {
      unoptimized: true,
    },
  });
}
