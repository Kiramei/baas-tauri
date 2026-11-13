import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";

const mode = process.argv[2];
const consumers = {
  windows: 'export { default } from "@/components/layout/Header.tsx";\nimport "@/styles/index.css";',
  macos: 'export * from "@/transport/factory.ts";',
  linux: 'export { default } from "@/components/layout/WindowTitlebar.tsx";',
};
const adapters = {
  windows: "/src/platform/windows/configurePcProfile.ts",
  macos: "/src/platform/macos/transport.ts",
  linux: "/src/platform/linux/useNativeWindowControls.ts",
};
if (!Object.hasOwn(consumers, mode)) throw new Error("unsupported OS adapter");
const directory = resolve(".cache/ci-frontend-adapters");
const entry = resolve(directory, `${mode}.ts`);
mkdirSync(directory, { recursive: true });
writeFileSync(entry, consumers[mode]);
try {
  let adapterIncluded = false;
  const result = await build({
    mode: "tauri",
    publicDir: false,
    plugins: [{
      name: "check-frontend-adapter-inclusion",
      generateBundle() {
        adapterIncluded = [...this.getModuleIds()].some(id => id.replaceAll("\\", "/").endsWith(adapters[mode]));
      },
    }],
    build: { write: false, lib: { entry, formats: ["es"], fileName: "frontend-adapter" } },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output ?? []);
  if (!adapterIncluded) throw new Error(`${mode} consumer did not include its platform adapter`);
  if (mode === "windows" && !outputs.some(item => item.type === "asset" && item.fileName.endsWith(".css") && /data-window-material\s*=\s*['\"]?acrylic/.test(String(item.source)))) {
    throw new Error("Windows adapter CSS is missing from the client stylesheet");
  }
} finally {
  rmSync(entry, { force: true });
}
