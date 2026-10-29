import type { ProfileDTO } from "@/types/app";
import { DEFAULT_PROFILE_NAME, profileDisplayName } from "./ProfileName";

export type ProfileTab = Pick<ProfileDTO, "id" | "name" | "server">;

type ProfileConfigs = Record<string, { name?: unknown; server?: unknown } | null | undefined>;

export const isUserProfileId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id !== "default_config";

/** List events contain IDs before snapshots arrive; those placeholders are not tabs. */
export function userProfileTabs(configs: ProfileConfigs): ProfileTab[] {
  return Object.entries(configs).flatMap(([id, config]) => {
    if (!isUserProfileId(id) || typeof config?.name !== "string") return [];
    const name = profileDisplayName(config.name);
    return [
      { id, name: name.trim() ? name : DEFAULT_PROFILE_NAME, server: String(config.server ?? "") },
    ];
  });
}

/** A reorder is an ordering hint, never the authoritative profile membership. */
export function reconcileProfileTabs(
  configs: ProfileConfigs,
  requestedOrder: unknown
): ProfileTab[] {
  const remaining = new Map(userProfileTabs(configs).map((profile) => [profile.id, profile]));
  const tabs: ProfileTab[] = [];
  for (const id of Array.isArray(requestedOrder) ? requestedOrder : []) {
    if (typeof id !== "string") continue;
    const tab = remaining.get(id);
    if (!tab) continue;
    tabs.push(tab);
    remaining.delete(id);
  }
  return [...tabs, ...remaining.values()];
}
