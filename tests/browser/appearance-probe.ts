// Development-only native UI inspection. No script or game commands are sent.
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

export async function windowState() {
  const window = getCurrentWindow();
  return {
    decorated: await window.isDecorated(),
    maximized: await window.isMaximized(),
    minimized: await window.isMinimized(),
    innerSize: await window.innerSize(),
  };
}

export async function resize(width: number, height: number) {
  await getCurrentWindow().setSize(new LogicalSize(width, height));
  await new Promise(resolve => setTimeout(resolve, 300));
  return snapshot();
}

export function snapshot() {
  const root = getComputedStyle(document.documentElement);
  const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
  return {
    theme: document.documentElement.className,
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    titlebar: bounds("[data-window-titlebar]"),
    sidebar: bounds(".app-sidebar"),
    content: bounds("main"),
    font: { family: getComputedStyle(document.body).fontFamily, size: getComputedStyle(document.body).fontSize },
    colors: Object.fromEntries(["--background", "--sidebar", "--foreground", "--primary", "--border"].map(name => [name, root.getPropertyValue(name).trim()])),
    windowControls: [...document.querySelectorAll("[data-window-titlebar] button")].map(button => button.getAttribute("aria-label")),
  };
}
