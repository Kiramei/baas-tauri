import React, {useMemo, useState} from "react";
import SwitchButton from "@/components/ui/SwitchButton";
import {FormInput} from "@/components/ui/FormInput";
import {useTranslation} from "react-i18next";
import {DynamicConfig} from "@/types/dynamic";
import {useWebSocketStore} from "@/store/websocketStore.ts";

type PushConfigProps = {
  profileId: string;
  onClose: () => void;
};

interface Draft {
  push_after_error: boolean;
  push_after_completion: boolean;
  push_json: string;
  push_serverchan: string;
}

const PushConfig: React.FC<PushConfigProps> = ({
                                                 profileId,
                                                 onClose
                                               }) => {
  const {t} = useTranslation();
  const settings: Partial<DynamicConfig> = useWebSocketStore(state => state.configStore[profileId]);
  const modify = useWebSocketStore(state => state.modify);

  const ext = useMemo(() => {
    return {
      push_json: settings.push_json,
      push_serverchan: settings.push_serverchan,
      push_after_error: settings.push_after_error,
      push_after_completion: settings.push_after_completion
    } as Draft;
  }, [settings]);

  const [draft, setDraft] = useState<Draft>(ext);

  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  const handleChange =
    <K extends keyof Draft>(key: K) =>
      (value: Draft[K]) => {
        setDraft((prev) => ({...prev, [key]: value}));
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
    <div className="space-y-6">
      <div className="w-full flex gap-2 lg:flex-row max-lg:flex-col">
        <SwitchButton
          label={t("push.afterError")}
          checked={draft.push_after_error}
          onChange={handleChange("push_after_error")}
          className="flex-1"
        />

        <SwitchButton
          label={t("push.afterCompletion")}
          checked={draft.push_after_completion}
          onChange={handleChange("push_after_completion")}
          className="flex-1"
        />
      </div>

      <FormInput
        label={t("push.json")}
        value={draft.push_json}
        onChange={(e) => handleChange("push_json")(e.target.value)}
        placeholder={t("placeholder.config.insert")}
      />

      <FormInput
        label={t("push.serverchan")}
        value={draft.push_serverchan}
        onChange={(e) => handleChange("push_serverchan")(e.target.value)}
        placeholder={t("placeholder.config.insert")}
      />

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

export default PushConfig;
