import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { platforms } from "../../baasx/scripts/distribution-platforms.mjs";

for (const locale of ["en", "zh"]) {
  test(`${locale} installation guide matches packaged helper names and documents legacy lookup`, () => {
    const guide = readFileSync(new URL(`../content/docs/${locale}/baasx/installation.mdx`, import.meta.url), "utf8");
    expect(guide).toContain("chmod +x baasx runtime/baasx-runtime");
    for (const platform of platforms) {
      expect(platform.helper).toBe(platform.os === "win32" ? "baasx-runtime.exe" : "baasx-runtime");
      expect(guide).toContain(platform.helper);
    }
    expect(guide).toContain("runtime/baas-cli-runtime");
    expect(guide).toContain("BAASX_RUNTIME_HELPER");
    expect(guide).toContain("BAAS_RUNTIME_HELPER");
  });
}
