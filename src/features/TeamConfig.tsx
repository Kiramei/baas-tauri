import React, { useMemo } from "react";
import {
  ConfigurationGroup,
  ConfigurationRow,
  ConfigurationSelect,
} from "@/components/configuration/ConfigurationControls";
import { FormSelect } from "@/components/ui/FormSelect";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import { propertyKey, teamMethodKey } from "@/shared/I18nKeys";

interface TeamConfigProps {
  profileId: string;
  onClose: () => void;
}
interface Draft {
  choose_team_method: string;
  side_team_attribute: string[][];
  preset_team_attribute: string[][];
}
const PROPERTY = ["burst", "pierce", "mystic", "shock", "Unused"];
const MODES = ["preset", "side", "order"];

const TeamConfig: React.FC<TeamConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const initial = useMemo<Draft>(
    () => ({
      choose_team_method: settings.choose_team_method,
      side_team_attribute: settings.side_team_attribute ?? [],
      preset_team_attribute: settings.preset_team_attribute ?? [],
    }),
    [settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId, "team", initial);
  const options = PROPERTY.map((value) => ({ value, label: t(propertyKey(value)) }));
  const changeCell = (
    key: "side_team_attribute" | "preset_team_attribute",
    row: number,
    column: number,
    value: string
  ) =>
    setDraft((previous) => ({
      ...previous,
      [key]: previous[key].map((entries, i) =>
        i === row ? entries.map((entry, j) => (j === column ? value : entry)) : entries
      ),
    }));
  const renderTable = (key: "side_team_attribute" | "preset_team_attribute") => (
    <div className="space-y-2">
      {draft[key].map((row, rowIndex) => (
        <div key={rowIndex} className="flex min-w-0 items-center gap-2">
          <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">
            {rowIndex + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap gap-2">
            {row.map((value, column) => (
              <FormSelect
                key={column}
                value={value}
                onChange={(next) => changeCell(key, rowIndex, column, next)}
                options={options}
                ariaLabel={t("team.chooseMethod") + " " + (rowIndex + 1) + " / " + (column + 1)}
                className="min-w-20 flex-1"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
  return (
    <ConfigurationGroup title={t("team")}>
      <ConfigurationSelect
        label={t("team.chooseMethod")}
        description={t("configurationHelp.teamMethod")}
        value={draft.choose_team_method}
        onChange={(value) => setDraft((previous) => ({ ...previous, choose_team_method: value }))}
        options={MODES.map((value) => ({ value, label: t(teamMethodKey(value)) }))}
      />
      {draft.choose_team_method === "preset" && (
        <ConfigurationRow
          label={t("team.preset")}
          description={t("configurationHelp.teamPreset")}
          className="configuration-row-stacked"
        >
          {renderTable("preset_team_attribute")}
        </ConfigurationRow>
      )}
      {draft.choose_team_method === "side" && (
        <ConfigurationRow
          label={t("team.side")}
          description={t("configurationHelp.teamSide")}
          className="configuration-row-stacked"
        >
          {renderTable("side_team_attribute")}
        </ConfigurationRow>
      )}
    </ConfigurationGroup>
  );
};
export default TeamConfig;
