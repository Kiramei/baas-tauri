import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureTarget } from "./capture-target.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [platform, port, runtimeArgument, python, serial] = process.argv.slice(2);
const target = platform === "desktop" ? captureTarget(root) : null;
const theme = target?.theme ?? "light";
const publicRoot = target?.publicRoot ?? path.join(root, "docs/public");
assert.ok(["desktop", "android"].includes(platform) && port && runtimeArgument && python,
  "Usage: capture-conditional-config.mjs PLATFORM CDP_PORT DISPOSABLE_BACKEND PYTHON [ADB_SERIAL]");
const runtime = realpathSync(runtimeArgument);
const demoName = platform === "desktop" ? "Schale Demo" : "Documentation Demo";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const desktopProof = JSON.parse(readFileSync(path.join(root, "docs/public/media/desktop/installer-manifest.json")));
const androidProof = JSON.parse(readFileSync(path.join(root, "docs/evidence/android-x86-provenance.json")));
const dictionaries = Object.fromEntries(["en", "zh"].map((locale) =>
  [locale, JSON.parse(readFileSync(path.join(root, "public/locales", locale + ".json")))]));
const fields = [
  "cafe_reward_has_no2_cafe", "cafe_reward_invite1_criterion", "cafe_reward_invite2_criterion",
  "cafe_reward_invite1_starred_student_position", "cafe_reward_invite2_starred_student_position",
  "favorStudent1", "favorStudent2", "lesson_enableInviteFavorStudent", "lesson_favorStudent",
  "createTime", "create_phase", "create_phase_1_select_item_rule", "create_phase_2_select_item_rule",
  "create_phase_3_select_item_rule", "createPriority_phase1", "createPriority_phase2", "createPriority_phase3",
  "choose_team_method", "preset_team_attribute", "side_team_attribute", "mainlinePriority", "hardPriority",
  "scrimmage_times", "special_task_times", "activity_sweep_times",
  "explore_normal_task_list", "explore_hard_task_list",
];
const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, { noDefaults: true });
const page = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === "http://tauri.localhost/");
assert.ok(page, "Expected the isolated native WebView");
page.setDefaultTimeout(12000);
page.on("pageerror", (error) => console.error("Native page error:", error.message));
let locale = await page.getByRole("button", { name: dictionaries.zh.nav.settings, exact: true }).filter({ visible: true }).count() ? "zh" : "en";
const originalLocale = locale;
const t = (key) => {
  const value = key.split(".").reduce((value, part) => value?.[part], dictionaries[locale]);
  const result = typeof value === "object" ? value?.$self : value;
  assert.equal(typeof result, "string", "Unknown translation: " + key);
  return result;
};
const button = (name, scope = page) => scope.getByRole("button", { name, exact: true }).filter({ visible: true });
const panel = () => page.locator(".configuration-detail").filter({ visible: true });
const report = { capturedAt: new Date().toISOString(), platform,
  captureScriptSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
  nodeVersion: process.version,
  sourceRevision: platform === "desktop" ? desktopProof.sourceRevision : androidProof.sourceRevision,
  executableOrApkSha256: platform === "desktop" ? desktopProof.executableSha256 : androidProof.apkSha256.toLowerCase(),
  scope: "Actual native UI with reversible demo configuration edits; no game input or scheduler execution",
  shots: [], checks: [], recordings: [], scenariosCompleted: false, restored: false };
const destination = path.join(publicRoot, "media", platform, "conditional-manifest.json");
mkdirSync(path.dirname(destination), { recursive: true });
const cache = path.join(root, ".cache/docs-conditional", platform + "-" + randomUUID());
mkdirSync(cache, { recursive: true });
const save = () => writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
const check = (name, details = {}) => report.checks.push({ locale, name, ...details, passed: true });
let initial;

async function attachStore() {
  const started = Date.now();
  for (;;) {
    const ready = await page.evaluate(async () => {
      const urls = [...document.querySelectorAll("script[type=module][src]")].map((node) => node.src);
      urls.push(...performance.getEntriesByType("resource").map((entry) => entry.name)
        .filter((url) => url.startsWith(location.origin + "/assets/WebsocketStore-") && url.endsWith(".js")));
      for (const url of new Set(urls)) {
        for (const value of Object.values(await import(url))) {
          if (typeof value?.getState === "function" && value.getState()._all_data_initialized && value.getState()._auth_phase === "authenticated") return true;
        }
      }
      return false;
    });
    if (ready) break;
    assert.ok(Date.now() - started < 60000, "Native store did not become ready");
    const enter = page.getByRole("button", { name: dictionaries[locale].installer.enter, exact: true }).filter({ visible: true });
    if (await enter.count()) await enter.click();
    await page.waitForTimeout(500);
  }
  return page.evaluate(async ({ demoName, fields }) => {
    const urls = [...document.querySelectorAll("script[type=module][src]")].map((node) => node.src);
    urls.push(...performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((url) => url.startsWith(location.origin + "/assets/WebsocketStore-") && url.endsWith(".js")));
    const stores = new Set();
    for (const url of new Set(urls)) {
      for (const value of Object.values(await import(url))) {
        if (typeof value?.getState !== "function") continue;
        const state = value.getState();
        if (typeof state.trigger === "function" && state._all_data_initialized && state._auth_phase === "authenticated") stores.add(value);
      }
    }
    if (stores.size !== 1) throw new Error("Expected one existing authenticated production store");
    const store = [...stores][0];
    const state = store.getState();
    if (Object.values(state.statusStore).some((status) => status.running)) throw new Error("Tasks are running");
    if (Object.values(state.configStore).some((config) => config.autostart)) throw new Error("Autostart is enabled");
    const profiles = Object.entries(state.configStore).filter(([, config]) => config.name === demoName);
    if (profiles.length !== 1) throw new Error("Expected the named demo profile");
    const [id, config] = profiles[0];
    if (state.eventStore[id].length !== 26 || state.eventStore[id].some((event) => event.enabled)) throw new Error("Demo tasks must all be disabled");
    if (!fields.every((field) => Object.hasOwn(config, field))) throw new Error("A required source field is missing");
    window.__docsConditionalStore = store;
    window.__docsConditionalProfile = id;
    const lang = ({ "日服": "JP", "国际服": "Global", "国际服青少年": "Global", "韩国ONE": "Global", "Steam国际服": "Global", "B服": "CN", "官服": "CN" })[config.server];
    if (!lang) throw new Error("Unknown game locale");
    const staticConfig = state.staticStore;
    const nodeDefaults = staticConfig.create_default_priority?.[lang];
    const recommendation = Object.entries(staticConfig.create_phase2_recommended_priority ?? {})
      .find(([, indexes]) => indexes.some((index) => index >= 0 && index < (nodeDefaults?.phase2?.length ?? 0)));
    return { id, values: Object.fromEntries(fields.map((field) => [field, config[field]])),
      protectedProfiles: Object.entries(state.configStore).filter(([other]) => other !== id).map(([, value]) => JSON.stringify(value)),
      nodeDefaults, recommendation,
      students: (staticConfig.student_names ?? []).map((value) => typeof value === "string" ? value : value[lang + "_name"]),
      eventSnapshot: JSON.stringify(state.eventStore[id]),
      hardMaterials: staticConfig.hard_task_student_material ?? [],
      hardMaximum: staticConfig.explore_hard_task_region_range?.[1],
      demoName, lang, profileCount: Object.keys(state.configStore).length };
  }, { demoName, fields });
}
async function config() {
  return page.evaluate(() => window.__docsConditionalStore.getState().configStore[window.__docsConditionalProfile]);
}
async function waitFields(expected) {
  await page.waitForFunction((expected) => {
    const state = window.__docsConditionalStore.getState();
    const config = state.configStore[window.__docsConditionalProfile];
    return Object.entries(expected).every(([key, value]) => JSON.stringify(config[key]) === JSON.stringify(value));
  }, expected);
}
async function patch(expected) {
  await page.evaluate((expected) => window.__docsConditionalStore.getState().modify(window.__docsConditionalProfile + "::config", expected), expected);
  await waitFields(expected);
  await page.waitForTimeout(100);
}
async function home() {
  await page.keyboard.press("Escape");
  await button(t("nav.home")).click();
  await page.waitForTimeout(650);
}
async function category(key, kind = "configuration") {
  await button(t("nav." + kind)).click();
  const label = t(kind + ".categories");
  const nav = page.getByRole("navigation", { name: label, exact: true }).filter({ visible: true });
  if (await nav.count()) await button(t(key), nav).click();
  else {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: t(key), exact: true }).click();
  }
  if (kind === "configuration") {
    await page.locator(".configuration-detail-heading").filter({ visible: true }).waitFor();
    assert.ok((await page.locator(".configuration-detail-heading").filter({ visible: true }).innerText()).includes(demoName));
  }
}
async function setLocale(next) {
  if (locale === next) return;
  await category("settings.sections.general", "settings");
  await page.getByRole("combobox", { name: t("language"), exact: true }).click();
  await page.getByRole("option", { name: t("language." + (next === "zh" ? "chinese" : "english")), exact: true }).click();
  locale = next;
}
async function select(label, option) {
  await page.getByRole("combobox", { name: label, exact: true }).filter({ visible: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function tab(key) {
  await panel().getByRole("tab", { name: t(key), exact: true }).click();
}
async function undo(redo = false) {
  await page.getByRole("group", { name: t("configuration.history"), exact: true }).filter({ visible: true })
    .getByRole("button", { name: t(redo ? "edit.redo" : "edit.undo"), exact: true }).click();
}
async function seed(values) {
  await home();
  await patch(values);
}

async function imageBytes() {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), theme === "dark");
  assert.equal(await page.evaluate(() => document.visibilityState), "visible");
  await page.waitForTimeout(180);
  const privateExpression = /[a-z]:[\\/]|baas-shm-[a-f0-9-]+|\b(?:password|token|secret|cdk)\s*[=:]\s*\S+/i;
  try {
    await page.locator("input,textarea,.xterm-rows > div,.font-mono,[role=tooltip]").evaluateAll((nodes, pattern) => {
      const expression = new RegExp(pattern, "i");
      for (const node of nodes) {
        if (!node.getClientRects().length || !expression.test("value" in node ? node.value : node.textContent)) continue;
        node.dataset.docsConditionalFilter = node.style.getPropertyValue("filter");
        node.dataset.docsConditionalPriority = node.style.getPropertyPriority("filter");
        node.style.setProperty("filter", "blur(12px)", "important");
        if (getComputedStyle(node).filter !== "blur(12px)") throw new Error("Privacy blur overridden");
      }
    }, privateExpression.source);
    const modal = page.locator(".modal-surface").filter({ visible: true });
    if (await modal.count()) return await modal.last().screenshot();
    if (platform === "android") return await page.screenshot();
    const bounds = await panel().boundingBox();
    assert.ok(bounds);
    const extra = await page.locator("[role=listbox],.priority-editor-picker").filter({ visible: true }).all();
    let right = bounds.x + bounds.width, bottom = bounds.y + bounds.height;
    for (const element of extra) {
      const box = await element.boundingBox();
      if (box) { right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height); }
    }
    const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const top = Math.max(bounds.y, 44);
    return await page.screenshot({ clip: { x: bounds.x, y: top, width: Math.min(right, view.width) - bounds.x,
      height: Math.min(bottom, view.height) - top } });
  } finally {
    await page.locator("[data-docs-conditional-filter]").evaluateAll((nodes) => {
      for (const node of nodes) {
        node.style.setProperty("filter", node.dataset.docsConditionalFilter || "", node.dataset.docsConditionalPriority || "");
        delete node.dataset.docsConditionalFilter;
        delete node.dataset.docsConditionalPriority;
      }
    });
  }
}
async function capture(state) {
  await page.mouse.move(20, 45);
  const file = `media/${platform}/${locale}/conditional-${state}.png`;
  const png = await imageBytes();
  writeFileSync(path.join(publicRoot, file), png);
  report.shots.push({ file, locale, state, native: true, theme, sha256: digest(png),
    width: png.readUInt32BE(16), height: png.readUInt32BE(20),
    region: platform === "desktop" ? "Visible configuration panel / active native modal" : "Native viewport / active native modal",
    privacy: "Demo data; sensitive path/IPC/credential text receives a temporary local 12px blur baked into PNG pixels" });
  save();
  console.log(platform + "/" + locale + "/" + state);
}
async function studentDialog() {
  const dialog = page.locator(".modal-surface").filter({ visible: true });
  await dialog.waitFor();
  return dialog;
}
async function cafe() {
  await seed({ cafe_reward_has_no2_cafe: false, cafe_reward_invite1_criterion: "name",
    cafe_reward_invite2_criterion: "starred", cafe_reward_invite2_starred_student_position: 3,
    favorStudent1: [] });
  await category("cafe");
  assert.equal(await panel().getByRole("tab").count(), 2);
  await tab("cafe.cafe1Settings");
  await button(t("student.add"), panel()).click();
  let dialog = await studentDialog();
  const names = initial.students.filter((name) => typeof name === "string" && name.trim()).slice(0, 2);
  assert.equal(names.length, 2);
  await button(names[0], dialog).click();
  await waitFields({ favorStudent1: [names[0]] });
  await dialog.getByRole("searchbox").fill(names[0]);
  await page.waitForTimeout(100);
  await capture("cafe-student-search");
  await button(t("common.close"), dialog).click();
  await button(t("student.add"), panel()).click();
  dialog = await studentDialog();
  assert.equal(await dialog.getByRole("searchbox").inputValue(), names[0]);
  await dialog.getByRole("searchbox").fill("docs-no-matching-student");
  await page.waitForTimeout(100);
  assert.equal(await dialog.getByRole("button").count(), 1);
  await capture("cafe-student-empty");
  await dialog.getByRole("searchbox").fill("");
  await button(names[1], dialog).click();
  await waitFields({ favorStudent1: names });
  await button(t("common.close"), dialog).click();
  await capture("cafe-named");
  check("student selection appends immediately, modal search persists after reopening and clearing restores results");
  await tab("cafe.basicSettings");
  await page.getByRole("switch", { name: t("cafe.hasNo2Cafe"), exact: true }).click();
  await waitFields({ cafe_reward_has_no2_cafe: true });
  await tab("cafe.cafe2Settings");
  await undo();
  await waitFields({ cafe_reward_has_no2_cafe: false });
  assert.equal(await panel().getByRole("tab").count(), 2);
  assert.equal(await panel().getByRole("tab", { name: t("cafe.basicSettings"), exact: true }).getAttribute("aria-selected"), "true");
  await undo(true);
  await waitFields({ cafe_reward_has_no2_cafe: true });
  await tab("cafe.cafe2Settings");
  await page.getByRole("combobox", { name: t("cafe.starredPosition"), exact: true }).click();
  assert.equal(await page.getByRole("option").count(), 5);
  await capture("cafe-starred");
  await page.getByRole("option", { name: "5", exact: true }).click();
  await waitFields({ cafe_reward_invite2_starred_student_position: 5 });
  assert.equal((await config()).cafe_reward_invite1_criterion, "name");
  check("second Cafe tab follows undo/redo; five starred positions and per-Cafe values stay independent");
}
async function recordPriority(list) {
  if (platform !== "desktop") return;
  const frames = path.join(cache, locale + "-priority");
  mkdirSync(frames, { recursive: true });
  let index = 0;
  const record = async (count) => {
    for (let item = 0; item < count; item++) {
      writeFileSync(path.join(frames, String(index++).padStart(3, "0") + ".png"), await imageBytes());
      await page.waitForTimeout(70);
    }
  };
  await capture("craft-priority-still");
  await record(4);
  const handle = panel().locator(".priority-editor-handle").first();
  await handle.focus();
  await page.keyboard.press("Space");
  await record(3);
  await page.keyboard.press("ArrowDown");
  await record(4);
  assert.deepEqual((await config()).createPriority_phase2, list);
  await page.keyboard.press("Enter");
  const moved = [list[1], list[0], ...list.slice(2)];
  await waitFields({ createPriority_phase2: moved });
  await record(5);
  await undo();
  await waitFields({ createPriority_phase2: list });
  await record(5);
  const file = `media/desktop/${locale}/conditional-priority-reorder.gif`;
  execFileSync(python, [path.join(root, "docs/scripts/encode-demo.py"), frames, path.join(publicRoot, file)], { windowsHide: true });
  report.recordings.push({ file, locale, native: true, theme, sha256: digest(readFileSync(path.join(publicRoot, file))),
    frames: index, actions: ["pick up handle", "preview a new position", "commit", "automatic save", "undo and verify original order"],
    playbackFrameMs: 160, gameInputSent: false });
}
async function crafting() {
  const list = initial.nodeDefaults.phase2.slice(0, 3);
  assert.equal(list.length, 3);
  await seed({ create_phase: 1, createTime: "1", createPriority_phase2: list });
  await category("artifact");
  await tab("artifact.global");
  await select(t("artifact.phaseCount"), "3");
  await waitFields({ create_phase: 3 });
  await tab("artifact.phase3");
  await undo();
  await waitFields({ create_phase: 1 });
  assert.equal(await panel().getByRole("tab").count(), 2);
  assert.equal(await panel().getByRole("tab", { name: t("artifact.global"), exact: true }).getAttribute("aria-selected"), "true");
  await undo(true);
  await waitFields({ create_phase: 3 });
  await tab("artifact.phase3");
  await page.getByRole("combobox", { name: t("artifact.materialSelect"), exact: true }).click();
  assert.equal(await page.getByRole("option").count(), 3);
  await capture("craft-phase3-materials");
  await page.keyboard.press("Escape");
  await tab("artifact.phase2");
  await page.getByRole("combobox", { name: t("artifact.materialSelect"), exact: true }).click();
  assert.equal(await page.getByRole("option").count(), 7);
  await capture("craft-phase2-materials");
  await page.keyboard.press("Escape");
  check("stage count follows undo/redo; phase 2 exposes seven rules and phase 3 exposes three");
  await button(t("artifact.selectStudent"), panel()).click();
  const dialog = await studentDialog();
  const [name, indexes] = initial.recommendation;
  await dialog.getByRole("searchbox").fill(name);
  await capture("craft-recommendation");
  await button(name, dialog).click();
  const defaults = initial.nodeDefaults.phase2;
  const expected = [...indexes.filter((index) => index >= 0 && index < defaults.length).map((index) => defaults[index]),
    ...defaults.filter((_, index) => !indexes.includes(index))];
  await waitFields({ createPriority_phase2: expected });
  await capture("craft-recommended-priority");
  await undo();
  await waitFields({ createPriority_phase2: list });
  check("student recommendation replaces phase 2 with recommended nodes followed by remaining defaults; undo restores custom order");
  const handle = panel().locator(".priority-editor-handle").first();
  await handle.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  assert.deepEqual((await config()).createPriority_phase2, list);
  await page.keyboard.press("Escape");
  assert.deepEqual(await panel().locator(".priority-editor-name").allTextContents(), list);
  await recordPriority(list);
  await button(t("friendlyPriority.selectNodes"), panel()).click();
  await capture("craft-node-picker");
  await page.keyboard.press("Escape");
  check("priority keyboard preview does not persist; Escape cancels it; committed reorder and undo restore exact labels");
  await tab("artifact.global");
  const count = page.getByRole("spinbutton", { name: t("artifact.createTime"), exact: true });
  await count.fill("11");
  await page.waitForTimeout(800);
  assert.equal(await count.getAttribute("aria-invalid"), "true");
  assert.equal((await config()).createTime, "1");
  await capture("craft-invalid-count");
  await undo();
  assert.equal(await count.inputValue(), "1");
  check("invalid crafting count remains local and Undo returns to the saved value");
}
async function team() {
  await home();
  await category("team");
  await select(t("team.chooseMethod"), t("team.preset"));
  await waitFields({ choose_team_method: "preset" });
  const preset = (await config()).preset_team_attribute;
  assert.ok(preset.length && preset[0].length);
  await capture("team-preset");
  await page.getByRole("combobox", { name: t("team.chooseMethod") + " 1 / 1", exact: true }).click();
  assert.equal(await page.getByRole("option").count(), 5);
  await capture("team-preset-cell");
  await page.keyboard.press("Escape");
  await select(t("team.chooseMethod"), t("team.order"));
  await waitFields({ choose_team_method: "order" });
  assert.equal(await panel().getByRole("combobox").count(), 1);
  assert.deepEqual((await config()).preset_team_attribute, preset);
  await capture("team-order");
  check("preset grid follows stored dimensions; five attributes; order mode hides both grids without changing them", { presetRows: preset.length });
}
async function lesson() {
  await seed({ lesson_enableInviteFavorStudent: false, lesson_favorStudent: [] });
  await category("schedule");
  assert.equal(await button(t("common.add"), panel()).count(), 0);
  const enabled = page.getByRole("switch", { name: t("lesson.enableFavorStudent"), exact: true });
  await enabled.click();
  await waitFields({ lesson_enableInviteFavorStudent: true });
  await button(t("common.add"), panel()).click();
  const dialog = await studentDialog();
  const names = [...new Set(initial.students.filter((name) => typeof name === "string" && name.trim()))].slice(0, 2);
  for (const name of names) {
    await dialog.getByRole("searchbox").fill(name);
    await button(name, dialog).click();
  }
  await waitFields({ lesson_favorStudent: names });
  await capture("lesson-student-search");
  await button(t("common.close"), dialog).click();
  await enabled.click();
  await waitFields({ lesson_enableInviteFavorStudent: false });
  assert.equal(await button(t("common.add"), panel()).count(), 0);
  assert.deepEqual((await config()).lesson_favorStudent, names);
  await undo();
  await waitFields({ lesson_enableInviteFavorStudent: true });
  await capture("lesson-students");
  check("lesson preference visibility follows toggle and Undo; disabling retains ordered student names");
}
async function sweeps() {
  await seed({ mainlinePriority: "1-1-3", hardPriority: "", scrimmage_times: "0,0,0" });
  await category("dailySweep");
  await tab("stage.dailyTab");
  const normal = panel().getByRole("group", { name: t("stage.normalLabel"), exact: true });
  const count = normal.getByRole("spinbutton");
  await count.fill("");
  await page.waitForTimeout(800);
  assert.equal(await count.getAttribute("aria-invalid"), "true");
  assert.equal((await config()).mainlinePriority, "1-1-3");
  await capture("sweep-invalid-count");
  await count.fill("3");
  const names = [...new Set(initial.hardMaterials.map(([, name]) => name))];
  const name = names.find((name) => initial.hardMaterials.filter(([, item]) => item === name).every(([stage]) => {
    const match = /^(\d+)-(\d+)$/.exec(stage);
    return match && Number(match[1]) <= initial.hardMaximum && Number(match[2]) <= 3;
  }));
  assert.ok(name);
  const stages = [...new Set(initial.hardMaterials.filter(([, item]) => item === name).map(([stage]) => stage))];
  const expected = stages.map((stage) => stage + "-3").join(", ");
  await button(t("stage.selectStudent"), panel()).click();
  let dialog = await studentDialog();
  await dialog.getByRole("searchbox").fill(name);
  await capture("sweep-student-search");
  await button(name, dialog).click();
  await waitFields({ hardPriority: expected });
  await capture("sweep-student-stages");
  await button(t("stage.selectStudent"), panel()).click();
  dialog = await studentDialog();
  await button(name, dialog).click();
  await page.waitForTimeout(650);
  assert.equal((await config()).hardPriority, expected);
  await undo();
  await waitFields({ hardPriority: "" });
  check("empty sweep count remains local; student choice adds all drop stages once at count three and Undo restores empty plan", { addedStages: stages.length });
  await seed({ mainlinePriority: "legacy-plan", scrimmage_times: "legacy-count" });
  await category("dailySweep");
  await tab("stage.dailyTab");
  await normal.locator("code").filter({ hasText: "legacy-plan" }).waitFor();
  await capture("sweep-legacy-plan");
  await normal.getByRole("button", { name: new RegExp(t("sweepPlan.remove") + "$") }).click();
  await waitFields({ mainlinePriority: "" });
  await undo();
  await waitFields({ mainlinePriority: "legacy-plan" });
  await tab("stage.sweepTab");
  const replace = button(t("configurationCounts.replace"), panel());
  assert.equal(await replace.count(), 1);
  await replace.scrollIntoViewIfNeeded();
  await capture("sweep-legacy-count");
  await replace.click();
  await waitFields({ scrimmage_times: "0,0,0" });
  await undo();
  await waitFields({ scrimmage_times: "legacy-count" });
  check("unknown plan and count tokens remain visible; explicit row deletion or count replacement is undoable");
}
async function exploration() {
  await seed({ explore_normal_task_list: "250-9,legacy-plan" });
  await category("stage");
  await tab("stage.exploreTab");
  const normal = panel().getByRole("group", { name: t("stage.normalTask"), exact: true });
  assert.equal(await normal.locator("li").count(), 2);
  const first = normal.locator("li").first();
  assert.ok((await first.innerText()).includes("250"));
  const mission = first.getByRole("combobox").nth(1);
  await mission.click();
  assert.ok(await page.getByRole("option", { name: /9/ }).count());
  await capture("explore-legacy-mission");
  await page.keyboard.press("Escape");
  await button(t("common.delete") + ": legacy-plan", normal).click();
  await waitFields({ explore_normal_task_list: "250-9" });
  await undo();
  await waitFields({ explore_normal_task_list: "250-9,legacy-plan" });
  await capture("explore-legacy-plan");
  check("exploration retains saved chapters and missions outside current choices and preserves unknown raw rows; deletion can be undone");
}

try {
  if (platform === "desktop") {
    await target.verify(page);
    assert.equal(digest(readFileSync(path.join(runtime, "baas-tauri.exe"))), desktopProof.executableSha256);
    const storage = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("updater_get_storage_state"));
    assert.equal(storage.portable, true);
    assert.equal(realpathSync(path.dirname(storage.storageFilePath)), runtime);
    report.runtimeOwnerVerified = true;
  } else {
    assert.ok(serial);
    const output = execFileSync(python, [path.join(root, "docs/scripts/probe-device-capture.py"), "--preflight-only",
      "--backend", runtime, "--serial", serial, "--package", androidProof.applicationId,
      "--emulator", "C:/Program Files/Netease/MuMu/nx_main/MuMuNxMain.exe", "--cdp-port", port], { encoding: "utf8", windowsHide: true });
    const result = JSON.parse(output.split("DOCS_BENCHMARK_JSON:").at(-1));
    assert.equal(result.installedApkSha256, androidProof.apkSha256.toLowerCase());
    report.runtimeOwnerVerified = result.ownedWebViewVerified && result.ownedAppForeground;
    assert.equal(report.runtimeOwnerVerified, true);
  }
  initial = await attachStore();
  writeFileSync(path.join(cache, "backup.json"), JSON.stringify(initial, null, 2));
  report.originalFieldsSha256 = digest(JSON.stringify(initial.values));
  await page.locator("[id='tab-" + initial.id + "']").filter({ visible: true }).click();
  for (const next of ["en", "zh"]) {
    await setLocale(next);
    await category("settings.sections.appearance", "settings");
    await page.getByRole("group", { name: t("common.theme"), exact: true })
      .getByRole("button", { name: t(`common.theme.${theme}`), exact: true }).click();
    await home();
    await page.reload();
    await attachStore();
    await page.locator("[id='tab-" + initial.id + "']").filter({ visible: true }).click();
    await cafe();
    await crafting();
    await team();
    await lesson();
    await sweeps();
    await exploration();
  }
  report.scenariosCompleted = true;
} catch (error) {
  console.error("Conditional capture failed:", error);
  writeFileSync(path.join(cache, "failure.txt"), await page.locator("body").innerText());
  await page.screenshot({ path: path.join(cache, "failure.png") });
  throw error;
} finally {
  try {
    if (initial) {
      await home();
      await page.reload();
      await page.waitForTimeout(1000);
      await attachStore();
      await patch(initial.values);
      await page.reload();
      await page.waitForTimeout(1000);
      const restored = await attachStore();
      assert.deepEqual(restored.values, initial.values);
      assert.deepEqual(restored.protectedProfiles, initial.protectedProfiles);
      assert.equal(restored.eventSnapshot, initial.eventSnapshot);
      await setLocale(originalLocale);
      await home();
      report.restored = true;
      report.restoredFieldsSha256 = digest(JSON.stringify(restored.values));
      report.protectedProfilesUnchanged = true;
      report.demoEventsUnchanged = true;
      report.completedAt = new Date().toISOString();
      await page.evaluate(() => { delete window.__docsConditionalStore; delete window.__docsConditionalProfile; });
    }
  } finally {
    save();
    await browser.close();
  }
}
