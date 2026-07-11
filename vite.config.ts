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
  const srcRoot = path.resolve(__dirname, "src");
  return {
    base: "/",
    clearScreen: false,
    define: {
      global: "globalThis",
      __WITH_WEBUI__: mode === "webui",
      __WITH_TAURI_MODE__: withTauri,
      __WITH_TAURI__: withTauri
        ? "(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)"
        : false,
      __WITH_ANDROID__: isAndroid,
    },
    server: {
      host: mode === "tauri" ? "127.0.0.1" : "0.0.0.0",
      port: withTauri ? 8191 : 8192,
      strictPort: true,
      warmup: {
        clientFiles: [
          "./src/main.tsx",
          "./src/App.tsx",
          "./src/pages/SetupPage.tsx",
          "./src/pages/LoadingPage.tsx",
          "./src/store/WebsocketStore.ts",
          "./src/shared/I18nTranslator.ts",
        ],
      },
    },
    optimizeDeps: {
      entries: ["index.html", "src/main.tsx"],
      holdUntilCrawlEnd: false,
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
      target: isAndroid ? "chrome64" : undefined,
      rolldownOptions: {
        output: {
          manualChunks,
        },
      },
      chunkSizeWarningLimit: 1000,
    },
    resolve: {
      alias: [
        {
          find: "@/platform/App",
          replacement: isAndroid
            ? path.join(srcRoot, "android", "App.tsx")
            : path.join(srcRoot, "platform", "App.tsx"),
        },
        {
          find: "@/platform/startup",
          replacement: isAndroid
            ? path.join(srcRoot, "android", "startup.ts")
            : path.join(srcRoot, "platform", "startup.ts"),
        },
        { find: "buffer", replacement: "buffer" },
        { find: "@", replacement: srcRoot },
      ],
    },
  };
});
