import React, { useMemo } from "react";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationSelect,
} from "@/components/configuration/ConfigurationControls";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";

interface ArenaConfigProps {
  profileId: string;
  onClose: () => void;
}
interface Draft {
  ArenaLevelDiff: string;
  ArenaComponentNumber: string;
  maxArenaRefreshTimes: string;
}
const ArenaConfig: React.FC<ArenaConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const initial = useMemo<Draft>(
    () => ({
      ArenaLevelDiff: String(settings.ArenaLevelDiff ?? 0),
      ArenaComponentNumber: String(settings.ArenaComponentNumber ?? 1),
      maxArenaRefreshTimes: String(settings.maxArenaRefreshTimes ?? 0),
    }),
    [settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId, "arena", initial, {
    serialize: (value) => {
      const level = Number(value.ArenaLevelDiff);
      const refresh = Number(value.maxArenaRefreshTimes);
      const opponent = Number(value.ArenaComponentNumber);
      if (
        !value.ArenaLevelDiff.trim() ||
        !Number.isInteger(level) ||
        level < -89 ||
        level > 89 ||
        !value.maxArenaRefreshTimes.trim() ||
        !Number.isInteger(refresh) ||
        refresh < 0 ||
        ![1, 2, 3].includes(opponent)
      )
        return null;
      return {
        ArenaLevelDiff: level,
        ArenaComponentNumber: opponent,
        maxArenaRefreshTimes: refresh,
      };
    },
  });
  const change = (key: keyof Draft) => (value: string) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  return (
    <ConfigurationGroup title={t("arena")}>
      <ConfigurationInput
        type="number"
        label={t("arena.higherLevel")}
        description={t("configurationHelp.arenaLevel")}
        value={draft.ArenaLevelDiff}
        onChange={(event) => change("ArenaLevelDiff")(event.target.value)}
        min={-89}
        max={89}
      />
      <ConfigurationInput
        type="number"
        label={t("arena.maxRefreshTimes")}
        description={t("configurationHelp.arenaRefresh")}
        value={draft.maxArenaRefreshTimes}
        onChange={(event) => change("maxArenaRefreshTimes")(event.target.value)}
        min={0}
      />
      <ConfigurationSelect
        label={t("arena.opponentNo")}
        description={t("configurationHelp.arenaOpponent")}
        value={draft.ArenaComponentNumber}
        onChange={change("ArenaComponentNumber")}
        options={["1", "2", "3"].map((value) => ({ value, label: value }))}
      />
    </ConfigurationGroup>
  );
};
export default ArenaConfig;
