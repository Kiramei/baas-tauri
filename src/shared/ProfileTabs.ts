import type { ProfileDTO } from "@/types/app";
import { profileDisplayName } from "./ProfileName";

export type ProfileTab = Pick<ProfileDTO, "id" | "name" | "server">;

/** A reorder is an ordering hint, never the authoritative profile membership. */
export function reconcileProfileTabs(
  configs: Record<string, { name?: unknown; server?: unknown } | null | undefined>,
  requestedOrder: unknown
): ProfileTab[] {
  const remaining = new Map(
    Object.entries(configs).map(([id, config]) => [id, {
      id,
      name: profileDisplayName(String(config?.name ?? "")),
      server: String(config?.server ?? ""),
    }])
  );
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
