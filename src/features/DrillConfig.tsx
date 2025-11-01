import React, {useMemo, useState} from "react";
import {useTranslation} from "react-i18next";
import {FormSelect} from "@/components/ui/FormSelect.tsx";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import {Separator} from "@/components/ui/separator.tsx";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {DynamicConfig} from "@/types/dynamic";

type DrillConfigProps = {
  onClose: () => void;
  profileId?: string;
};

const DrillConfig: React.FC<DrillConfigProps> = ({
  onClose,
  profileId
}) => {
  const {t} = useTranslation();
  const settings: Partial<DynamicConfig> = useWebSocketStore(state => state.configStore[profileId!]);
  const modify = useWebSocketStore(state => state.modify);

  const party_nos = ["1", "2", "3", "4"];
  const total_assault_difficulties = ["1", "2", "3", "4"];

  // Hydrate the form with the latest drill configuration pulled from the server.
  const ext = useMemo(() => {
    return {
      drill_enable_sweep: settings.drill_enable_sweep,
      drill_fight_formation_list: settings.drill_fight_formation_list!.map(String),
      drill_difficulty_list: settings.drill_difficulty_list!.map(String)
    };
  }, [settings]);

  const [draft, setDraft] = useState(ext);
  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  // Generic updater for list-based selectors (party formation and difficulty).
  const handleListChange =
    (key: "drill_fight_formation_list" | "drill_difficulty_list", idx: number) =>
      (value: string) => {
        setDraft((prev) => {
          const list = [...prev[key]];
          list[idx] = value;
          return {...prev, [key]: list};
        });
      };

  // Persist current draft back to the backend if any values changed.
  const handleSave = async () => {
    const patch: Partial<DynamicConfig> = {
      drill_enable_sweep: draft.drill_enable_sweep,
      drill_fight_formation_list: draft.drill_fight_formation_list.map(Number),
      drill_difficulty_list: draft.drill_difficulty_list.map(Number),
    };
    modify(`${profileId}::config`, patch);
    onClose();
  };

  return (
    <div className="space-y-2">
      {/* Sweep toggle */}
      <SwitchButton
        label={t("drill.useAllAfterSweep")}
        checked={draft.drill_enable_sweep!}
        onChange={(val) =>
          setDraft((prev) => ({...prev, drill_enable_sweep: val}))
        }
        className="w-full"
      />

      <Separator/>

      {/* Party lineup configuration */}
      <div>
        <label className="block mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          {t("drill.out_partyNo")}
        </label>
        <div className="flex items-center gap-2">
          {draft.drill_fight_formation_list.map((val, i) => (
            <React.Fragment key={i}>
              <FormSelect
                value={val}
                onChange={handleListChange("drill_fight_formation_list", i)}
                options={party_nos.map((p) => ({value: p, label: p}))}
                className="flex-1"
              />
              {i !== draft.drill_fight_formation_list.length - 1 && (
                <span className="text-slate-400">/</span>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Difficulty sequencing */}
      <div>
        <label className="block mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          {t("drill.difficulty")}
        </label>
        <div className="flex items-center gap-2">
          {draft.drill_difficulty_list.map((val, i) => (
            <React.Fragment key={i}>
              <FormSelect
                value={val}
                onChange={handleListChange("drill_difficulty_list", i)}
                options={total_assault_difficulties.map((d) => ({
                  value: d,
                  label: d,
                }))}
                className="flex-1"
              />
              {i !== draft.drill_difficulty_list.length - 1 && (
                <span className="text-slate-400">/</span>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Save action */}
      <div className="flex justify-end pt-4 border-t border-slate-200 dark:border-slate-700 mt-4">
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="px-6 py-2 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors duration-200 disabled:opacity-60"
        >
          {t("save")}
        </button>
      </div>
    </div>
  );
};

export default DrillConfig;
