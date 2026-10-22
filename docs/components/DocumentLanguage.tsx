"use client";

import { useEffect } from "react";
import type { Locale } from "@/lib/locale";

export function DocumentLanguage({ locale }: { locale: Locale }) {
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);
  return null;
}
