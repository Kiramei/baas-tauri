import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const read = (file: string) => readFileSync(new URL("../../" + file, import.meta.url), "utf8");

test("current bilingual guides expose plugins, browser deployment and their safety boundaries", () => {
  const implementation = read("src/pages/PluginsPage.tsx");
  for (const locale of ["zh", "en"]) {
    const page = (section: string, name: string) => read(`docs/content/docs/${locale}/${section}/${name}.mdx`);
    for (const [section, name] of [["features", "plugins"], ["guide", "webui"], ["reference", "plugin-api"]]) {
      const meta = JSON.parse(read(`docs/content/docs/${locale}/${section}/meta.json`));
      expect(meta.pages).toContain(name);
      expect(page(section, name).length).toBeGreaterThan(1000);
    }
    const plugins = page("features", "plugins");
    for (const id of ["baas.hoard-ap", "baas.auto-push", "baas.equipment-planner", "baas.inventory-calculator", "baas.home-editor"])
      expect(plugins).toContain(id);
    const api = page("reference", "plugin-api");
    for (const command of ["get_plugin_catalog", "get_plugin_settings", "update_plugin_settings", "set_plugin_enabled",
      "install_plugin", "uninstall_plugin", "run_plugin_action", "get_plugin_job", "cancel_plugin_job"]) {
      expect(implementation).toContain(`"${command}"`);
      expect(api).toContain(command);
    }
    for (const state of ["queued", "running", "succeeded", "failed", "cancelled"]) expect(api).toContain(state);
    for (const value of ["revision", "128 KiB", "64 KiB", "START_NOT_STICKY", "135"])
      expect(api).toContain(value);
    expect(plugins).toContain(locale === "zh" ? "不提供安全沙箱" : "not a security sandbox");
    expect(plugins).toContain(locale === "zh" ? "不会自动执行动作" : "without running an action");
    const webui = page("guide", "webui");
    for (const value of ["127.0.0.1:8191", "127.0.0.1:8190", "auth.key_reset_supported", "no_update = true",
      "BAAS_WEBUI_BIND", "host.docker.internal:5555", "VITE_BAAS_PROXY_TARGET"]) expect(webui).toContain(value);
    expect(page("reference", "release-history")).toContain("## v0.0.9");
    const android = page("guide", "android");
    expect(android).toContain(locale === "zh" ? "不会自动停止调度" : "does not automatically stop scheduling");
    expect(android).not.toContain(locale === "zh" ? "把已有游戏任务移到主显示" : "Move the existing game task to the main display");
    expect(android).toContain(locale === "zh" ? "Android 已移除桌面快捷键分类" : "Android no longer exposes desktop Shortcuts");
  }
});

test("docs root contains only the maintainer README, not process reports", () => {
  const documents = readdirSync(new URL("../", import.meta.url)).filter(file => file.endsWith(".md"));
  expect(documents).toEqual(["README.md"]);
  const samples = JSON.parse(read("docs/evidence/updater-performance-local-2026-10-15.json"));
  expect(samples.scope).toContain("does not measure public network download speed");
});
