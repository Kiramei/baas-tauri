import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { ImageZoom } from "@/components/ImageZoom";
import "fumadocs-ui/style.css";
import "./global.css";

export const metadata: Metadata = {
  title: {
    default: "BAAS Docs",
    template: "%s | BAAS Docs",
  },
  description:
    "Documentation for the BAAS Tauri desktop app and Blue Archive automation workflows.",
  icons: {
    icon: "/baas-icon.png",
    apple: "/baas-icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>
          {children}
          <ImageZoom />
        </RootProvider>
      </body>
    </html>
  );
}
