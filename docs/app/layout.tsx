import type { Metadata } from "next";
import { DocsProvider } from "@/components/DocsProvider";
import { ImageZoom } from "@/components/ImageZoom";
import "fumadocs-ui/style.css";
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
    icon: `${basePath}/baas-icon.png`,
    apple: `${basePath}/baas-icon.png`,
  },
};

/** Renders the root layout component. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <DocsProvider>
          {children}
          <ImageZoom />
        </DocsProvider>
      </body>
    </html>
  );
}
