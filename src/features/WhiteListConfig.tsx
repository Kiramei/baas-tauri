import React, {useState, useMemo} from "react";
import {useTranslation} from "react-i18next";
import {toast} from "sonner"
import {FormInput} from "@/components/ui/FormInput.tsx";
import {DynamicConfig} from "@/types/dynamic";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {serverMap} from "@/lib/utils.ts";

type WhiteListConfigProps = {
  onClose: () => void;
  profileId?: string;
};

const WhiteListConfig: React.FC<WhiteListConfigProps> = ({
                                                           onClose,
                                                           profileId
                                                         }) => {
  const {t} = useTranslation();
  const settings: Partial<DynamicConfig> = useWebSocketStore(state => state.configStore[profileId!]);
  const modify = useWebSocketStore(state => state.modify);
  const server_mode = serverMap[settings.server!]

  const ext = useMemo(() => {
    return {
      clear_friend_white_list: settings.clear_friend_white_list!
    };
  }, [settings]);

  const [inputCode, setInputCode] = useState("");
  const [draft, setDraft] = useState(ext);

  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);


  const validateCode = (code: string): string | null => {
    let expectedLen = 7;
    if (server_mode === "JP" || server_mode === "Global") expectedLen = 8;

    if (code.length !== expectedLen) {
      return t("friend.invalidLength");
    }
    if (server_mode === "CN") {
      if (!/^[0-9a-z]+$/.test(code)) return t("friend.invalidFormatCN");
    } else if (server_mode === "Global") {
      if (!/^[A-Z]+$/.test(code)) return t("friend.invalidFormatGlobal");
    }
    return null;
  };

  const handleAdd = async () => {
    const code = inputCode.trim();
    const error = validateCode(code);
    if (error) {
      toast.error(t("friend.addFailed"), {
        description: error,
      });
      return;
    }
    if (draft.clear_friend_white_list.includes(code)) {
      toast.error(t("friend.addFailed"), {
        description: t("friend.alreadyExists"),
      });
      return;
    }
    const newList = [...draft.clear_friend_white_list, code];
    setDraft((d)=> ({...d, clear_friend_white_list: newList}));
  };

  const handleDelete = async (code: string) => {
    const newList = draft.clear_friend_white_list.filter((c) => c !== code);
    setDraft((d)=> ({...d, clear_friend_white_list: newList}));
  };

  const handleSave = async () => {
    const patch: Partial<DynamicConfig> = {clear_friend_white_list: draft.clear_friend_white_list};
    modify(`${profileId}::config`, patch)
    onClose();
  }


  return (
    <div className="space-y-4">
      {/* Input + Add */}
      <div className="flex gap-2 items-center">
        <FormInput
          type="text"
          value={inputCode}
          onChange={(e) => setInputCode(e.target.value)}
          placeholder={t("friend.placeholder")}
          className="flex-1"
        />
        <button
          onClick={handleAdd}
          className="px-4 py-1.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
        >
          {t("friend.add")}
        </button>
      </div>

      {/* Whitelist Showcase  */}
      <div className="flex flex-wrap gap-2">
        {draft.clear_friend_white_list.map((code) => (
          <span
            key={code}
            className="inline-flex items-center px-3 py-1 rounded-full bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100 font-mono font-bold"
          >
            {code}
            <button
              onClick={() => handleDelete(code)}
              className="ml-2 text-red-600 hover:text-red-800 dark:text-red-400"
            >
              ✕
            </button>
          </span>
        ))}
        {draft.clear_friend_white_list.length === 0 && (
          <p className="text-slate-500 text-sm">{t("friend.empty")}</p>
        )}
      </div>

      {/* Save Button */}
      <div className="flex justify-end pt-4 border-t border-slate-200 dark:border-slate-700 mt-4">
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

export default WhiteListConfig;
