import path from "path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import compression from "vite-plugin-compression";
// import {visualizer} from "rollup-plugin-visualizer";

export default defineConfig(({ mode }) => {
  if (mode === "development" || mode === "production") {
    mode = "webui";
  }
  return {
    base: "/",
    clearScreen: false,
    define: {
      global: "globalThis",
      __WITH_WEBUI__: mode === "webui",
      __WITH_TAURI__: mode === "tauri",
    },
    server: {
      host: "0.0.0.0",
      port: mode === "tauri" ? 8191 : 8192,
      strictPort: true,
    },
    plugins: [
      react(),
      tailwindcss(),
      compression({
        algorithm: "brotliCompress",
        ext: ".br",
        threshold: 1024,
        deleteOriginFile: false,
      }),
      // Consider using this plugin to analyze the chunk :)
      // visualizer({
      //   filename: 'dist/stats.html',
      //   open: true,
      // })
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/framer-motion")) {
              return "motion";
            }

            if (id.includes("node_modules/rehype-highlight")) {
              return "highlight";
            }

            if (id.includes("node_modules/libsodium-wrappers-sumo")) {
              return "libsodium";
            }

            if (
              id.includes("node_modules/remark-gfm") ||
              id.includes("node_modules/react-markdown")
            ) {
              return "markdown";
            }

            if (
              [
                "react",
                "react-dom",
                "i18next",
                "zustand",
                "next-themes",
                "react-window",
                "lucide-react",
                "react-i18next",
                "tailwind-merge",
                "class-variance-authority",
              ].some((pkg) => id.includes(`node_modules/${pkg}`))
            ) {
              return "misc";
            }

            if (
              [
                "sonner",
                "date-fns",
                "react-day-picker",
                "@headlessui/react",
                "@radix-ui/react-popover",
                "@radix-ui/react-select",
                "@radix-ui/react-separator",
                "@radix-ui/react-slot",
                "@radix-ui/react-switch",
                "@radix-ui/react-tabs",
                "@radix-ui/react-tooltip",
              ].some((pkg) => id.includes(`node_modules/${pkg}`))
            ) {
              return "ui";
            }
          },
        },
      },
    },
    resolve: {
      alias: {
        buffer: "buffer",
        "@": path.resolve(__dirname, "src"),
      },
    },
  };
});
