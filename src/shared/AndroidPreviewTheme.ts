export interface AndroidPreviewTheme {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  primary: string;
  primaryForeground: string;
  border: string;
}

const LIGHT: AndroidPreviewTheme = {
  background: "#ffffff",
  foreground: "#1a1c1f",
  muted: "#f3f3f3",
  mutedForeground: "#6a6b6d",
  primary: "#1a1c1f",
  primaryForeground: "#ffffff",
  border: "#ededed",
};
const DARK: AndroidPreviewTheme = {
  background: "#282828",
  foreground: "#dfdfdf",
  muted: "#282828",
  mutedForeground: "#999999",
  primary: "#dfdfdf",
  primaryForeground: "#181818",
  border: "#373737",
};

/** Resolve the app's hex/rgb tokens to opaque colors understood by Android. */
export function nativeThemeColor(value: string, fallback: string, surface = "#ffffff"): string {
  let channels: number[];
  let alpha = 1;
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value.trim());
  if (hex) {
    const expanded = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    channels = [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16));
    if (expanded.length === 8) alpha = parseInt(expanded.slice(6), 16) / 255;
  } else {
    const rgb = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
    if (!rgb) return fallback;
    const parts = rgb[1].trim().split(/[\s,/]+/);
    if (parts.length < 3 || parts.length > 4 || parts.some((part) => !/^\d*\.?\d+%?$/.test(part)))
      return fallback;
    channels = parts.slice(0, 3).map((part) => parseFloat(part) * (part.endsWith("%") ? 2.55 : 1));
    if (parts[3]) alpha = parseFloat(parts[3]) / (parts[3].endsWith("%") ? 100 : 1);
  }
  if (
    !Number.isFinite(alpha) ||
    alpha < 0 ||
    alpha > 1 ||
    channels.some((v) => !Number.isFinite(v) || v < 0 || v > 255)
  )
    return fallback;
  const base = [1, 3, 5].map((offset) => parseInt(surface.slice(offset, offset + 2), 16));
  return (
    "#" +
    channels
      .map((v, i) =>
        Math.round(v * alpha + base[i] * (1 - alpha))
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  );
}

export function resolveAndroidPreviewTheme(
  read: (token: string) => string,
  dark: boolean
): AndroidPreviewTheme {
  const fallback = dark ? DARK : LIGHT;
  const background = nativeThemeColor(read("--popover"), fallback.background, fallback.background);
  return {
    background,
    foreground: nativeThemeColor(read("--popover-foreground"), fallback.foreground, background),
    muted: nativeThemeColor(read("--secondary"), fallback.muted, background),
    mutedForeground: nativeThemeColor(
      read("--muted-foreground"),
      fallback.mutedForeground,
      background
    ),
    primary: nativeThemeColor(read("--primary"), fallback.primary, background),
    primaryForeground: nativeThemeColor(
      read("--primary-foreground"),
      fallback.primaryForeground,
      background
    ),
    border: nativeThemeColor(read("--border"), fallback.border, background),
  };
}

export function createPreviewThemeSource(
  read: () => AndroidPreviewTheme,
  listen: (refresh: () => void) => () => void
) {
  const listeners = new Set<() => void>();
  let current: AndroidPreviewTheme | undefined;
  let disconnect: (() => void) | undefined;
  const getSnapshot = () => (current ??= read());
  const refresh = () => {
    const next = read();
    if (
      current &&
      Object.keys(next).every(
        (key) =>
          next[key as keyof AndroidPreviewTheme] === current![key as keyof AndroidPreviewTheme]
      )
    )
      return;
    current = next;
    listeners.forEach((notify) => notify());
  };
  return {
    getSnapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      if (!disconnect) {
        disconnect = listen(refresh);
        refresh();
      }
      return () => {
        listeners.delete(notify);
        if (!listeners.size) {
          disconnect?.();
          disconnect = undefined;
          current = undefined;
        }
      };
    },
  };
}

// Cached profile pages share one observer; steady-state frame polls reuse colors.
const themeSource = createPreviewThemeSource(
  () => {
    if (typeof document === "undefined") return LIGHT;
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return resolveAndroidPreviewTheme(
      (token) => style.getPropertyValue(token),
      root.classList.contains("dark")
    );
  },
  (refresh) => {
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    window.addEventListener("focus", refresh);
    return () => {
      observer.disconnect();
      window.removeEventListener("focus", refresh);
    };
  }
);
export const getAndroidPreviewTheme = themeSource.getSnapshot;
export const subscribeAndroidPreviewTheme = themeSource.subscribe;
