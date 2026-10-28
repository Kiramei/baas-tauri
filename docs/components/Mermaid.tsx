"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
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

/** Handles the detect theme workflow. */
function detectTheme(): MermaidTheme {
  if (typeof document === "undefined") return "dark";

  const root = document.documentElement;
  const dataTheme = root.dataset.theme;
  if (dataTheme === "light" || root.classList.contains("light")) return "light";
  if (dataTheme === "dark" || root.classList.contains("dark")) return "dark";

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Performs the initialize mermaid operation. */
function initializeMermaid(theme: MermaidTheme) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: mermaidThemeVariables[theme],
  });
}

initializeMermaid("dark");

/** Renders the mermaid component. */
export function Mermaid({ chart }: MermaidProps) {
  const id = useId().replace(/:/g, "");
  const params = useParams<{ lang: string }>();
  const chinese = params?.lang === "zh";
  const [diagram, setDiagram] = useState<{ svg: string; width: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<MermaidTheme>("dark");
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const changeZoom = (value: number) => {
    setZoom(value);
    if (value === 1) viewport.current?.scrollTo({ left: 0, top: 0 });
  };

  useEffect(() => {
    /** Performs the update theme operation. */
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
    const render = async () => {
      await document.fonts.ready;
      if (cancelled) return;
      initializeMermaid(theme);
      try {
        const result = await mermaid.render(`mermaid-${id}-${theme}`, chart);
        if (cancelled) return;
        const document = new DOMParser().parseFromString(result.svg, "image/svg+xml");
        const width = (document.documentElement as unknown as SVGSVGElement).viewBox.baseVal.width;
        setDiagram({
          svg: result.svg.replace(/<script[\s\S]*?<\/script>/gi, ""),
          width: Number.isFinite(width) && width > 0 ? width : 0,
        });
        setError(null);
      } catch (reason: unknown) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void render();

    return () => {
      cancelled = true;
    };
  }, [chart, id, theme]);

  if (error) {
    return (
      <pre className="baas-mermaid-error">
        {chinese ? "Mermaid 渲染失败：" : "Mermaid render failed: "}
        {error}
        {"\n\n"}
        {chart}
      </pre>
    );
  }

  return (
    <figure className="baas-mermaid">
      <div
        className="baas-mermaid-tools"
        role="group"
        aria-label={chinese ? "图表缩放" : "Diagram zoom"}
      >
        <button
          type="button"
          aria-label={chinese ? "缩小图表" : "Zoom out diagram"}
          title={chinese ? "缩小图表" : "Zoom out diagram"}
          disabled={zoom === 1}
          onClick={() => changeZoom(Math.max(1, zoom - 0.5))}
        >
          <ZoomOut aria-hidden="true" />
        </button>
        <output>{Math.round(zoom * 100)}%</output>
        <button
          type="button"
          aria-label={chinese ? "放大图表" : "Zoom in diagram"}
          title={chinese ? "放大图表" : "Zoom in diagram"}
          disabled={zoom === 8}
          onClick={() => changeZoom(Math.min(8, zoom + 0.5))}
        >
          <ZoomIn aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={chinese ? "重置图表缩放" : "Reset diagram zoom"}
          title={chinese ? "重置图表缩放" : "Reset diagram zoom"}
          disabled={zoom === 1}
          onClick={() => changeZoom(1)}
        >
          <RotateCcw aria-hidden="true" />
        </button>
      </div>
      <div
        ref={viewport}
        className="baas-mermaid-viewport"
        tabIndex={0}
        role="region"
        aria-label={chinese ? "图表" : "Diagram"}
      >
        {diagram ? (
          <div
            className="baas-mermaid-content"
            style={{
              width: diagram.width
                ? `calc(min(100%, ${diagram.width}px) * ${zoom})`
                : `${zoom * 100}%`,
            }}
            dangerouslySetInnerHTML={{ __html: diagram.svg }}
          />
        ) : (
          <div>{chinese ? "正在绘制图表..." : "Rendering diagram..."}</div>
        )}
      </div>
    </figure>
  );
}
