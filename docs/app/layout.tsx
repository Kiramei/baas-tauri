import type { Metadata } from "next";
import { DocsProvider } from "@/components/DocsProvider";
import { ImageZoom } from "@/components/ImageZoom";
import { getSearchArtifact } from "@/lib/build-search-index";
import "fumadocs-ui/style.css";
import "fumadocs-twoslash/twoslash.css";
import "./global.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: {
    default: "BAAS Docs",
    template: "%s | BAAS Docs",
  },
  description:
    "Documentation for the BAAS Tauri desktop app and Blue Archive automation workflows.",
  icons: {
    icon: `${basePath}/baas-icon.webp`,
    apple: `${basePath}/baas-icon.webp`,
  },
};

/** Renders the root layout component. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const artifact = await getSearchArtifact();
  const searchIndex = { revision: artifact.revision, url: `${basePath}/search-index/${artifact.filename}` };
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="baas-search-index" content={searchIndex.url} />
      </head>
      <body>
        <DocsProvider searchIndex={searchIndex}>
          {children}
          <ImageZoom />
        </DocsProvider>
      </body>
    </html>
  );
}
