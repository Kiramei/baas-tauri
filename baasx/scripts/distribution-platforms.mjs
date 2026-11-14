import { URL } from "node:url";
// OS/CPU spellings are npm's manifest values. ARM32 builds cross-compile on x64.
import { readFileSync } from "node:fs";
const targets = JSON.parse(
  readFileSync(new URL("./distribution-platforms.json", import.meta.url), "utf8")
);
export const platforms = targets.map((platform) => {
  const os = { linux: "Linux", darwin: "macOS", win32: "Windows" }[platform.os];
  return {
    ...platform,
    runtime: platform.runtime ?? "bun",
    packageSuffix: platform.runtime === "node" ? "node" : "bun",
    packageExtension: platform.runtime === "node" ? "-node.tgz" : "-bun.tgz",
    asset: `${os}-${(platform.assetCpu ?? platform.cpu).toUpperCase()}`,
    helper: platform.os === "win32" ? "baasx-runtime.exe" : "baasx-runtime",
    legacyHelper: platform.os === "win32" ? "baas-cli-runtime.exe" : "baas-cli-runtime",
    executable: platform.os === "win32" ? "baasx.exe" : "baasx",
    name: `@kiramei/baasx-${platform.os}-${platform.cpu}`,
  };
});

// These are distribution selection aliases, not host ABI detection. The payload
// requires ARMv7, hard-float and glibc 2.35+. Keep one npm `arm` dependency.
export function platformFor(os, cpu) {
  if (cpu === undefined) {
    const separator = os.indexOf("-");
    if (separator < 0) return undefined;
    cpu = os.slice(separator + 1);
    os = os.slice(0, separator);
  }
  return platforms.find(
    (platform) => platform.os === os && [platform.cpu, ...(platform.aliases ?? [])].includes(cpu)
  );
}
