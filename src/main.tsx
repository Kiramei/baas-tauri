import React from "react";
import ReactDOM from "react-dom/client";

if (!Object.hasOwn) {
  Object.hasOwn = (object: object, property: PropertyKey) =>
    Object.prototype.hasOwnProperty.call(object, property);
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

/** Renders the browser tauri dev fallback component. */
const BrowserTauriDevFallback = () => (
  <div
    style={{
      alignItems: "center",
      background: "#0f172a",
      color: "#e2e8f0",
      display: "flex",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      height: "100vh",
      justifyContent: "center",
      margin: 0,
      padding: 24,
    }}
  >
    <div style={{ maxWidth: 520 }}>
      <h1 style={{ fontSize: 24, marginBottom: 12 }}>BAAS Tauri dev server is running</h1>
      <p style={{ color: "#94a3b8", lineHeight: 1.6, margin: 0 }}>
        Use the BAAS Tauri desktop window for this dev session. The browser URL is only the Vite
        asset server for the Tauri WebView.
      </p>
    </div>
  </div>
);

/** Performs the close splash operation. */
const closeSplash = async () => {
  if (!__WITH_TAURI__) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("splash_off");
  } catch (e) {
    console.error("invoke failed:", e);
  }
};

const runConfiguredBenchmark = async () => {
  if (!__WITH_TAURI_MODE__) return false;
  try {
    const { runConfiguredWebviewCopyBenchmark } = await import(
      "@/transport/tauri-shm/webviewCopyBenchmarkRunner"
    );
    return await runConfiguredWebviewCopyBenchmark();
  } catch {
    return false;
  }
};

/** Handles the bootstrap workflow. */
const bootstrap = async () => {
  if (await runConfiguredBenchmark()) {
    return;
  }

  if (__WITH_TAURI_MODE__ && !__WITH_TAURI__ && !__WITH_ANDROID__) {
    root.render(<BrowserTauriDevFallback />);
    return;
  }

  const [{ default: App }, { initI18n }, { startPlatformServices }] = await Promise.all([
    import("@/platform/App"),
    import("@/shared/I18nTranslator.ts"),
    import("@/platform/startup"),
  ]);

  await initI18n();
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  startPlatformServices();
  void import("buffer").then(({ Buffer }) => {
    (globalThis as any).Buffer = Buffer;
  });

  await closeSplash();
};

void bootstrap().catch(console.error);
