import { describe, expect, test } from "bun:test";
import {
  createFinalRestrictionPatch,
  createFriendCleanupPatch,
  isCopyClearUnit,
  normalizeFinalRestrictionConfig,
  normalizeFriendCleanupConfig,
  parseBoundedInteger,
  withFormationMethod,
} from "../../src/features/issue528Config";

describe("Issue #528 configuration model", () => {
  test("normalizes missing unrestricted battle settings to backend defaults", () => {
    expect(normalizeFinalRestrictionConfig({})).toEqual({
      formationMethod: "default",
      maxUnavailableStudentCount: 0,
      maxRefreshCount: 10,
    });
  });

  test("enables copy-clear controls only for the copy_clear_unit method", () => {
    expect(isCopyClearUnit("default")).toBe(false);
    expect(isCopyClearUnit("copy_clear_unit")).toBe(true);
  });

  test("switching formation method preserves both copy-clear values", () => {
    const draft = {
      formationMethod: "copy_clear_unit" as const,
      maxUnavailableStudentCount: 4,
      maxRefreshCount: 12,
    };

    expect(withFormationMethod(draft, "default")).toEqual({
      formationMethod: "default",
      maxUnavailableStudentCount: 4,
      maxRefreshCount: 12,
    });
  });

  test("accepts only integers inside the requested boundaries", () => {
    expect(parseBoundedInteger("0", 0, 10)).toBe(0);
    expect(parseBoundedInteger("10", 0, 10)).toBe(10);
    expect(parseBoundedInteger("-1", -1)).toBe(-1);
    expect(parseBoundedInteger("-1", 0, 10)).toBeNull();
    expect(parseBoundedInteger("11", 0, 10)).toBeNull();
    expect(parseBoundedInteger("1.5", 0)).toBeNull();
    expect(parseBoundedInteger("", -1)).toBeNull();
  });

  test("emits only changed unrestricted battle keys", () => {
    const current = normalizeFinalRestrictionConfig({});
    const draft = { ...current, formationMethod: "copy_clear_unit" as const };

    expect(createFinalRestrictionPatch(current, draft)).toEqual({
      final_restriction_rls_employ_formation_method: "copy_clear_unit",
    });
  });

  test("normalizes old friend profiles and saves whitelist plus thresholds together", () => {
    const current = normalizeFriendCleanupConfig({ clear_friend_white_list: ["OLD"] });
    expect(current).toEqual({
      clearFriendWhiteList: ["OLD"],
      levelLimit: -1,
      lastLoginDays: -1,
      lastTotalAssaultRankLimit: -1,
    });

    expect(
      createFriendCleanupPatch(current, {
        ...current,
        clearFriendWhiteList: ["OLD", "NEW"],
        levelLimit: 80,
        lastLoginDays: 30,
      })
    ).toEqual({
      clear_friend_white_list: ["OLD", "NEW"],
      clear_friend_level_limit: 80,
      clear_friend_last_login_time_days: 30,
    });
  });
});
