import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormInput } from "@/components/ui/FormInput";
import { FormSelect } from "@/components/ui/FormSelect";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import { DynamicConfig } from "@/types/dynamic";
import { useWebSocketStore } from "@/store/WebsocketStore";
import StorageUtil from "@/shared/StorageManager.ts";

type EmulatorConfigProps = {
  profileId: string;
  onClose: () => void;
};

interface Draft {
  open_emulator_stat: boolean;
  emulator_wait_time: string;
  emulatorIsMultiInstance: boolean;
  program_address: string;
  emulatorMultiInstanceNumber: number;
  multiEmulatorName: string;
}

const multiMap: Record<string, string> = {
  mumu: "mumu",
  mumu_global: "mumu_global",
  bluestacks_nxt_cn: "bluestacks_nxt_cn",
  bluestacks_nxt: "bluestacks_nxt",
  yeshen: "yeshen",
  xiaoyao_nat: "xiaoyao_nat",
  leidian: "leidian",
  wsa: "wsa",
};

/** Renders the emulator config component. */
const EmulatorConfig: React.FC<EmulatorConfigProps> = ({ profileId, onClose }) => {
  const { t } = useTranslation();

  const settings: Partial<DynamicConfig> = useWebSocketStore(
    (state) => state.configStore[profileId]
  );
  const modify = useWebSocketStore((state) => state.modify);

  /** Handles the ext workflow. */
  const ext = useMemo<Draft>(() => {
    return {
      open_emulator_stat: settings.open_emulator_stat,
      emulator_wait_time: settings.emulator_wait_time,
      emulatorIsMultiInstance: settings.emulatorIsMultiInstance,
      program_address: settings.program_address,
      emulatorMultiInstanceNumber: settings.emulatorMultiInstanceNumber,
      multiEmulatorName: settings.multiEmulatorName,
    } as Draft;
  }, [settings]);

  const [draft, setDraft] = useState<Draft>(ext);

  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  /** Handles the handle change interaction. */
  const handleChange = (key: keyof Draft) => (value: string | boolean) => {
    setDraft((prev) => ({ ...prev, [key]: value as any }));
  };

  /** Handles the emulator type label workflow. */
  const emulatorTypeLabel = (key: string) => {
    switch (key) {
      case "mumu":
        return t("emulator.types.mumu");
      case "mumu_global":
        return t("emulator.types.mumuGlobal");
      case "bluestacks_nxt_cn":
        return t("emulator.types.bluestacksCn");
      case "bluestacks_nxt":
        return t("emulator.types.bluestacksGlobal");
      case "yeshen":
        return t("emulator.types.yeshen");
      case "xiaoyao_nat":
        return t("emulator.types.xiaoyaoNat");
      case "leidian":
        return t("emulator.types.leidian");
      case "wsa":
        return t("emulator.types.wsa");
      default:
        return key;
    }
  };

  /** Handles the handle save interaction. */
  const handleSave = async () => {
    const patch: Partial<DynamicConfig> = {};
    (Object.keys(draft) as (keyof Draft)[]).forEach((k) => {
      if (JSON.stringify(draft[k]) !== JSON.stringify(ext[k])) {
        (patch as any)[k] = draft[k];
      }
    });

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    modify(`${profileId}::config`, patch);

    onClose();
  };

  return (
    <div className="@container space-y-2">
      <div className="flex @lg:flex-row @max-lg:flex-col gap-2">
        {/* Whether to open the emulator on launch. */}
        <SwitchButton
          label={t("emulator.openOnLaunch")}
          checked={draft.open_emulator_stat}
          onChange={(v) => handleChange("open_emulator_stat")(v)}
          className="w-full"
        />

        {/* Whether to use multiple emulator instances. */}
        <SwitchButton
          label={t("emulator.multiInstance")}
          checked={draft.emulatorIsMultiInstance}
          onChange={(v) => handleChange("emulatorIsMultiInstance")(v)}
          className="w-full"
        />
      </div>

      {/* Launch wait time. */}
      <FormInput
        type="number"
        label={t("emulator.waitTime")}
        value={draft.emulator_wait_time}
        onChange={(e) => handleChange("emulator_wait_time")(e.target.value)}
        placeholder="5"
      />

      {/* Single-instance mode. */}
      {!draft.emulatorIsMultiInstance && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t("emulator.address")}
          </label>
          <div className="flex gap-2">
            <FormInput
              type="text"
              value={draft.program_address}
              onChange={(e) => handleChange("program_address")(e.target.value)}
              placeholder="C:\\Path\to\emulator.exe"
              className="flex-1"
            />
            {__WITH_TAURI__ && (
              <button
                type="button"
                className="px-3 py-1.5 bg-slate-200 dark:bg-slate-700 rounded-md"
                onClick={async () => {
                  const path = await StorageUtil.retrievePath(t("description.getEmulator"), [
                    { name: "Executable File", extensions: ["exe", "bin", "app", "*"] },
                  ]);
                  if (!path) return;
                  setDraft((state) => ({ ...state, program_address: path }));
                }}
              >
                {t("common.choose")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Multi-instance mode. */}
      {draft.emulatorIsMultiInstance && (
        <div className="space-y-4">
          <FormSelect
            label={t("emulator.multiType")}
            value={draft.multiEmulatorName}
            onChange={handleChange("multiEmulatorName")}
            options={Object.keys(multiMap).map((k) => ({
              value: k,
              label: emulatorTypeLabel(k),
            }))}
          />

          <FormInput
            type="number"
            label={t("emulator.instanceCount")}
            value={draft.emulatorMultiInstanceNumber}
            onChange={(e) => handleChange("emulatorMultiInstanceNumber")(e.target.value)}
          />
        </div>
      )}

      {/* Save button. */}
      <div className="flex justify-end pt-4 border-t border-slate-200 dark:border-slate-700">
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="px-6 py-2 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors duration-200 disabled:opacity-60"
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
};

export default EmulatorConfig;
