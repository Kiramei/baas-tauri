import React, { useState, useMemo } from "react";
import {
  createFriendCleanupPatch,
  normalizeFriendCleanupConfig,
  parseBoundedInteger,
  type FriendCleanupDraft,
} from "@/features/issue528Config";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FormInput } from "@/components/ui/FormInput.tsx";
import { DynamicConfig } from "@/types/dynamic";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { serverMap } from "@/shared/GlobalUtilities.ts";

type WhiteListConfigProps = {
  onClose: () => void;
  profileId: string;
};

/** Renders the white list config component. */
const WhiteListConfig: React.FC<WhiteListConfigProps> = ({ onClose, profileId }) => {
  const { t } = useTranslation();
  const settings: Partial<DynamicConfig> = useWebSocketStore(
    (state) => state.configStore[profileId]
  );
  const modify = useWebSocketStore((state) => state.modify);
  const serverMode = serverMap[settings.server!];
  const current = useMemo(() => normalizeFriendCleanupConfig(settings), [settings]);

  const [inputCode, setInputCode] = useState("");
  const [draft, setDraft] = useState(current);

  const dirty = JSON.stringify(draft) !== JSON.stringify(current);

  const validateCode = (code: string): string | null => {
    let expectedLen = 7;
    if (serverMode === "JP" || serverMode === "Global") expectedLen = 8;

    if (code.length !== expectedLen) {
      return t("friend.invalidLength");
    }
    if (serverMode === "CN") {
      if (!/^[0-9a-z]+$/.test(code)) return t("friend.invalidFormatCN");
    } else if (serverMode === "Global") {
      if (!/^[A-Z]+$/.test(code)) return t("friend.invalidFormatGlobal");
    }
    return null;
  };

  /** Handles the handle add interaction. */
  const handleAdd = async () => {
    const code = inputCode.trim();
    const error = validateCode(code);
    if (error) {
      toast.error(t("friend.addFailed"), {
        description: error,
      });
      return;
    }
    if (draft.clearFriendWhiteList.includes(code)) {
      toast.error(t("friend.addFailed"), {
        description: t("friend.alreadyExists"),
      });
      return;
    }
    const newList = [...draft.clearFriendWhiteList, code];
    setDraft((d) => ({ ...d, clearFriendWhiteList: newList }));
  };

  /** Handles the handle delete interaction. */
  const handleDelete = async (code: string) => {
    const newList = draft.clearFriendWhiteList.filter((c) => c !== code);
    setDraft((d) => ({ ...d, clearFriendWhiteList: newList }));
  };

  const handleThresholdChange = (
    field: keyof Pick<
      FriendCleanupDraft,
      "levelLimit" | "lastLoginDays" | "lastTotalAssaultRankLimit"
    >,
    value: string
  ) => {
    const parsed = parseBoundedInteger(value, -1);
    if (parsed !== null) setDraft((currentDraft) => ({ ...currentDraft, [field]: parsed }));
  };

  /** Handles the handle save interaction. */
  const handleSave = async () => {
    const patch = createFriendCleanupPatch(current, draft);
    if (Object.keys(patch).length > 0) modify(`${profileId}::config`, patch);
    onClose();
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{t("friend.filters")}</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {t("friend.disabledThresholdHint")}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <FormInput
            type="number"
            min={-1}
            label={t("friend.levelLimit")}
            value={draft.levelLimit}
            onChange={(event) => handleThresholdChange("levelLimit", event.target.value)}
          />
          <FormInput
            type="number"
            min={-1}
            label={t("friend.lastLoginDays")}
            value={draft.lastLoginDays}
            onChange={(event) => handleThresholdChange("lastLoginDays", event.target.value)}
          />
          <FormInput
            type="number"
            min={-1}
            label={t("friend.lastTotalAssaultRankLimit")}
            value={draft.lastTotalAssaultRankLimit}
            onChange={(event) =>
              handleThresholdChange("lastTotalAssaultRankLimit", event.target.value)
            }
          />
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t("friend.whitelist")}</h3>
        <div className="flex items-center gap-2">
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

        <div className="flex flex-wrap gap-2">
          {draft.clearFriendWhiteList.map((code) => (
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
          {draft.clearFriendWhiteList.length === 0 && (
            <p className="text-slate-500 text-sm">{t("friend.empty")}</p>
          )}
        </div>
      </section>

      {/* Save Button */}
      <div className="flex justify-end pt-4 border-t border-slate-200 dark:border-slate-700 mt-4">
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

export default WhiteListConfig;
