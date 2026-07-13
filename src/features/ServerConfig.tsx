import React from "react";
import { useTranslation } from "react-i18next";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import ADBSeekModal from "@/components/ADBSeekModal.tsx";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { DynamicConfig } from "@/types/dynamic";
import { buildServerOptions } from "@/shared/serverOptions";

interface ServerConfigProps {
  profileId: string;
  onClose: () => void;
}

interface Draft {
  server: string;
  adbIP: string;
  adbPort: string;
}

/** Renders the server config component. */
const ServerConfig: React.FC<ServerConfigProps> = ({ profileId, onClose }) => {
  const { t } = useTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const modify = useWebSocketStore((state) => state.modify);

  /** Handles the ext workflow. */
  const ext = React.useMemo(() => {
    return {
      server: settings.server,
      adbIP: settings.adbIP,
      adbPort: settings.adbPort,
    };
  }, [settings]);

  const [draft, setDraft] = React.useState(ext);
  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  /** Handles the handle change interaction. */
  const handleChange = (key: string) => (value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
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

  /** Handles the handle input change interaction. */
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setDraft((prev) => ({ ...prev, [name]: value }));
  };

  return (
    <div className="space-y-2">
      <FormSelect
        label={t("server.server")}
        value={draft.server}
        disabled={true}
        onChange={handleChange("server")}
        options={buildServerOptions(t)}
      />

      <FormInput
        id="adbIP"
        name="adbIP"
        type="text"
        label={t("server.adbIP")}
        value={draft.adbIP}
        onChange={handleInputChange}
        className="w-full"
        placeholder="127.0.0.1"
      />

      <div className="flex items-end justify-end gap-2">
        <FormInput
          id="adbPort"
          name="adbPort"
          label={t("server.adbPort")}
          type="number"
          value={draft.adbPort}
          onChange={handleInputChange}
          className="flex-1"
          min={0}
          max={65535}
        />

        <ADBSeekModal
          onSelect={(address) => {
            setDraft((prev) => {
              const [ip, port] = address.split(":");
              return { ...prev, adbIP: ip, adbPort: port };
            });
          }}
        />
      </div>

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

export default ServerConfig;
