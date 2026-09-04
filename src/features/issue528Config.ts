import type { DynamicConfig } from "@/types/dynamic";

export type FinalRestrictionFormationMethod = "default" | "copy_clear_unit";

export interface FinalRestrictionDraft {
  formationMethod: FinalRestrictionFormationMethod;
  maxUnavailableStudentCount: number;
  maxRefreshCount: number;
}

export interface FriendCleanupDraft {
  clearFriendWhiteList: string[];
  levelLimit: number;
  lastLoginDays: number;
  lastTotalAssaultRankLimit: number;
}

export const parseBoundedInteger = (value: string, min: number, max?: number): number | null => {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    return null;
  }
  return parsed;
};

const boundedOrDefault = (value: unknown, fallback: number, min: number, max?: number): number => {
  const parsed = typeof value === "number" ? parseBoundedInteger(String(value), min, max) : null;
  return parsed ?? fallback;
};

export const normalizeFinalRestrictionConfig = (
  settings: Partial<DynamicConfig>
): FinalRestrictionDraft => ({
  formationMethod:
    settings.final_restriction_rls_employ_formation_method === "copy_clear_unit"
      ? "copy_clear_unit"
      : "default",
  maxUnavailableStudentCount: boundedOrDefault(
    settings.final_restriction_rls_employ_formation_copy_clear_unit_max_unavailable_student_count,
    0,
    0,
    10
  ),
  maxRefreshCount: boundedOrDefault(
    settings.final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count,
    10,
    0
  ),
});

export const normalizeFriendCleanupConfig = (
  settings: Partial<DynamicConfig>
): FriendCleanupDraft => ({
  clearFriendWhiteList: Array.isArray(settings.clear_friend_white_list)
    ? [...settings.clear_friend_white_list]
    : [],
  levelLimit: boundedOrDefault(settings.clear_friend_level_limit, -1, -1),
  lastLoginDays: boundedOrDefault(settings.clear_friend_last_login_time_days, -1, -1),
  lastTotalAssaultRankLimit: boundedOrDefault(
    settings.clear_friend_last_total_assault_rank_limit,
    -1,
    -1
  ),
});

export const isCopyClearUnit = (method: FinalRestrictionFormationMethod): boolean =>
  method === "copy_clear_unit";

export const withFormationMethod = (
  draft: FinalRestrictionDraft,
  formationMethod: FinalRestrictionFormationMethod
): FinalRestrictionDraft => ({ ...draft, formationMethod });

export const createFinalRestrictionPatch = (
  current: FinalRestrictionDraft,
  draft: FinalRestrictionDraft
): Partial<DynamicConfig> => {
  const patch: Partial<DynamicConfig> = {};
  if (draft.formationMethod !== current.formationMethod) {
    patch.final_restriction_rls_employ_formation_method = draft.formationMethod;
  }
  if (draft.maxUnavailableStudentCount !== current.maxUnavailableStudentCount) {
    patch.final_restriction_rls_employ_formation_copy_clear_unit_max_unavailable_student_count =
      draft.maxUnavailableStudentCount;
  }
  if (draft.maxRefreshCount !== current.maxRefreshCount) {
    patch.final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count =
      draft.maxRefreshCount;
  }
  return patch;
};

export const createFriendCleanupPatch = (
  current: FriendCleanupDraft,
  draft: FriendCleanupDraft
): Partial<DynamicConfig> => {
  const patch: Partial<DynamicConfig> = {};
  if (JSON.stringify(draft.clearFriendWhiteList) !== JSON.stringify(current.clearFriendWhiteList)) {
    patch.clear_friend_white_list = draft.clearFriendWhiteList;
  }
  if (draft.levelLimit !== current.levelLimit) {
    patch.clear_friend_level_limit = draft.levelLimit;
  }
  if (draft.lastLoginDays !== current.lastLoginDays) {
    patch.clear_friend_last_login_time_days = draft.lastLoginDays;
  }
  if (draft.lastTotalAssaultRankLimit !== current.lastTotalAssaultRankLimit) {
    patch.clear_friend_last_total_assault_rank_limit = draft.lastTotalAssaultRankLimit;
  }
  return patch;
};
