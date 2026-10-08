import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Android retains the original animation until the actual installer commits", () => {
  const loading = readFileSync(new URL("../../src/pages/LoadingPage.tsx", import.meta.url), "utf8");
  expect(loading).toContain('<React.Suspense fallback={null}><StartupShellHandoff><AndroidInstallStepper');
  expect(loading).not.toContain("AndroidPrepareShell");
  expect(loading).not.toContain("正在准备应用…");
  const app = readFileSync(new URL("../../src/android/App.tsx", import.meta.url), "utf8");
  expect(app).toContain("if (__WITH_ANDROID__) return <LoadingPage />;");
  expect(app).toContain("const loadingOpacity = homePainted ? 0 : 1;");
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  expect(html).toContain('class="baas-startup-spinner"');
  const vite = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
  expect(vite).not.toContain("androidStartupShellPlugin");
});
