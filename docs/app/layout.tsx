import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { FlexSearchDialog } from "@/components/FlexSearchDialog";
import { ImageZoom } from "@/components/ImageZoom";
import { withDocsBasePath } from "@/lib/base-path";
import "fumadocs-ui/style.css";
import "fumadocs-twoslash/twoslash.css";
import "./global.css";

const iconPath = withDocsBasePath("/baas-icon.png");

export const metadata: Metadata = {
  title: {
    default: "BAAS Docs",
    template: "%s | BAAS Docs",
  },
  description:
    "Documentation for the BAAS Tauri desktop app and Blue Archive automation workflows.",
  icons: {
    icon: iconPath,
    apple: iconPath,
  },
};

/** Renders the root layout component. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider search={{ SearchDialog: FlexSearchDialog }}>
          {children}
          <ImageZoom />
        </RootProvider>
      </body>
    </html>
  );
}
