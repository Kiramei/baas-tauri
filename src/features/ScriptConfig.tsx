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

interface ScriptConfigProps {
  profileId: string;
  onClose: () => void;
}
interface Draft {
  screenshot_interval: string;
  autostart: boolean;
  then: string;
  screenshot_method: string;
  control_method: string;
}
const ANDROID_LOCAL_METHOD = "android_local";

const ScriptConfig: React.FC<ScriptConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const initial = useMemo<Draft>(
    () => ({
      screenshot_interval: String(settings.screenshot_interval ?? "0.3"),
      autostart: settings.autostart,
      then: settings.then,
      screenshot_method: __WITH_ANDROID__ ? ANDROID_LOCAL_METHOD : settings.screenshot_method,
      control_method: __WITH_ANDROID__ ? ANDROID_LOCAL_METHOD : settings.control_method,
    }),
    [settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId, "script", initial, {
    serialize: (value) => {
      if (
        !value.screenshot_interval.trim() ||
        !Number.isFinite(Number(value.screenshot_interval)) ||
        Number(value.screenshot_interval) < 0.1
      )
        return null;
      const { screenshot_method, control_method, ...common } = value;
      return __WITH_ANDROID__ ? common : { ...common, screenshot_method, control_method };
    },
  });
  const change =
    <K extends keyof Draft>(key: K) =>
    (value: Draft[K]) =>
      setDraft((previous) => ({ ...previous, [key]: value }));

  const methodCopy: Record<string, { label: string; screenshot: string; control?: string }> = {
    adb: {
      label: "ADB",
      screenshot: t("configurationMethods.adbScreenshot"),
      control: t("configurationMethods.adbControl"),
    },
    nemu: {
      label: "Nemu",
      screenshot: t("configurationMethods.nemuScreenshot"),
      control: t("configurationMethods.nemuControl"),
    },
    uiautomator2: {
      label: "uiautomator2",
      screenshot: t("configurationMethods.uiautomator2Screenshot"),
      control: t("configurationMethods.uiautomator2Control"),
    },
    scrcpy: {
      label: "scrcpy",
      screenshot: t("configurationMethods.scrcpyScreenshot"),
      control: t("configurationMethods.scrcpyControl"),
    },
    mss: {
      label: "MSS",
      screenshot: t("configurationMethods.mssScreenshot"),
    },
    pyautogui: {
      label: "PyAutoGUI",
      screenshot: t("configurationMethods.pyautoguiScreenshot"),
      control: t("configurationMethods.pyautoguiControl"),
    },
  };
  const methodOptions = (methods: unknown, selected: string) => {
    const values = Array.isArray(methods)
      ? methods.filter((value): value is string => typeof value === "string")
      : [];
    if (selected && !values.includes(selected)) values.push(selected);
    return [...new Set(values)].map((value) => ({
      value,
      label: methodCopy[value]?.label ?? value,
    }));
  };

  return (
    <div className="space-y-7">
      <ConfigurationGroup title={t("script")}>
        <ConfigurationToggle
          label={t("script.autostart")}
          description={t("configurationHelp.scriptAutostart")}
          checked={draft.autostart}
          onChange={change("autostart")}
        />
        <ConfigurationSelect
          label={t("script.then")}
          description={t("configurationHelp.scriptThen")}
          value={draft.then}
          onChange={change("then")}
          options={[
            { label: t("script.doNothing"), value: "无动作" },
            { label: t("script.exitBaas"), value: "退出 Baas" },
            { label: t("script.exitEmu"), value: "退出 模拟器" },
            { label: t("script.exitBoth"), value: "退出 Baas 和 模拟器" },
            { label: t("script.shutdown"), value: "关机" },
          ]}
        />
      </ConfigurationGroup>
      <ConfigurationGroup title={t("script.screenshotMethod")}>
        <ConfigurationInput
          type="number"
          label={t("script.screenshotInterval")}
          description={t("configurationHelp.screenshotInterval")}
          value={draft.screenshot_interval}
          onChange={(event) => change("screenshot_interval")(event.target.value)}
          min={0.1}
          step={0.1}
          placeholder="1.0"
        />
        {!__WITH_ANDROID__ && (
          <>
            <ConfigurationSelect
              label={t("script.screenshotMethod")}
              description={
                methodCopy[draft.screenshot_method]?.screenshot ??
                t("configurationHelp.screenshotMethod")
              }
              value={draft.screenshot_method}
              onChange={change("screenshot_method")}
              options={methodOptions(staticConfig.screenshot_methods, draft.screenshot_method)}
            />
            <ConfigurationSelect
              label={t("script.controlMethod")}
              description={
                methodCopy[draft.control_method]?.control ?? t("configurationHelp.controlMethod")
              }
              value={draft.control_method}
              onChange={change("control_method")}
              options={methodOptions(staticConfig.control_methods, draft.control_method)}
            />
          </>
        )}
      </ConfigurationGroup>
    </div>
  );
};
export default ScriptConfig;
