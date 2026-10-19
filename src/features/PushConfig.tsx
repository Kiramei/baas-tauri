import React, { useMemo } from "react";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationToggle,
} from "@/components/configuration/ConfigurationControls";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";

interface PushConfigProps {
  profileId: string;
  onClose: () => void;
}
interface Draft {
  push_after_error: boolean;
  push_after_completion: boolean;
  push_json: string;
  push_serverchan: string;
}
const PushConfig: React.FC<PushConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const initial = useMemo<Draft>(
    () => ({
      push_json: settings.push_json ?? "",
      push_serverchan: settings.push_serverchan ?? "",
      push_after_error: settings.push_after_error ?? false,
      push_after_completion: settings.push_after_completion ?? false,
    }),
    [settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId, "push", initial);
  const change =
    <K extends keyof Draft>(key: K) =>
    (value: Draft[K]) =>
      setDraft((previous) => ({ ...previous, [key]: value }));
  return (
    <ConfigurationGroup title={t("push")}>
      <ConfigurationToggle
        label={t("push.afterError")}
        description={t("configurationHelp.pushError")}
        checked={draft.push_after_error}
        onChange={change("push_after_error")}
      />
      <ConfigurationToggle
        label={t("push.afterCompletion")}
        description={t("configurationHelp.pushCompletion")}
        checked={draft.push_after_completion}
        onChange={change("push_after_completion")}
      />
      <ConfigurationInput
        label={t("push.json")}
        description={t("configurationHelp.pushJson")}
        value={draft.push_json}
        onChange={(event) => change("push_json")(event.target.value)}
        placeholder={t("placeholder.config.insert")}
      />
      <ConfigurationInput
        label={t("push.serverchan")}
        description={t("configurationHelp.pushServerchan")}
        value={draft.push_serverchan}
        onChange={(event) => change("push_serverchan")(event.target.value)}
        placeholder={t("placeholder.config.insert")}
      />
    </ConfigurationGroup>
  );
};
export default PushConfig;
