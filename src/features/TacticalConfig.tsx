import React, { useMemo } from "react";
import {
  ConfigurationGroup,
  ConfigurationSelect,
} from "@/components/configuration/ConfigurationControls";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import { serverMap } from "@/shared/GlobalUtilities";

interface TacticalConfigProps {
  profileId?: string;
  onClose: () => void;
}
const TacticalConfig: React.FC<TacticalConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId!]);
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const initial = useMemo(
    () => ({ totalForceFightDifficulty: String(settings.totalForceFightDifficulty ?? "") }),
    [settings]
  );
  const difficulties = (staticConfig.total_assault_difficulties[serverMap[settings.server]] ??
    []) as string[];
  const [draft, setDraft] = useConfigurationDraft(profileId!, "tactical", initial);
  const difficultyLabels: Record<string, string> = {
    NORMAL: t("configurationDifficulties.normal"),
    HARD: t("configurationDifficulties.hard"),
    VERYHARD: t("configurationDifficulties.veryHard"),
    HARDCORE: t("configurationDifficulties.hardcore"),
    EXTREME: t("configurationDifficulties.extreme"),
    INSANE: t("configurationDifficulties.insane"),
    TORMENT: t("configurationDifficulties.torment"),
  };
  const options = [
    ...new Set([
      ...difficulties,
      ...(draft.totalForceFightDifficulty ? [draft.totalForceFightDifficulty] : []),
    ]),
  ].map((value) => ({ value, label: difficultyLabels[value] ?? value }));
  return (
    <ConfigurationGroup title={t("tactical")}>
      <ConfigurationSelect
        label={t("tactical.hardLevel")}
        description={t("configurationHelp.tacticalDifficulty")}
        value={draft.totalForceFightDifficulty}
        onChange={(value) => setDraft({ totalForceFightDifficulty: value })}
        options={options}
      />
    </ConfigurationGroup>
  );
};
export default TacticalConfig;
