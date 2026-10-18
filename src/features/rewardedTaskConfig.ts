/** Bounty regions follow the backend's menu order; only the JP server has five. */
export function rewardedTaskRegionCount(server: unknown): 3 | 5 {
  return server === "日服" || server === "JP" ? 5 : 3;
}

/** Pad older JP profiles with disabled regions without changing their original counts. */
export function readRewardedTaskCounts(value: unknown, server: unknown): string[] {
  const values = typeof value === "string" && value.trim() !== "" ? value.split(",") : [];
  return Array.from({ length: rewardedTaskRegionCount(server) }, (_, index) =>
    index < values.length ? values[index].trim() : "0"
  );
}

export const isRewardedTaskCount = (value: string): boolean => /^(?:max|\d+)$/.test(value.trim());

/** Keep the existing CSV protocol, rejecting drafts the backend cannot execute. */
export function serializeRewardedTaskCounts(
  counts: readonly string[],
  server: unknown
): string | null {
  const values = counts.map((value) => value.trim());
  return values.length === rewardedTaskRegionCount(server) && values.every(isRewardedTaskCount)
    ? values.join(",")
    : null;
}
