import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initI18n } from "@/lib/i18n.ts";
import { invoke } from "@tauri-apps/api/core";

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await invoke("splash_off");
  } catch (e) {
    console.error("invoke failed:", e);
  }
});

async function bootstrap() {
  await initI18n();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap().then(undefined);