import { describe, expect, test } from "bun:test";
import {
  createExplorePlanEntry,
  exploreMissionChoices,
  parseExplorePlan,
  serializeExplorePlan,
} from "../../src/shared/ExplorePlan";

describe("exploration plan storage compatibility", () => {
  test("reading mixed legacy input preserves every token and whitespace", () => {
    for (const original of [
      "04, 12-A, 16-2-sss,, 10-0,not-a-stage, 99-9 ",
      "   ",
      "10,10,10-1",
      "12-1-A",
      "99999999999999999999999999",
    ]) {
      expect(serializeExplorePlan(parseExplorePlan(original))).toBe(original);
    }
  });
  test("chapters and special A missions are decoded without rewriting their spelling", () => {
    expect(parseExplorePlan(" 012 ,12-A,4-03")).toEqual([
      { raw: " 012 ", chapter: 12, mission: "all" },
      { raw: "12-A", chapter: 12, mission: "A" },
      { raw: "4-03", chapter: 4, mission: "03" },
    ]);
  });
  test("whole chapters expand to the choices supported by each mission mode", () => {
    expect(exploreMissionChoices(4, "normal")).toEqual(["all", "1", "2", "3", "4", "5"]);
    expect(exploreMissionChoices(6, "normal")).toEqual(["all", "1", "2", "3", "4", "5", "A"]);
    expect(exploreMissionChoices(6, "hard")).toEqual(["all", "1", "2", "3"]);
  });
  test("new rows emit exactly the backend chapter and chapter-mission grammar", () => {
    expect(createExplorePlanEntry(12, "A", "normal")?.raw).toBe("12-A");
    expect(createExplorePlanEntry(4, "all", "normal")?.raw).toBe("4");
    expect(createExplorePlanEntry(1, "3", "hard")?.raw).toBe("1-3");
    for (const invalid of [
      createExplorePlanEntry(4, "A", "normal"),
      createExplorePlanEntry(6, "A", "hard"),
      createExplorePlanEntry(1, "4", "hard"),
      createExplorePlanEntry(0, "all", "normal"),
      createExplorePlanEntry(4.5, "all", "normal"),
    ])
      expect(invalid).toBeNull();
  });
  test("changing one row preserves unknown neighboring values", () => {
    const rows = parseExplorePlan(" 04 ,custom-legacy,12-A");
    rows[0] = createExplorePlanEntry(5, "2", "normal")!;
    expect(serializeExplorePlan(rows)).toBe("5-2,custom-legacy,12-A");
    expect(rows[1].chapter).toBeNull();
  });
  test("an empty plan remains empty and can be explicitly cleared", () => {
    expect(parseExplorePlan("")).toEqual([]);
    expect(serializeExplorePlan([])).toBe("");
  });
});
