import path from 'path';
import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite';
import compression from "vite-plugin-compression";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    compression({
      algorithm: "brotliCompress",
      ext: ".br",
      threshold: 1024,
      deleteOriginFile: false
    })
  ],
  clearScreen: false,
  define: {
    global: 'window'
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          motion: [
            'framer-motion'
          ],
          highlight: [
            'rehype-highlight'
          ],
          markdown: [
            'remark-gfm',
            'react-markdown'
          ],
          misc: [
            'react',
            "i18next",
            "zustand",
            'react-dom',
            "next-themes",
            'react-window',
            "lucide-react",
            "react-i18next",
            "tailwind-merge",
            "class-variance-authority"
          ],
          ui: [
            'sonner',
            'date-fns',
            'react-day-picker',
            "@headlessui/react",
            '@radix-ui/react-popover',
            '@radix-ui/react-select',
            '@radix-ui/react-separator',
            '@radix-ui/react-slot',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip'
          ]
        }
      }
    }
  },
  server: {
    port: 8191,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
