import React, { useMemo } from "react";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationRow,
  ConfigurationSelect,
  ConfigurationToggle,
} from "@/components/configuration/ConfigurationControls";
import { FormInput } from "@/components/ui/FormInput";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import StorageUtil from "@/shared/StorageManager";

interface EmulatorConfigProps {
  profileId: string;
  onClose: () => void;
}
interface Draft {
  open_emulator_stat: boolean;
  emulator_wait_time: string;
  emulatorIsMultiInstance: boolean;
  program_address: string;
  emulatorMultiInstanceNumber: string;
  multiEmulatorName: string;
}
const emulatorTypes = [
  "mumu",
  "mumu_global",
  "bluestacks_nxt_cn",
  "bluestacks_nxt",
  "yeshen",
  "xiaoyao_nat",
  "leidian",
  "wsa",
] as const;

const EmulatorConfig: React.FC<EmulatorConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const initial = useMemo<Draft>(
    () => ({
      open_emulator_stat: settings.open_emulator_stat,
      emulator_wait_time: String(settings.emulator_wait_time ?? "5"),
      emulatorIsMultiInstance: settings.emulatorIsMultiInstance,
      program_address: settings.program_address ?? "",
      emulatorMultiInstanceNumber: String(settings.emulatorMultiInstanceNumber ?? 0),
      multiEmulatorName: settings.multiEmulatorName,
    }),
    [settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId, "emulator", initial, {
    serialize: (value) => {
      const wait = Number(value.emulator_wait_time);
      const instance = Number(value.emulatorMultiInstanceNumber);
      if (
        !value.emulator_wait_time.trim() ||
        !Number.isFinite(wait) ||
        wait < 0 ||
        !value.emulatorMultiInstanceNumber.trim() ||
        !Number.isInteger(instance) ||
        instance < 0
      )
        return null;
      return { ...value, emulatorMultiInstanceNumber: instance };
    },
  });
  const change =
    <K extends keyof Draft>(key: K) =>
    (value: Draft[K]) =>
      setDraft((previous) => ({ ...previous, [key]: value }));
  const typeLabels: Record<string, string> = {
    mumu: t("emulator.types.mumu"),
    mumu_global: t("emulator.types.mumuGlobal"),
    bluestacks_nxt_cn: t("emulator.types.bluestacksCn"),
    bluestacks_nxt: t("emulator.types.bluestacksGlobal"),
    yeshen: t("emulator.types.yeshen"),
    xiaoyao_nat: t("emulator.types.xiaoyaoNat"),
    leidian: t("emulator.types.leidian"),
    wsa: t("emulator.types.wsa"),
  };

  return (
    <div className="space-y-7">
      <ConfigurationGroup title={t("emulator.openOnLaunch")}>
        <ConfigurationToggle
          label={t("emulator.openOnLaunch")}
          description={t("configurationHelp.emulatorLaunch")}
          checked={draft.open_emulator_stat}
          onChange={change("open_emulator_stat")}
        />
        <ConfigurationInput
          type="number"
          label={t("emulator.waitTime")}
          description={t("configurationHelp.emulatorWait")}
          value={draft.emulator_wait_time}
          onChange={(event) => change("emulator_wait_time")(event.target.value)}
          min={0}
        />
      </ConfigurationGroup>
      <ConfigurationGroup title={t("emulator")}>
        <ConfigurationRow
          label={t("emulator.address")}
          description={t("configurationHelp.emulatorPath")}
          className="configuration-row-stacked"
        >
          <div className="flex min-w-0 items-center gap-2">
            <FormInput
              aria-label={t("emulator.address")}
              value={draft.program_address}
              onChange={(event) => change("program_address")(event.target.value)}
              placeholder="C:\\Path\\to\\emulator.exe"
              className="min-w-0 flex-1"
            />
            {__WITH_TAURI__ && (
              <button
                type="button"
                className="configuration-action shrink-0"
                onClick={async () => {
                  const path = await StorageUtil.retrievePath(t("description.getEmulator"), [
                    { name: "Executable File", extensions: ["exe", "bin", "app", "*"] },
                  ]);
                  if (path) change("program_address")(path);
                }}
              >
                {t("common.choose")}
              </button>
            )}
          </div>
        </ConfigurationRow>
        <ConfigurationSelect
          label={t("emulator.multiType")}
          value={draft.multiEmulatorName}
          onChange={change("multiEmulatorName")}
          options={emulatorTypes.map((value) => ({ value, label: typeLabels[value] }))}
        />
        <ConfigurationToggle
          label={t("emulator.multiInstance")}
          description={t("configurationHelp.emulatorMulti")}
          checked={draft.emulatorIsMultiInstance}
          onChange={change("emulatorIsMultiInstance")}
        />
        {draft.emulatorIsMultiInstance && (
          <ConfigurationInput
            type="number"
            label={t("emulator.instanceCount")}
            description={t("configurationHelp.emulatorInstance")}
            value={draft.emulatorMultiInstanceNumber}
            onChange={(event) => change("emulatorMultiInstanceNumber")(event.target.value)}
            min={0}
          />
        )}
      </ConfigurationGroup>
    </div>
  );
};
export default EmulatorConfig;
