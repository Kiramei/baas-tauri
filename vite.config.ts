import path from "path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import compression from "vite-plugin-compression";
import { androidCssCompatPlugin } from "./scripts/android-css-compat-vite";
import { asciiJsOutputPlugin } from "./scripts/vite/ascii-js-output";
import { manualChunks } from "./scripts/vite/manual-chunks";
// import { visualizer } from "rollup-plugin-visualizer";

export default defineConfig(({ mode }) => {
  if (mode === "development" || mode === "production") {
    mode = "webui";
  }
  const withTauri = mode === "tauri" || mode === "android";
  const isAndroid = mode === "android";
  return {
    base: "/",
    clearScreen: false,
    define: {
      global: "globalThis",
      __WITH_WEBUI__: mode === "webui",
      __WITH_TAURI__: withTauri,
      __WITH_ANDROID__: isAndroid,
    },
    server: {
      host: mode === "tauri" ? "127.0.0.1" : "0.0.0.0",
      port: withTauri ? 8191 : 8192,
      strictPort: true,
    },
    plugins: [
      react(),
      tailwindcss(),
      androidCssCompatPlugin(isAndroid),
      asciiJsOutputPlugin(isAndroid),
      mode === "webui"
        ? compression({
            algorithm: "brotliCompress",
            ext: ".br",
            threshold: 1024,
            deleteOriginFile: false,
          })
        : undefined,
      // Consider using this plugin to analyze the chunk :)
      // visualizer({
      //   filename: "dist/stats.html",
      //   open: true,
      // }),
    ],
    build: {
      target: isAndroid ? "chrome91" : undefined,
      rolldownOptions: {
        output: {
          manualChunks,
        },
      },
      chunkSizeWarningLimit: 1000,
    },
    resolve: {
      alias: {
        buffer: "buffer",
        "@": path.resolve(__dirname, "src"),
      },
    },
  };
});
