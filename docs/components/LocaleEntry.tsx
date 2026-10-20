"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { detectLocale, localePreferenceKey } from "@/lib/locale";

export function LocaleEntry() {
  const router = useRouter();
  useEffect(() => {
    let preference: string | null = null;
    try {
      preference = localStorage.getItem(localePreferenceKey);
    } catch {
      // Detection also works when the browser disallows persistent storage.
    }
    const locale = detectLocale(preference, navigator.languages ?? [navigator.language]);
    router.replace(`/docs/${locale}/${location.search}${location.hash}`);
  }, [router]);

  return (
    <main className="baas-locale-entry">
      <a href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/docs/en/`}>BAAS Documentation</a>
      <noscript>
        <p>
          <a href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/docs/zh/`}>中文文档</a>
        </p>
      </noscript>
    </main>
  );
}
