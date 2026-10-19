import { describe, expect, test } from "bun:test";
import {
  appendSweepStages,
  isSweepPlanValid,
  normalizeSweepPlanValue,
  parseSweepPlan,
  serializeSweepPlan,
  sweepPlanAllowsMax,
} from "../../src/shared/SweepPlan";

describe("structured daily sweep plans", () => {
  test("round trips every ordered stage and count without changing execution order", () => {
    const value = "5-1-1, 5-1-3, 14-3-0";
    expect(parseSweepPlan(value, { mode: "hard" })).toEqual([
      { kind: "stage", chapter: 5, mission: 1, count: 1 },
      { kind: "stage", chapter: 5, mission: 1, count: 3 },
      { kind: "stage", chapter: 14, mission: 3, count: 0 },
    ]);
    expect(serializeSweepPlan(parseSweepPlan(value))).toBe(value);
    expect(serializeSweepPlan(parseSweepPlan(" 05 - 01 - 003,5-2-MAX "))).toBe("5-1-3, 5-2-max");
  });

  test("normal and hard modes use their actual stage-number limits", () => {
    expect(isSweepPlanValid("5-5-3", { mode: "normal" })).toBe(true);
    expect(isSweepPlanValid("5-5-3", { mode: "hard" })).toBe(false);
    expect(isSweepPlanValid("5-3-3", { mode: "hard" })).toBe(true);
    for (const value of ["5-0-3", "5-6-3", "0-1-3"]) {
      expect(isSweepPlanValid(value)).toBe(false);
      expect(serializeSweepPlan(parseSweepPlan(value))).toBe(value);
    }
  });

  test("uses a server-provided chapter range without inventing a global validation cap", () => {
    expect(isSweepPlanValid("31-1-3", { maxChapter: 30 })).toBe(false);
    expect(isSweepPlanValid("30-1-3", { maxChapter: 30 })).toBe(true);
    expect(isSweepPlanValid("55-1-3")).toBe(true);
    expect(isSweepPlanValid("55-1-3", { maxChapter: undefined })).toBe(true);
    expect(parseSweepPlan("31-1-3", { maxChapter: 30 })[0]).toEqual({
      kind: "invalid",
      raw: "31-1-3",
      error: "chapter",
    });
  });

  test("max follows the original CN-hard restriction and stays valid elsewhere", () => {
    for (const server of ["CN", "B服", "官服"]) {
      expect(sweepPlanAllowsMax("hard", server)).toBe(false);
      expect(isSweepPlanValid("10-1-max", { mode: "hard", server })).toBe(false);
      expect(isSweepPlanValid("10-1-max", { mode: "normal", server })).toBe(true);
    }
    for (const server of ["JP", "日服", "Global", "国际服"]) {
      expect(sweepPlanAllowsMax("hard", server)).toBe(true);
      expect(isSweepPlanValid("10-1-max", { mode: "hard", server })).toBe(true);
    }
    expect(serializeSweepPlan(parseSweepPlan("10-1-max", { mode: "hard", server: "CN" }))).toBe(
      "10-1-max"
    );
  });

  test("rejects incomplete or unsafe counts while preserving their original tokens", () => {
    for (const value of [
      "1-1-",
      "1-1-nope",
      "1-1-1.5",
      "1-1--1",
      "1-1-Infinity",
      "1-1-9007199254740992",
    ]) {
      expect(isSweepPlanValid(value)).toBe(false);
      expect(serializeSweepPlan(parseSweepPlan(value))).toBe(value);
    }
    expect(isSweepPlanValid("1-1-0")).toBe(true);
    expect(isSweepPlanValid("1-1-20")).toBe(true);
  });

  test("unrecognized entries remain visible invalid rows between valid stages", () => {
    const value = "10-1-2, legacy-value, 14-1-max";
    const parsed = parseSweepPlan(value);
    expect(parsed[1]).toEqual({ kind: "invalid", raw: "legacy-value", error: "format" });
    expect(serializeSweepPlan(parsed)).toBe(value);
    expect(isSweepPlanValid(value)).toBe(false);
    expect(serializeSweepPlan(parseSweepPlan("10-1-3,,14-1-3"))).toBe("10-1-3, , 14-1-3");
  });

  test("supports legacy arrays and empty defaults without writing or inventing stages", () => {
    for (const value of ["", "   ", [], null, undefined]) expect(parseSweepPlan(value)).toEqual([]);
    expect(isSweepPlanValid("")).toBe(true);
    expect(serializeSweepPlan([])).toBe("");
    expect(normalizeSweepPlanValue(["10-1-3", "14-1-3"])).toBe("10-1-3, 14-1-3");
    expect(serializeSweepPlan(parseSweepPlan(["10-1-3", "legacy"]))).toBe("10-1-3, legacy");
    expect(parseSweepPlan([null])[0]).toEqual({ kind: "invalid", raw: "null", error: "format" });
  });

  test("selecting a student appends all drop stages with a default sweep count", () => {
    expect(appendSweepStages("", ["10-1", "14-1"])).toBe("10-1-3, 14-1-3");
    expect(appendSweepStages("10-1-1", ["10-1", "14-1", "14-1"])).toBe("10-1-1, 14-1-3");
    expect(appendSweepStages("14-1-max, 2-3-2", ["10-1", "14-1"])).toBe("14-1-max, 2-3-2, 10-1-3");
    expect(appendSweepStages("", ["14-1", "10-1"], 2)).toBe("14-1-2, 10-1-2");
  });

  test("student additions skip bad stage identifiers and preserve older unknown entries", () => {
    expect(
      appendSweepStages("legacy, 10-1-bad", ["10-1", "14-1", "bad", "0-1", "1-6", "1-1-3"])
    ).toBe("legacy, 10-1-bad, 14-1-3");
    expect(appendSweepStages("", ["10-1"], NaN)).toBe("10-1-3");
    expect(appendSweepStages("", ["10-1"], 0)).toBe("10-1-0");
    const stages = ["10-1", "14-1"] as const;
    appendSweepStages("2-1-3", stages);
    expect(stages).toEqual(["10-1", "14-1"]);
  });
});
