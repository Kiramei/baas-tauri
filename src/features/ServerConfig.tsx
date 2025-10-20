import React from 'react';
import {useTranslation} from 'react-i18next';
import {FormSelect} from "@/components/ui/FormSelect.tsx";
import {FormInput} from "@/components/ui/FormInput.tsx";
import ADBSeekModal from "@/components/ADBSeekModal.tsx";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {DynamicConfig} from "@/types/dynamic";

interface ServerConfigProps {
  profileId: string;
  onClose: () => void;
}

interface Draft {
  server: string;
  adbIP: string;
  adbPort: string;
}

const ServerConfig: React.FC<ServerConfigProps> = ({profileId, onClose}) => {
  const {t} = useTranslation();
  const settings = useWebSocketStore(state => state.configStore[profileId])
  const modify = useWebSocketStore(state => state.modify);

  const ext = React.useMemo(() => {
    return {
      server: settings.server,
      adbIP: settings.adbIP,
      adbPort: settings.adbPort
    }
  }, [settings]);

  const [draft, setDraft] = React.useState(ext);
  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  const handleChange = (key: string) => (value: string) => {
    setDraft(prev => ({...prev, [key]: value}));
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
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const {name, value} = e.target;
    setDraft(prev => ({...prev, [name]: value}));
  }

  return (
    <div className="space-y-2">
      <FormSelect
        label={t('server.server')}
        value={draft.server}
        onChange={handleChange("server")}
        options={[
          {label: t('server.cn.official'), value: "官服"},
          {label: t('server.cn.bilibili'), value: "B服"},
          {label: t('server.global'), value: "国际服"},
          {label: t('server.global.teen'), value: "国际服青少年"},
          {label: t('server.kr.one'), value: "韩国ONE"},
          {label: t('server.jp'), value: "日服"},
        ]}
      />

      <FormInput
        id="adbIP"
        name="adbIP"
        type="text"
        label={t('server.adbIP')}
        value={draft.adbIP}
        onChange={handleInputChange}
        className="w-full"
        placeholder="127.0.0.1"
      />

      <div className="flex items-end justify-end gap-2">
        <FormInput
          id="adbPort"
          name="adbPort"
          label={t('server.adbPort')}
          type="number"
          value={draft.adbPort}
          onChange={handleInputChange}
          className="flex-1"
          min={0}
          max={65535}
        />

        <ADBSeekModal onSelect={
          (address) => {
            setDraft(prev => {
              const [ip, port] = address.split(':');
              return {...prev, adbIP: ip, adbPort: port}
            })
          }
        }/>
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

export default ServerConfig;
