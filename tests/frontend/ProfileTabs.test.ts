import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { reconcileProfileTabs } from "../../src/shared/ProfileTabs";

const configs = {
  original: { name: "Original", server: "CN" },
  safe: { name: "Safe copy", server: "CN" },
  fixture: { name: "Input fixture", server: "JP" },
};
const ids = (tabs: ReturnType<typeof reconcileProfileTabs>) => tabs.map(tab => tab.id);

describe("profile tab reconciliation", () => {
  test("every config is visible without requiring a status snapshot", () => {
    expect(ids(reconcileProfileTabs(configs, []))).toEqual(["original", "safe", "fixture"]);
  });

  test("saved order is honored and unlisted profiles are appended", () => {
    expect(ids(reconcileProfileTabs(configs, ["safe", "original"]))).toEqual(["safe", "original", "fixture"]);
  });

  test("a stale reorder subset cannot drop a newly created profile", () => {
    const previousRender = reconcileProfileTabs({ original: configs.original, safe: configs.safe }, []);
    const staleReorder = previousRender.toReversed();
    expect(ids(reconcileProfileTabs(configs, staleReorder.map(tab => tab.id)))).toEqual(["safe", "original", "fixture"]);
  });

  test("metadata comes from the current config, not stale draggable objects", () => {
    const previousRender = reconcileProfileTabs(configs, []);
    const renamed = { ...configs, fixture: { name: "Renamed fixture", server: "Global" } };
    const next = reconcileProfileTabs(renamed, previousRender.map(tab => tab.id));
    expect(next.at(-1)).toEqual({ id: "fixture", name: "Renamed fixture", server: "Global" });
    expect(previousRender.at(-1)?.name).toBe("Input fixture");
  });

  test("stale reorder entries cannot resurrect a deleted config", () => {
    expect(ids(reconcileProfileTabs({ safe: configs.safe }, ["original", "fixture", "safe"]))).toEqual(["safe"]);
  });

  test("unknown, duplicate, and non-string IDs are removed", () => {
    expect(ids(reconcileProfileTabs(configs, ["missing", "safe", "safe", null, 42, "original"])))
      .toEqual(["safe", "original", "fixture"]);
  });

  test("missing or malformed stored order still exposes every profile", () => {
    for (const order of [null, undefined, "safe", { safe: 1 }]) {
      expect(ids(reconcileProfileTabs(configs, order))).toEqual(["original", "safe", "fixture"]);
    }
  });

  test("default profile names are normalized without changing the config store", () => {
    const source = { added: { name: "新的配置", server: "CN" } };
    expect(reconcileProfileTabs(source, ["added"])).toEqual([{ id: "added", name: "New Profile", server: "CN" }]);
    expect(source.added.name).toBe("新的配置");
  });

  test("Header does not gate profile visibility on optional status membership", () => {
    const source = readFileSync(new URL("../../src/components/layout/Header.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("tab.id in runningByProfile");
    expect(source).toContain("const reconciled = reconcileProfileTabs(");
    expect(source).toContain("reconciled.map((tab) => tab.id)");
  });
});
