import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@/lib/i18n.ts";
import { invoke } from "@tauri-apps/api/core";

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await invoke("splash_off");
  } catch (e) {
    console.error("invoke failed:", e);
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
