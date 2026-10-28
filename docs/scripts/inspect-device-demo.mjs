import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.connectOverCDP("http://127.0.0.1:" + process.argv[2], {
  noDefaults: true,
});
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url() === "http://tauri.localhost/");
  assert.ok(page, "Expected the owned Android WebView");
  await page.waitForFunction(() => document.body.innerText.includes("Documentation Demo"), null, {
    timeout: 60000,
  });
  const result = await page.evaluate(async () => {
    const stores = new Set();
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter(
        (url) => url.startsWith(location.origin + "/assets/WebsocketStore-") && url.endsWith(".js")
      );
    for (const url of new Set(urls)) {
      for (const value of Object.values(await import(url))) {
        if (typeof value?.getState !== "function") continue;
        const state = value.getState();
        if (
          typeof state?.trigger === "function" &&
          state._all_data_initialized &&
          state._auth_phase === "authenticated"
        )
          stores.add(value);
      }
    }
    if (stores.size !== 1) throw new Error("Expected one existing initialized connection store");
    const state = [...stores][0].getState();
    const demo = Object.entries(state.configStore).find(
      ([, config]) => config.name === "Documentation Demo"
    );
    return {
      auth: state._auth_phase,
      ready: state._all_data_initialized,
      runningSessions: Object.values(state.statusStore).filter((status) => status.running).length,
      profiles: Object.keys(state.configStore).length,
      autostartProfiles: Object.values(state.configStore).filter((config) => config.autostart)
        .length,
      demoProfiles: Object.values(state.configStore).filter(
        (config) => config.name === "Documentation Demo"
      ).length,
      demoEnabledTasks: demo
        ? state.eventStore[demo[0]].filter((event) => event.enabled).length
        : null,
      demoTotalTasks: demo ? state.eventStore[demo[0]].length : null,
      taskSelections: Object.values(state.eventStore).map((events) => ({
        enabled: events.filter((event) => event.enabled).length,
        total: events.length,
      })),
      taskCounterZero: document.body.innerText.includes("0/26"),
      demoPresent: document.body.innerText.includes("Documentation Demo"),
      fixturePresent: !!document.querySelector("#docs-device-benchmark-fixture"),
    };
  });
  assert.equal(result.auth, "authenticated");
  assert.equal(result.ready, true);
  assert.equal(result.runningSessions, 0);
  assert.equal(result.demoProfiles, 1);
  assert.equal(result.autostartProfiles, 0);
  assert.equal(result.demoEnabledTasks, 0);
  assert.equal(result.demoTotalTasks, 26);
  assert.equal(result.fixturePresent, false);
  console.log("DOCS_DEMO_STATE:" + JSON.stringify(result));
} finally {
  await browser.close();
}
