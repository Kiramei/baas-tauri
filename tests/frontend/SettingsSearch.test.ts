import { describe, expect, test } from "bun:test";
import {
  createSettingsSearchStore,
  findSettingsSearchMatches,
  settingsSearchTerms,
} from "../../src/shared/SettingsSearch";

describe("settings text search", () => {
  test("highlights every literal occurrence and keeps original text offsets", () => {
    expect(findSettingsSearchMatches("空闲时自动更新，所有配置空闲时更新。", "空闲")).toEqual([
      { start: 0, end: 2 },
      { start: 12, end: 14 },
    ]);
    expect(findSettingsSearchMatches("GitHub API and github api", " GITHUB   api ")).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 10 },
      { start: 15, end: 21 },
      { start: 22, end: 25 },
    ]);
  });

  test("search syntax stays literal, including regex metacharacters", () => {
    expect(findSettingsSearchMatches("Use C++ (API) v1.2 [main]", "C++ (API) v1.2 [main]")).toEqual(
      [
        { start: 4, end: 7 },
        { start: 8, end: 13 },
        { start: 14, end: 18 },
        { start: 19, end: 25 },
      ]
    );
    expect(findSettingsSearchMatches("anything", ".* [")).toEqual([]);
  });

  test("empty searches paint nothing and repeated/overlapping terms paint once", () => {
    expect(settingsSearchTerms("   \t \n ")).toEqual([]);
    expect(findSettingsSearchMatches("text", "  ")).toEqual([]);
    expect(settingsSearchTerms("API api API")).toEqual(["api"]);
    expect(findSettingsSearchMatches("background", "back background ground")).toEqual([
      { start: 0, end: 10 },
    ]);
  });
});

describe("settings search focus lifecycle", () => {
  test("focus controls highlighting without discarding the filter query", () => {
    const store = createSettingsSearchStore();
    store.setQuery("空闲");
    expect(store.getSnapshot()).toMatchObject({ query: "空闲", focusedSource: null });
    store.focus("desktop");
    expect(store.getSnapshot().focusedSource).toBe("desktop");
    store.blur("desktop");
    expect(store.getSnapshot()).toMatchObject({ query: "空闲", focusedSource: null });
    store.focus("desktop");
    expect(store.getSnapshot()).toMatchObject({ query: "空闲", focusedSource: "desktop" });
  });

  test("the outgoing responsive input cannot clear the incoming input's focus", () => {
    const store = createSettingsSearchStore();
    store.focus("desktop");
    store.focus("compact");
    store.blur("desktop");
    expect(store.getSnapshot().focusedSource).toBe("compact");
    store.setQuery("new query");
    expect(store.getSnapshot()).toMatchObject({ query: "new query", focusedSource: "compact" });
    store.blur("compact");
    expect(store.getSnapshot().focusedSource).toBeNull();
  });

  test("blur publishes synchronously, no-op events and detached listeners stay quiet", () => {
    const store = createSettingsSearchStore();
    const events: (string | null)[] = [];
    const unsubscribe = store.subscribe(() => events.push(store.getSnapshot().focusedSource));
    store.focus("desktop");
    store.focus("desktop");
    store.blur("compact");
    store.blur("desktop");
    expect(events).toEqual(["desktop", null]);
    unsubscribe();
    store.focus("compact");
    expect(events).toEqual(["desktop", null]);
  });
});

describe("settings search navigation", () => {
  test("selects the first result, cycles forward and backward, and resets for a new query", () => {
    const store = createSettingsSearchStore();
    store.focus("desktop");
    store.setQuery("更新");
    store.setMatches("更新", 3, ["updates"]);
    expect(store.getSnapshot()).toMatchObject({
      activeIndex: 0,
      matchCount: 3,
      matchedSections: ["updates"],
    });
    store.moveSelection(1);
    expect(store.getSnapshot().activeIndex).toBe(1);
    store.moveSelection(1);
    expect(store.getSnapshot().activeIndex).toBe(2);
    store.moveSelection(1);
    expect(store.getSnapshot().activeIndex).toBe(0);
    store.moveSelection(-1);
    expect(store.getSnapshot().activeIndex).toBe(2);
    store.setQuery("日志");
    expect(store.getSnapshot()).toMatchObject({
      activeIndex: 0,
      matchCount: 0,
      matchedSections: [],
      resultsQuery: null,
    });
    store.setMatches("更新", 3, ["updates"]);
    expect(store.getSnapshot().matchCount).toBe(0);
    store.setMatches("日志", 2, ["logs"]);
    expect(store.getSnapshot()).toMatchObject({
      activeIndex: 0,
      matchCount: 2,
      matchedSections: ["logs"],
    });
  });

  test("handles results shrinking or disappearing and retains selection through blur", () => {
    const store = createSettingsSearchStore();
    store.focus("compact");
    store.setQuery("设置");
    store.setMatches("设置", 4);
    store.moveSelection(-1);
    store.setMatches("设置", 2);
    expect(store.getSnapshot().activeIndex).toBe(1);
    store.blur("compact");
    store.moveSelection(1);
    expect(store.getSnapshot().activeIndex).toBe(1);
    store.focus("desktop");
    expect(store.getSnapshot().activeIndex).toBe(1);
    store.setMatches("设置", 0);
    store.moveSelection(1);
    expect(store.getSnapshot()).toMatchObject({ activeIndex: 0, matchCount: 0 });
  });

  test("Enter can reveal a single result again after manual scrolling", () => {
    const store = createSettingsSearchStore();
    store.focus("desktop");
    store.setQuery("语言");
    store.setMatches("语言", 1);
    const before = store.getSnapshot().selectionRevision;
    store.moveSelection(1);
    expect(store.getSnapshot()).toMatchObject({ activeIndex: 0, selectionRevision: before + 1 });
  });
});
