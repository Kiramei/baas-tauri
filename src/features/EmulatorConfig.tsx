import React, {useMemo, useState} from "react";
import {useTranslation} from "react-i18next";
import {FormInput} from "@/components/ui/FormInput";
import {FormSelect} from "@/components/ui/FormSelect";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import {DynamicConfig} from "@/types/dynamic";
import {useWebSocketStore} from "@/store/websocketStore.ts";

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
  mumu: "MuMu模拟器",
  mumu_global: "MuMu模拟器全球版",
  bluestacks_nxt_cn: "蓝叠模拟器",
  bluestacks_nxt: "蓝叠国际版",
};

const EmulatorConfig: React.FC<EmulatorConfigProps> = (
  {
    profileId,
    onClose
  }
) => {
  const {t} = useTranslation();

  const settings: Partial<DynamicConfig> = useWebSocketStore(state => state.configStore[profileId]);
  const modify = useWebSocketStore(state => state.modify);

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

  const handleChange =
    (key: keyof Draft) =>
      (value: string | boolean) => {
        setDraft((prev) => ({...prev, [key]: value as any}));
      };

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
    modify(`${profileId}::config`, patch)

    onClose();
  };

  return (
    <div className="@container space-y-2">

      <div className="flex @lg:flex-row @max-lg:flex-col gap-2">
        {/* 是否启动时打开模拟器 */}
        <SwitchButton
          label={t("emulator.openOnLaunch")}
          checked={draft.open_emulator_stat}
          onChange={(v) => handleChange("open_emulator_stat")(v)}
          className="w-full"
        />

        {/* 是否多开 */}
        <SwitchButton
          label={t("emulator.multiInstance")}
          checked={draft.emulatorIsMultiInstance}
          onChange={(v) => handleChange("emulatorIsMultiInstance")(v)}
          className="w-full"
        />
      </div>


      {/* 启动等待时间 */}
      <FormInput
        type="number"
        label={t("emulator.waitTime")}
        value={draft.emulator_wait_time}
        onChange={(e) => handleChange("emulator_wait_time")(e.target.value)}
        placeholder="5"
      />


      {/* 单开模式 */}
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
              placeholder="C:\\Path\\to\\MuMuPlayer.exe"
              className="flex-1"
            />
            {/*<button*/}
            {/*  type="button"*/}
            {/*  className="px-3 py-1.5 bg-slate-200 dark:bg-slate-700 rounded-md"*/}
            {/*  onClick={() => {*/}
            {/* TODO: integrate the platform file picker once available. */}
            {/*    alert("选择文件逻辑待实现");*/}
            {/*  }}*/}
            {/*>*/}
            {/*  {t("choose")}*/}
            {/*</button>*/}
          </div>
        </div>
      )}

      {/* 多开模式 */}
      {draft.emulatorIsMultiInstance && (
        <div className="space-y-4">
          <FormSelect
            label={t("emulator.multiType")}
            value={draft.multiEmulatorName}
            onChange={handleChange("multiEmulatorName")}
            options={Object.entries(multiMap).map(([k, v]) => ({
              value: k,
              label: v,
            }))}
          />

          <FormInput
            type="number"
            label={t("emulator.instanceCount")}
            value={draft.emulatorMultiInstanceNumber}
            onChange={(e) =>
              handleChange("emulatorMultiInstanceNumber")(e.target.value)
            }
          />
        </div>
      )}

      {/* 保存按钮 */}
      <div className="flex justify-end pt-4 border-t border-slate-200 dark:border-slate-700">
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

export default EmulatorConfig;
