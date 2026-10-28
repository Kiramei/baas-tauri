import React, { useId, useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationRow,
  ConfigurationToggle,
} from "@/components/configuration/ConfigurationControls";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/FormInput";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import {
  hasIncompleteTelegramCredentials,
  normalizePushConfig,
  serializePushConfig,
  supportsPushField,
  type PushConfigValues,
} from "./pushConfiguration";
import "@/components/configuration/configuration-forms.css";

interface PushConfigProps {
  profileId: string;
  onClose: () => void;
}
function SecretConfigurationInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const { t } = useAppTranslation();
  const [visible, setVisible] = useState(false);
  const inputId = useId();
  return (
    <ConfigurationRow
      label={label}
      description={description}
      className="configuration-row-responsive"
    >
      <div className="flex min-w-0 items-center gap-1">
        <FormInput
          id={inputId}
          aria-label={label}
          type={visible && !disabled ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="min-w-0 flex-1"
          disabled={disabled}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={
            visible
              ? t("push.hideSecret", { field: label })
              : t("push.showSecret", { field: label })
          }
          aria-pressed={visible}
          aria-controls={inputId}
          disabled={disabled}
          onClick={() => setVisible((previous) => !previous)}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
      </div>
    </ConfigurationRow>
  );
}
const PushConfig: React.FC<PushConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const initial = useMemo(() => normalizePushConfig(settings), [settings]);
  const [draft, setDraft] = useConfigurationDraft(profileId, "push", initial, {
    serialize: (value) => serializePushConfig(value, settings),
  });
  const fieldDescription = (field: keyof PushConfigValues, description: string) =>
    supportsPushField(settings, field)
      ? description
      : `${description} ${t("configurationHelp.backendUpdateRequired")}`;
  const change =
    <K extends keyof PushConfigValues>(key: K) =>
    (value: PushConfigValues[K]) =>
      setDraft((previous) => ({ ...previous, [key]: value }));
  return (
    <>
      <ConfigurationGroup title={t("push.triggers")}>
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
      </ConfigurationGroup>
      <ConfigurationGroup title={t("push.channels")}>
        <SecretConfigurationInput
          key={`${profileId}:json`}
          label={t("push.json")}
          description={t("configurationHelp.pushJson")}
          value={draft.push_json}
          onChange={change("push_json")}
          placeholder={t("placeholder.config.insert")}
        />
        <SecretConfigurationInput
          key={`${profileId}:serverchan`}
          label={t("push.serverchan")}
          description={t("configurationHelp.pushServerchan")}
          value={draft.push_serverchan}
          onChange={change("push_serverchan")}
          placeholder={t("placeholder.config.insert")}
        />
        <SecretConfigurationInput
          key={`${profileId}:feishu`}
          label={t("push.feishu")}
          description={fieldDescription("push_feishu", t("configurationHelp.pushFeishu"))}
          value={draft.push_feishu}
          onChange={change("push_feishu")}
          disabled={!supportsPushField(settings, "push_feishu")}
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
        />
        <SecretConfigurationInput
          key={`${profileId}:wecom`}
          label={t("push.wecom")}
          description={fieldDescription("push_wecom", t("configurationHelp.pushWecom"))}
          value={draft.push_wecom}
          onChange={change("push_wecom")}
          disabled={!supportsPushField(settings, "push_wecom")}
          placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
        />
      </ConfigurationGroup>
      <ConfigurationGroup title={t("push.telegram")}>
        <div className="settings-block">
          <p className="settings-description">{t("configurationHelp.pushTelegram")}</p>
          {supportsPushField(settings, "push_telegram_bot_token") &&
            supportsPushField(settings, "push_telegram_chat_id") &&
            hasIncompleteTelegramCredentials(draft) && (
              <p className="settings-description" role="status">
                {t("push.telegramIncomplete")}
              </p>
            )}
        </div>
        <SecretConfigurationInput
          key={`${profileId}:telegram-token`}
          label={t("push.telegramToken")}
          description={fieldDescription(
            "push_telegram_bot_token",
            t("configurationHelp.pushTelegramToken")
          )}
          value={draft.push_telegram_bot_token}
          onChange={change("push_telegram_bot_token")}
          disabled={!supportsPushField(settings, "push_telegram_bot_token")}
          placeholder={t("placeholder.config.insert")}
        />
        <ConfigurationInput
          label={t("push.telegramChatId")}
          className="configuration-row-responsive"
          description={fieldDescription(
            "push_telegram_chat_id",
            t("configurationHelp.pushTelegramChatId")
          )}
          value={draft.push_telegram_chat_id}
          onChange={(event) => change("push_telegram_chat_id")(event.target.value)}
          disabled={!supportsPushField(settings, "push_telegram_chat_id")}
          placeholder="123456789 / -1001234567890"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <SecretConfigurationInput
          key={`${profileId}:telegram-proxy`}
          label={t("push.telegramProxy")}
          description={fieldDescription(
            "push_telegram_proxy",
            t("configurationHelp.pushTelegramProxy")
          )}
          value={draft.push_telegram_proxy}
          onChange={change("push_telegram_proxy")}
          disabled={!supportsPushField(settings, "push_telegram_proxy")}
          placeholder="http://127.0.0.1:7890"
        />
        <ConfigurationInput
          label={t("push.telegramApi")}
          className="configuration-row-responsive"
          description={fieldDescription(
            "push_telegram_api",
            t("configurationHelp.pushTelegramApi")
          )}
          value={draft.push_telegram_api}
          onChange={(event) => change("push_telegram_api")(event.target.value)}
          disabled={!supportsPushField(settings, "push_telegram_api")}
          placeholder="https://api.telegram.org"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </ConfigurationGroup>
    </>
  );
};
export default PushConfig;
