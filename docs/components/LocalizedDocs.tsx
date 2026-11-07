"use client";

import type { ReactNode } from "react";
import { useDocsLocale } from "@/components/DocsProvider";

export function LocalizedDocs({ zh, en }: { zh: ReactNode; en: ReactNode }) {
  const { locale } = useDocsLocale();
  return locale === "zh" ? zh : en;
}
