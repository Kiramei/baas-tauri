import React, { useMemo } from "react";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationSelect,
  ConfigurationToggle,
} from "@/components/configuration/ConfigurationControls";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import {
  hasConfigurationField,
  serializeArenaConfig,
  type ArenaConfigDraft,
} from "./upstreamConfig";

interface ArenaConfigProps {
  profileId: string;
  onClose: () => void;
}
const ArenaConfig: React.FC<ArenaConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const supportsRankOneStop = hasConfigurationField(settings, "ArenaStopFightWhenRank1");
  const initial = useMemo<ArenaConfigDraft>(
    () => ({
      ArenaLevelDiff: String(settings.ArenaLevelDiff ?? 0),
      ArenaComponentNumber: String(settings.ArenaComponentNumber ?? 1),
      maxArenaRefreshTimes: String(settings.maxArenaRefreshTimes ?? 0),
      ArenaStopFightWhenRank1: settings.ArenaStopFightWhenRank1 ?? false,
    }),
    [settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId, "arena", initial, {
    serialize: (value) => serializeArenaConfig(value, settings),
  });
  const change =
    (key: Exclude<keyof ArenaConfigDraft, "ArenaStopFightWhenRank1">) => (value: string) =>
      setDraft((previous) => ({ ...previous, [key]: value }));
  return (
    <ConfigurationGroup title={t("arena")}>
      <ConfigurationToggle
        label={t("arena.stopAtFirstPlace")}
        description={
          supportsRankOneStop
            ? t("configurationHelp.arenaStopAtFirstPlace")
            : t("configurationHelp.backendUpdateRequired")
        }
        disabled={!supportsRankOneStop}
        checked={draft.ArenaStopFightWhenRank1}
        onChange={(value) =>
          setDraft((previous) => ({ ...previous, ArenaStopFightWhenRank1: value }))
        }
      />
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
