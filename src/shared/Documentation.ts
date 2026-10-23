/** Keep the former Wiki URL override working for existing deployments. */
export const DOCUMENTATION_URL =
  import.meta.env.VITE_BAAS_DOCS_URL ||
  import.meta.env.VITE_BAAS_WIKI_URL ||
  "https://baas.kiramei.moe";

/** Tauri uses the system browser; WebUI keeps the browser's normal link behavior. */
export async function openDocumentation(): Promise<void> {
  if (__WITH_TAURI__) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(DOCUMENTATION_URL);
    return;
  }
  window.open(DOCUMENTATION_URL, "_blank", "noopener,noreferrer");
}
