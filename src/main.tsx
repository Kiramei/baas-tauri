import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "@/App.tsx";
import { initI18n } from "@/shared/I18nTranslator.ts";
import { Buffer } from "buffer";

(globalThis as any).Buffer = Buffer;

const closeSplash = async () => {
  if (!__WITH_TAURI__) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("splash_off");
  } catch (e) {
    console.error("invoke failed:", e);
  }
};

const bootstrap = async () => {
  await initI18n();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  await closeSplash();
};

void bootstrap().catch(console.error);
