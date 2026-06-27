"use client";

import { useEffect, useId, useState } from "react";
import mermaid from "mermaid";

type MermaidProps = {
  chart: string;
};

type MermaidTheme = "light" | "dark";

const mermaidThemeVariables = {
  light: {
    background: "transparent",
    mainBkg: "#ffffff",
    primaryColor: "#ffffff",
    primaryTextColor: "#0f172a",
    primaryBorderColor: "#0891b2",
    secondaryColor: "#ecfeff",
    tertiaryColor: "#f8fafc",
    lineColor: "#0891b2",
    edgeLabelBackground: "#ffffff",
    clusterBkg: "#f8fafc",
    clusterBorder: "#bae6fd",
    titleColor: "#0f172a",
    nodeTextColor: "#0f172a",
    fontFamily: "Blueaka, ui-sans-serif, system-ui, sans-serif",
  },
  dark: {
    background: "transparent",
    mainBkg: "#111827",
    primaryColor: "#111827",
    primaryTextColor: "#f8fafc",
    primaryBorderColor: "#22d3ee",
    secondaryColor: "#0f172a",
    tertiaryColor: "#020617",
    lineColor: "#38bdf8",
    edgeLabelBackground: "#0f172a",
    clusterBkg: "#0f172a",
    clusterBorder: "#164e63",
    titleColor: "#f8fafc",
    nodeTextColor: "#f8fafc",
    fontFamily: "Blueaka, ui-sans-serif, system-ui, sans-serif",
  },
} satisfies Record<MermaidTheme, Record<string, string>>;

function detectTheme(): MermaidTheme {
  if (typeof document === "undefined") return "dark";

  const root = document.documentElement;
  const dataTheme = root.dataset.theme;
  if (dataTheme === "light" || root.classList.contains("light")) return "light";
  if (dataTheme === "dark" || root.classList.contains("dark")) return "dark";

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function initializeMermaid(theme: MermaidTheme) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: mermaidThemeVariables[theme],
  });
}

initializeMermaid("dark");

export function Mermaid({ chart }: MermaidProps) {
  const id = useId().replace(/:/g, "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<MermaidTheme>("dark");

  useEffect(() => {
    const updateTheme = () => setTheme(detectTheme());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const observer = new MutationObserver(updateTheme);

    updateTheme();
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    media.addEventListener("change", updateTheme);

    return () => {
      observer.disconnect();
      media.removeEventListener("change", updateTheme);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    initializeMermaid(theme);

    mermaid
      .render(`mermaid-${id}-${theme}`, chart)
      .then((result) => {
        if (cancelled) return;
        setSvg(result.svg);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      cancelled = true;
    };
  }, [chart, id, theme]);

  if (error) {
    return (
      <pre className="baas-mermaid-error">
        Mermaid render failed: {error}
        {"\n\n"}
        {chart}
      </pre>
    );
  }

  return (
    <figure className="baas-mermaid">
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <div>Rendering diagram...</div>}
    </figure>
  );
}
