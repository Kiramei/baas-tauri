import { describe, expect, test } from "bun:test";
import {
  readRewardedTaskCounts,
  rewardedTaskRegionCount,
  serializeRewardedTaskCounts,
} from "../../src/features/rewardedTaskConfig";

describe("server-specific bounty configuration", () => {
  test("only JP exposes the two additional regions", () => {
    expect(rewardedTaskRegionCount("日服")).toBe(5);
    expect(rewardedTaskRegionCount("JP")).toBe(5);
    for (const server of [
      "官服",
      "B服",
      "国际服",
      "国际服青少年",
      "韩国ONE",
      "Steam国际服",
      undefined,
    ]) {
      expect(rewardedTaskRegionCount(server)).toBe(3);
    }
  });

  test("older JP profiles keep their first three counts and disable new regions", () => {
    const counts = readRewardedTaskCounts("2,2,2", "日服");
    expect(counts).toEqual(["2", "2", "2", "0", "0"]);
    expect(serializeRewardedTaskCounts(counts, "日服")).toBe("2,2,2,0,0");
  });

  test("round trips all five JP values and max using the existing CSV wire format", () => {
    const counts = readRewardedTaskCounts(" 0, max,2,3,4 ", "日服");
    expect(counts).toEqual(["0", "max", "2", "3", "4"]);
    expect(serializeRewardedTaskCounts(counts, "日服")).toBe("0,max,2,3,4");
    expect(serializeRewardedTaskCounts([" 2 ", "max", "0"], "B服")).toBe("2,max,0");
    expect(serializeRewardedTaskCounts(readRewardedTaskCounts(undefined, "日服"), "日服")).toBe(
      "0,0,0,0,0"
    );
  });

  test("CN and Global continue to save three counts even after changing from a JP profile", () => {
    for (const server of ["B服", "官服", "国际服"]) {
      expect(serializeRewardedTaskCounts(readRewardedTaskCounts("max,2,0", server), server)).toBe(
        "max,2,0"
      );
      expect(serializeRewardedTaskCounts(readRewardedTaskCounts("1,2,3,4,5", server), server)).toBe(
        "1,2,3"
      );
    }
  });

  test("invalid or incomplete drafts cannot reach the backend", () => {
    for (const value of ["", "-1", "1.5", "NaN", "MAX", "2,3", "1e3"]) {
      expect(serializeRewardedTaskCounts([value, "0", "0"], "B服")).toBeNull();
    }
    expect(serializeRewardedTaskCounts(["1", "2", "3"], "日服")).toBeNull();
    expect(serializeRewardedTaskCounts(["1", "2", "3", "4", "5"], "B服")).toBeNull();
    // Keep corrupt imported values visible so opening the editor cannot silently overwrite them.
    expect(readRewardedTaskCounts("2,-1,max", "日服")).toEqual(["2", "-1", "max", "0", "0"]);
  });
});
