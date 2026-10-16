import React, { useEffect, useMemo } from "react";
import { invoke } from "@/shared/TauriInvoke";

import { useUISetting } from "@/context/UISettingsProvider.tsx";

const DEFAULT_THEME_COLOR = "#1a1c1f";
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

const contrastText = (hex: string) => {
  const rgb = hexToRgb(hex) ?? hexToRgb(DEFAULT_THEME_COLOR)!;
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.62 ? "#111827" : "#ffffff";
};

/** Renders the global appearance effects component. */
const GlobalAppearanceEffects: React.FC = () => {
  const minimizeToTray = useUISetting((settings) => settings.minimizeToTray ?? false);
  useEffect(() => {
    if (__WITH_TAURI__ && !__WITH_ANDROID__) {
      void invoke("set_minimize_to_tray", { enabled: minimizeToTray }).catch(console.error);
    }
  }, [minimizeToTray]);
  const selectedThemeColor = useUISetting((settings) => settings.themeColor);
  const backgroundImageBase64 = useUISetting((settings) => settings.backgroundImageBase64);
  const selectedBackgroundOpacity = useUISetting((settings) => settings.backgroundImageOpacity);
  const themeColor = HEX_COLOR_RE.test(selectedThemeColor)
    ? selectedThemeColor
    : DEFAULT_THEME_COLOR;
  const backgroundOpacity = Math.min(1, Math.max(0, selectedBackgroundOpacity ?? 0.18));
  // The standard palette is defined in CSS so it follows light/dark mode. A
  // custom accent affects actions only; it never tints neutral app surfaces.
  const primaryScale = useMemo(
    () => themeColor.toLowerCase() === DEFAULT_THEME_COLOR ? null : buildPrimaryScale(themeColor),
    [themeColor]
  );

  useEffect(() => {
    if (!primaryScale) return;
    const root = document.documentElement;
    const foreground = contrastText(themeColor);

    Object.entries(primaryScale).forEach(([shade, value]) => {
      root.style.setProperty(`--color-primary-${shade}`, value);
    });
    root.style.setProperty("--primary", themeColor);
    root.style.setProperty("--primary-foreground", foreground);
    root.style.setProperty("--ring", primaryScale[300]);
    root.style.setProperty("--sidebar-primary", themeColor);
    root.style.setProperty("--sidebar-primary-foreground", foreground);
    root.style.setProperty("--sidebar-ring", primaryScale[300]);
    root.style.setProperty("--selection-background", themeColor);
    root.style.setProperty("--selection-foreground", foreground);

    return () => {
      Object.keys(primaryScale).forEach((shade) =>
        root.style.removeProperty(`--color-primary-${shade}`)
      );
      [
        "--primary",
        "--primary-foreground",
        "--ring",
        "--sidebar-primary",
        "--sidebar-primary-foreground",
        "--sidebar-ring",
        "--selection-background",
        "--selection-foreground",
      ].forEach((name) => root.style.removeProperty(name));
    };
  }, [primaryScale, themeColor]);

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
