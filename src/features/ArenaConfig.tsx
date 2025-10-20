import React, {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {FormInput} from "@/components/ui/FormInput.tsx";
import {FormSelect} from "@/components/ui/FormSelect.tsx";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {DynamicConfig} from "@/types/dynamic";

interface ArenaConfigProps {
  profileId: string;
  onClose: () => void;
}

interface Draft {
  ArenaLevelDiff: number;
  ArenaComponentNumber: number;
  maxArenaRefreshTimes: number;
}

const ArenaConfig: React.FC<ArenaConfigProps> = ({profileId, onClose}) => {
  const {t} = useTranslation();
  const settings: Partial<DynamicConfig> = useWebSocketStore(state => state.configStore[profileId]);
  const modify = useWebSocketStore(state => state.modify);

  const ext = useMemo(() => {
    return {
      ArenaLevelDiff: settings.ArenaLevelDiff,
      ArenaComponentNumber: settings.ArenaComponentNumber,
      maxArenaRefreshTimes: settings.maxArenaRefreshTimes,
    } as Draft;
  }, [settings]);

  const [draft, setDraft] = useState<Draft>(ext);

  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  const handleChange = (key: string) => (value: string) => {
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue)) {
      setDraft((d) => ({...d, [key]: numValue}))
    }
  };

  const handleNumericChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const {name, value} = e.target;
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue)) {
      setDraft((d) => ({...d, [name]: numValue}))
    }
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
      <div className="space-y-2">
        <FormInput
          id="ArenaLevelDiff"
          name="ArenaLevelDiff"
          label={t("arena.higherLevel")}
          type="number"
          className="w-full"
          value={draft.ArenaLevelDiff}
          onChange={handleNumericChange}
          min="-89"
          max="89"
        />

        <FormInput
          id="maxArenaRefreshTimes"
          name="maxArenaRefreshTimes"
          label={t("arena.max_refresh_times")}
          type="number"
          className="w-full"
          value={draft.maxArenaRefreshTimes}
          onChange={handleNumericChange}
          min="0"
        />


        <FormSelect
          label={t("arena.opponent_no")}
          className="w-full"
          value={draft.ArenaComponentNumber.toString()}
          onChange={handleChange("ArenaComponentNumber")}
          options={[
            {value: "1", label: "1"},
            {value: "2", label: "2"},
            {value: "3", label: "3"},
          ]}
          placeholder={t("selectPlaceholder") || undefined}
        />

      </div>

      <div className="flex justify-end pt-4 border-t border-slate-200 dark:border-slate-700">
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="px-6 py-2 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors duration-200 disabled:opacity-60"
        >
          {t('save')}
        </button>
      </div>
    </div>
  );
};

export default ArenaConfig;
