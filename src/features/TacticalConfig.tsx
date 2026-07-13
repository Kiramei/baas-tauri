import React, { useMemo } from "react";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { useTranslation } from "react-i18next";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { serverMap } from "@/shared/GlobalUtilities.ts";
import { DynamicConfig } from "@/types/dynamic";

type TacticalConfigProps = {
  onClose: () => void;
  profileId?: string;
};

interface Draft {
  totalForceFightDifficulty: string;
}

/** Renders the tactical config component. */
const TacticalConfig: React.FC<TacticalConfigProps> = ({ profileId, onClose }) => {
  const { t } = useTranslation();
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const settings: Partial<DynamicConfig> = useWebSocketStore(
    (state) => state.configStore[profileId!]
  );
  const modify = useWebSocketStore((state) => state.modify);

  const total_assault_difficulties = staticConfig.total_assault_difficulties[
    serverMap[settings.server!]
  ] as string[];

  /** Handles the ext workflow. */
  const ext = useMemo(() => {
    return {
      totalForceFightDifficulty: settings?.totalForceFightDifficulty,
    } as Draft;
  }, [settings]);

  const [draft, setDraft] = React.useState<Draft>(ext);

  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  /** Handles the handle save interaction. */
  const handleSave = () => {
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

  /** Handles the handle change interaction. */
  const handleChange = (key: keyof Draft) => (value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-6">
      <FormSelect
        label={t("tactical.hardLevel")}
        className="w-full"
        value={draft.totalForceFightDifficulty.toString()}
        onChange={handleChange("totalForceFightDifficulty")}
        options={total_assault_difficulties.map((level) => ({
          value: level,
          label: level,
        }))}
      />

      <div className="flex justify-end pt-4 border-t border-slate-200 dark:border-slate-700">
        <button
          disabled={!dirty}
          onClick={handleSave}
          className="px-6 py-2 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors duration-200 disabled:opacity-60"
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
};

export default TacticalConfig;
