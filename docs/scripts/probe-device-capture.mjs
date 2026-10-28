import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDeviceFixture } from "./device-benchmark-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [port, backendArgument, python, serial, emulator] = process.argv.slice(2);
assert.ok(
  port && backendArgument && python && serial && emulator,
  "Usage: node docs/scripts/probe-device-capture.mjs CDP_PORT DISPOSABLE_BACKEND PYTHON SERIAL MUMU_LAUNCHER"
);
const backend = realpathSync(backendArgument);
const nativeProvenance = JSON.parse(
  readFileSync(path.join(root, "docs/public/media/desktop/installer-manifest.json"), "utf8")
);
assert.equal(
  createHash("sha256")
    .update(readFileSync(path.join(backend, "baas-tauri.exe")))
    .digest("hex"),
  nativeProvenance.executableSha256
);
const androidProvenance = JSON.parse(
  readFileSync(path.join(root, "docs/evidence/android-x86-provenance.json"), "utf8")
);
const output = path.join(root, ".cache/docs-benchmarks/device-capture-probe.json");
mkdirSync(path.dirname(output), { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, { noDefaults: true });
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url() === "http://tauri.localhost/");
assert.ok(page);
const report = {
  checkedAt: new Date().toISOString(),
  scope:
    "Actual desktop Python capture adapters against a controlled fixture in the owned Android demo app. Compatibility only; excludes game, Android local/Shizuku capture and steady-state speed claims.",
  backendRevision: "d0a86a089068766ff53682b501b90bee99857a71",
  targetApplicationId: androidProvenance.applicationId,
  targetApkSha256: androidProvenance.apkSha256,
  results: [],
  fixtureRemoved: false,
};
const fixtureOwner = randomUUID();
async function probe(method, fixture = { token: 0, dpr: 1, width: 1, height: 1 }) {
  return await new Promise((resolve) => {
    const args = [
      path.join(root, "docs/scripts/probe-device-capture.py"),
      "--backend",
      backend,
      "--serial",
      serial,
      "--package",
      report.targetApplicationId,
      "--emulator",
      emulator,
      "--cdp-port",
      port,
      "--method",
      method === "preflight" ? "adb" : method,
      "--token",
      String(fixture.token),
      "--dpr",
      String(fixture.dpr),
      "--width",
      String(fixture.width),
      "--height",
      String(fixture.height),
    ];
    if (method === "preflight") args.push("--preflight-only");
    execFile(
      python,
      args,
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        writeFileSync(
          path.join(root, ".cache/docs-benchmarks/probe-" + method + ".log"),
          stdout + "\n" + stderr
        );
        const record = stdout
          .split(/\r?\n/)
          .find((line) => line.startsWith("DOCS_BENCHMARK_JSON:"));
        if (record) resolve(JSON.parse(record.slice("DOCS_BENCHMARK_JSON:".length)));
        else
          resolve({
            method,
            available: false,
            phase: "worker",
            failure: {
              type: error?.killed ? "worker-timeout" : "worker-exit",
              code: error?.code ?? null,
            },
          });
      }
    );
  });
}
try {
  const before = await page.evaluate(async () => ({
    identifier: await window.__TAURI_INTERNALS__.invoke("plugin:app|identifier"),
    visibility: document.visibilityState,
    demo: document.body.innerText.includes("Documentation Demo"),
  }));
  const configuredIdentifier = JSON.parse(
    readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")
  ).identifier;
  assert.equal(before.identifier, configuredIdentifier);
  assert.equal(before.visibility, "visible");
  assert.equal(before.demo, true);
  report.environment = await probe("preflight");
  assert.equal(report.environment.ownedWebViewVerified, true);
  assert.equal(report.environment.installedApkSha256, report.targetApkSha256.toLowerCase());
  report.fixture = await page.evaluate(installDeviceFixture, { owner: fixtureOwner });
  let token = 0;
  for (const method of ["adb", "uiautomator2", "scrcpy", "nemu"]) {
    const fixture = await page.evaluate(
      (value) => window.__docsDeviceFixture.setToken(value),
      ++token
    );
    const result = await probe(method, fixture);
    report.results.push(result);
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(result));
  }
} finally {
  try {
    await page.evaluate((owner) => {
      if (window.__docsDeviceFixture?.owner === owner) window.__docsDeviceFixture.remove();
    }, fixtureOwner);
    report.fixtureRemoved = (await page.locator("#docs-device-benchmark-fixture").count()) === 0;
  } finally {
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    await browser.close();
  }
}
