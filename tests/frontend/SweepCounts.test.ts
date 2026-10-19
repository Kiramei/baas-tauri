import { describe, expect, test } from "bun:test";
import {
  activitySweepCountToken,
  isActivitySweepCountStringValid,
  isSweepCountStringValid,
  readActivitySweepCounts,
  readSweepCountTokens,
  replaceActivitySweepCount,
  replaceSweepCountToken,
} from "../../src/shared/SweepCounts";

describe("structured sweep counts and the existing string protocol", () => {
  test("positional counts keep region order and untouched formatting", () => {
    const source = " 002 ,max, 0 ";
    expect(readSweepCountTokens(source, 3)).toEqual([" 002 ", "max", " 0 "]);
    expect(isSweepCountStringValid(source, 3)).toBe(true);
    expect(replaceSweepCountToken(source, 3, 1, "3")).toBe(" 002 ,3, 0 ");
    expect(replaceSweepCountToken(source, 3, 0, "max")).toBe("max,max, 0 ");
    expect(source).toBe(" 002 ,max, 0 ");
    expect(replaceSweepCountToken("1,2", 2, 1, "0")).toBe("1,0");
  });

  test("unsupported legacy shapes cannot be silently replaced by a field edit", () => {
    for (const value of ["", "1,2", "1,2,3,4", "0,custom,0", "0, max ,0", "0,0.5,0"]) {
      expect(readSweepCountTokens(value, 3)).toBeNull();
      expect(replaceSweepCountToken(value, 3, 0, "1")).toBeNull();
    }
    expect(readSweepCountTokens([1, 2, 3], 3)).toBeNull();
    expect(replaceSweepCountToken("0,0,0", 3, 3, "1")).toBeNull();
    expect(replaceSweepCountToken("0,0,0", 3, 1, "1.5")).toBeNull();
  });

  test("incomplete count edits remain editable but cannot be serialized as runnable counts", () => {
    expect(replaceSweepCountToken("1,2,3", 3, 1, "")).toBe("1,,3");
    expect(readSweepCountTokens("1,,3", 3)).toEqual(["1", "", "3"]);
    expect(isSweepCountStringValid("1,,3", 3)).toBe(false);
    expect(replaceSweepCountToken("1,,3", 3, 1, "4")).toBe("1,4,3");
    // The backend accepts signed integers, so unchanged older skip values stay intact.
    expect(replaceSweepCountToken("-1,0,0", 3, 2, "2")).toBe("-1,0,2");
  });

  test("activity distinguishes integer counts, AP shares, and the one-value all-AP marker", () => {
    expect(readActivitySweepCounts("1")?.[0]).toMatchObject({ mode: "count", amount: "1" });
    expect(readActivitySweepCounts("1.0")?.[0]).toMatchObject({ mode: "share", amount: "100" });
    expect(readActivitySweepCounts("1/2")?.[0]).toMatchObject({ mode: "share", amount: "50" });
    expect(readActivitySweepCounts("-1")?.[0].mode).toBe("all");
    expect(readActivitySweepCounts("0,-1")?.map(({ mode }) => mode)).toEqual(["skip", "skip"]);
    expect(readActivitySweepCounts("1.5")?.[0]).toMatchObject({ mode: "share", amount: "100" });
  });

  test("friendly activity values serialize to exactly the old scalar string formats", () => {
    expect(activitySweepCountToken("skip")).toBe("0");
    expect(activitySweepCountToken("all")).toBe("-1");
    expect(activitySweepCountToken("count", "7")).toBe("7");
    expect(activitySweepCountToken("share", "50")).toBe("0.5");
    expect(activitySweepCountToken("share", "100")).toBe("1.0");
    expect(activitySweepCountToken("share", "0")).toBe("0.0");
    const tiny = activitySweepCountToken("share", "0.0000001")!;
    expect(tiny).toBe("0.000000001");
    expect(isActivitySweepCountStringValid(tiny)).toBe(true);
    expect(activitySweepCountToken("share", "101")).toBeNull();
    expect(activitySweepCountToken("count", "1e3")).toBeNull();
  });

  test("activity CSV edits preserve fractions, whitespace and other unchanged entries", () => {
    const source = " 1/2 , 003 ,0.25";
    expect(replaceActivitySweepCount(source, 1, "4")).toBe(" 1/2 ,4,0.25");
    expect(source).toBe(" 1/2 , 003 ,0.25");
    expect(replaceActivitySweepCount(source, 0, "-1")).toBeNull();
    expect(replaceActivitySweepCount("-1", 0, "1.0")).toBe("1.0");
    for (const raw of ["max", "1e3", "1/0", "custom", "0,custom"]) {
      expect(readActivitySweepCounts(raw)).toBeNull();
      expect(replaceActivitySweepCount(raw, 0, "1")).toBeNull();
    }
  });

  test("blank activity inputs preserve their mode until the user completes a valid value", () => {
    expect(activitySweepCountToken("count", "")).toBe("");
    expect(activitySweepCountToken("share", "")).toBe(".");
    expect(readActivitySweepCounts(".")?.[0]).toMatchObject({
      mode: "share",
      amount: "",
      valid: false,
    });
    expect(isActivitySweepCountStringValid(".")).toBe(false);
    expect(isActivitySweepCountStringValid("")).toBe(false);
    expect(replaceActivitySweepCount(".", 0, "0.5")).toBe("0.5");
  });
});
