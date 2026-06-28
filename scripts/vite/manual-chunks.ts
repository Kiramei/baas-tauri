const chunkGroups: Record<string, string[]> = {
  highlight: ["rehype-highlight"],
  libsodium: ["libsodium-wrappers-sumo"],
  markdown: ["remark-gfm", "react-markdown"],
  misc: [
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
  ],
  motion: ["framer-motion"],
  ui: [
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
  ],
};

export const manualChunks = (id: string): string | undefined => {
  if (!id.includes("node_modules")) return undefined;

  for (const [chunk, packages] of Object.entries(chunkGroups)) {
    if (packages.some((pkg) => id.includes(`node_modules/${pkg}`))) {
      return chunk;
    }
  }

  return undefined;
};
