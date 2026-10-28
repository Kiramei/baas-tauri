import React, { useMemo } from "react";
import {
  ConfigurationGroup,
  ConfigurationRow,
  ConfigurationToggle,
} from "@/components/configuration/ConfigurationControls";
import { FormSelect } from "@/components/ui/FormSelect";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";

interface DrillConfigProps {
  profileId?: string;
  onClose: () => void;
}
interface Draft {
  drill_enable_sweep: boolean;
  drill_fight_formation_list: string[];
  drill_difficulty_list: string[];
}
const DrillConfig: React.FC<DrillConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId!]);
  const initial = useMemo<Draft>(
    () => ({
      drill_enable_sweep: settings.drill_enable_sweep ?? false,
      drill_fight_formation_list: (settings.drill_fight_formation_list ?? []).map(String),
      drill_difficulty_list: (settings.drill_difficulty_list ?? []).map(String),
    }),
    [settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId!, "drill", initial, {
    serialize: (value) => {
      const formation = value.drill_fight_formation_list.map(Number);
      const difficulty = value.drill_difficulty_list.map(Number);
      if (
        [...formation, ...difficulty].some(
          (entry) => !Number.isInteger(entry) || entry < 1 || entry > 4
        )
      )
        return null;
      return {
        drill_enable_sweep: value.drill_enable_sweep,
        drill_fight_formation_list: formation,
        drill_difficulty_list: difficulty,
      };
    },
  });
  const change = (
    key: "drill_fight_formation_list" | "drill_difficulty_list",
    index: number,
    value: string
  ) =>
    setDraft((previous) => ({
      ...previous,
      [key]: previous[key].map((entry, i) => (i === index ? value : entry)),
    }));
  const options = ["1", "2", "3", "4"].map((value) => ({ value, label: value }));
  return (
    <ConfigurationGroup title={t("drill")}>
      <ConfigurationToggle
        label={t("drill.useAllAfterSweep")}
        description={t("configurationHelp.drillSweep")}
        checked={draft.drill_enable_sweep}
        onChange={(value) => setDraft((previous) => ({ ...previous, drill_enable_sweep: value }))}
      />
      <ConfigurationRow
        label={t("drill.outPartyNo")}
        description={t("configurationHelp.drillFormation")}
        className="configuration-row-stacked"
      >
        <div className="grid min-w-0 grid-cols-3 gap-2">
          {draft.drill_fight_formation_list.map((value, index) => (
            <FormSelect
              key={index}
              value={value}
              onChange={(next) => change("drill_fight_formation_list", index, next)}
              options={options}
              ariaLabel={t("drill.outPartyNo") + " " + (index + 1)}
              className="min-w-0"
            />
          ))}
        </div>
      </ConfigurationRow>
      <ConfigurationRow
        label={t("drill.difficulty")}
        description={t("configurationHelp.drillDifficulty")}
        className="configuration-row-stacked"
      >
        <div className="grid min-w-0 grid-cols-3 gap-2">
          {draft.drill_difficulty_list.map((value, index) => (
            <FormSelect
              key={index}
              value={value}
              onChange={(next) => change("drill_difficulty_list", index, next)}
              options={options}
              ariaLabel={t("drill.difficulty") + " " + (index + 1)}
              className="min-w-0"
            />
          ))}
        </div>
      </ConfigurationRow>
    </ConfigurationGroup>
  );
};
export default DrillConfig;
