import { useCallback } from "react";
import { create } from "zustand";
import {
  filterConfigurationSections,
  resolveConfigurationSection,
  type ConfigurationPlatform,
  type ConfigurationSection,
} from "./ConfigurationSections";
import { useAppTranslation } from "./useAppTranslation";

interface ConfigurationWorkspace {
  selected: ConfigurationSection;
  query: string;
}

const EMPTY_WORKSPACE: ConfigurationWorkspace = { selected: "cafe", query: "" };

// Navigation belongs to a profile and this window, never to the script configuration.
const useWorkspaceStore = create<{
  profiles: Record<string, ConfigurationWorkspace>;
  update: (profileId: string, patch: Partial<ConfigurationWorkspace>) => void;
}>((set) => ({
  profiles: {},
  update: (profileId, patch) => {
    if (!profileId) return;
    set((state) => ({
      profiles: {
        ...state.profiles,
        [profileId]: { ...(state.profiles[profileId] ?? EMPTY_WORKSPACE), ...patch },
      },
    }));
  },
}));

export function useConfigurationWorkspace(
  profileId: string | undefined,
  platform: ConfigurationPlatform = __WITH_ANDROID__
    ? "android"
    : __WITH_WEBUI__
      ? "webui"
      : "desktop"
) {
  const { t } = useAppTranslation();
  const workspace = useWorkspaceStore(
    (state) => state.profiles[profileId ?? ""] ?? EMPTY_WORKSPACE
  );
  const update = useWorkspaceStore((state) => state.update);
  const select = useCallback(
    (selected: ConfigurationSection) =>
      update(profileId ?? "", { selected: resolveConfigurationSection(selected, platform).id }),
    [profileId, platform, update]
  );
  const search = useCallback(
    (query: string) => {
      const matches = filterConfigurationSections(query, t, platform);
      const current = resolveConfigurationSection(workspace.selected, platform).id;
      const selected = matches.some(({ id }) => id === current)
        ? current
        : (matches[0]?.id ?? current);
      update(profileId ?? "", { query, selected });
    },
    [profileId, platform, t, update, workspace.selected]
  );
  return {
    selected: resolveConfigurationSection(workspace.selected, platform),
    query: workspace.query,
    select,
    search,
  };
}
