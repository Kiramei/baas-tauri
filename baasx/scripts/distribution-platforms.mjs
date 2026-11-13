import { URL } from "node:url";
// Matrix runners are native. OS/CPU spellings below are npm's package manifest values.
import { readFileSync } from "node:fs";
const targets = JSON.parse(
  readFileSync(new URL("./distribution-platforms.json", import.meta.url), "utf8")
);
export const platforms = targets.map((platform) => {
  const os = { linux: "Linux", darwin: "macOS", win32: "Windows" }[platform.os];
  return {
    ...platform,
    asset: `${os}-${platform.cpu.toUpperCase()}`,
    helper: platform.os === "win32" ? "baas-cli-runtime.exe" : "baas-cli-runtime",
    executable: platform.os === "win32" ? "baasx.exe" : "baasx",
    name: `@kiramei/baasx-${platform.os}-${platform.cpu}`,
  };
});
