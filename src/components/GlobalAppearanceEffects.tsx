import React, { useEffect, useMemo } from "react";

import { useUISetting } from "@/context/UISettingsProvider.tsx";

const DEFAULT_THEME_COLOR = "#0891b2";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

type Rgb = {
  r: number;
  g: number;
  b: number;
};

const clamp = (value: number, min = 0, max = 255) => Math.min(max, Math.max(min, value));

const hexToRgb = (hex: string): Rgb | null => {
  if (!HEX_COLOR_RE.test(hex)) return null;
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
};

const rgbToHex = ({ r, g, b }: Rgb) =>
  `#${[r, g, b].map((value) => clamp(Math.round(value)).toString(16).padStart(2, "0")).join("")}`;

const mix = (a: Rgb, b: Rgb, weight: number): Rgb => ({
  r: a.r + (b.r - a.r) * weight,
  g: a.g + (b.g - a.g) * weight,
  b: a.b + (b.b - a.b) * weight,
});

const buildPrimaryScale = (baseHex: string) => {
  const base = hexToRgb(baseHex) ?? hexToRgb(DEFAULT_THEME_COLOR)!;
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };

  return {
    50: rgbToHex(mix(base, white, 0.92)),
    100: rgbToHex(mix(base, white, 0.82)),
    200: rgbToHex(mix(base, white, 0.65)),
    300: rgbToHex(mix(base, white, 0.45)),
    400: rgbToHex(mix(base, white, 0.22)),
    500: rgbToHex(base),
    600: rgbToHex(mix(base, black, 0.08)),
    700: rgbToHex(mix(base, black, 0.24)),
    800: rgbToHex(mix(base, black, 0.38)),
    900: rgbToHex(mix(base, black, 0.52)),
  };
};

const slateShades = [
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
  "950",
] as const;
type SlateShade = (typeof slateShades)[number];

const baseSlateScale: Record<SlateShade, string> = {
  50: "#f8fafc",
  100: "#f1f5f9",
  200: "#e2e8f0",
  300: "#cbd5e1",
  400: "#94a3b8",
  500: "#64748b",
  600: "#475569",
  700: "#334155",
  800: "#1e293b",
  900: "#0f172a",
  950: "#020617",
};

const slateThemeMixWeights: Record<SlateShade, number> = {
  50: 0.02,
  100: 0.024,
  200: 0.03,
  300: 0.038,
  400: 0.048,
  500: 0.055,
  600: 0.06,
  700: 0.05,
  800: 0.045,
  900: 0.035,
  950: 0.025,
};

const buildSlateScale = (baseHex: string) => {
  const theme = hexToRgb(baseHex) ?? hexToRgb(DEFAULT_THEME_COLOR)!;
  const black = { r: 0, g: 0, b: 0 };

  return Object.fromEntries(
    slateShades.map((shade) => {
      const themeTone =
        Number(shade) >= 800
          ? mix(theme, black, 0.58)
          : Number(shade) >= 700
            ? mix(theme, black, 0.42)
            : theme;

      return [
        shade,
        rgbToHex(mix(hexToRgb(baseSlateScale[shade])!, themeTone, slateThemeMixWeights[shade])),
      ];
    })
  ) as Record<SlateShade, string>;
};

const contrastText = (hex: string) => {
  const rgb = hexToRgb(hex) ?? hexToRgb(DEFAULT_THEME_COLOR)!;
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.62 ? "#111827" : "#ffffff";
};

/** Renders the global appearance effects component. */
const GlobalAppearanceEffects: React.FC = () => {
  const selectedThemeColor = useUISetting((settings) => settings.themeColor);
  const backgroundImageBase64 = useUISetting((settings) => settings.backgroundImageBase64);
  const selectedBackgroundOpacity = useUISetting((settings) => settings.backgroundImageOpacity);
  const themeColor = HEX_COLOR_RE.test(selectedThemeColor)
    ? selectedThemeColor
    : DEFAULT_THEME_COLOR;
  const backgroundOpacity = Math.min(1, Math.max(0, selectedBackgroundOpacity ?? 0.18));
  const primaryScale = useMemo(() => buildPrimaryScale(themeColor), [themeColor]);
  const slateScale = useMemo(() => buildSlateScale(themeColor), [themeColor]);

  useEffect(() => {
    const root = document.documentElement;
    const foreground = contrastText(themeColor);

    Object.entries(primaryScale).forEach(([shade, value]) => {
      root.style.setProperty(`--color-primary-${shade}`, value);
    });
    Object.entries(slateScale).forEach(([shade, value]) => {
      root.style.setProperty(`--color-slate-${shade}`, value);
    });
    root.style.setProperty("--primary", themeColor);
    root.style.setProperty("--primary-foreground", foreground);
    root.style.setProperty("--ring", primaryScale[300]);
    root.style.setProperty("--sidebar-primary", themeColor);
    root.style.setProperty("--sidebar-primary-foreground", foreground);
    root.style.setProperty("--sidebar-ring", primaryScale[300]);
    root.style.setProperty("--selection-background", themeColor);

    return () => {
      Object.keys(primaryScale).forEach((shade) =>
        root.style.removeProperty(`--color-primary-${shade}`)
      );
      Object.keys(slateScale).forEach((shade) =>
        root.style.removeProperty(`--color-slate-${shade}`)
      );
      [
        "--primary",
        "--primary-foreground",
        "--ring",
        "--sidebar-primary",
        "--sidebar-primary-foreground",
        "--sidebar-ring",
        "--selection-background",
      ].forEach((name) => root.style.removeProperty(name));
    };
  }, [primaryScale, slateScale, themeColor]);

  if (!backgroundImageBase64) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-30 pointer-events-none bg-cover bg-center bg-no-repeat"
      style={{
        backgroundImage: `url(${backgroundImageBase64})`,
        opacity: backgroundOpacity,
      }}
    />
  );
};

export { DEFAULT_THEME_COLOR, HEX_COLOR_RE };
export default GlobalAppearanceEffects;
