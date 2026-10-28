import React, { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationRow,
} from "@/components/configuration/ConfigurationControls";
import { FormInput } from "@/components/ui/FormInput";
import { normalizeFriendCleanupConfig } from "@/features/issue528Config";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { toast } from "sonner";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import { serverMap } from "@/shared/GlobalUtilities";

interface WhiteListConfigProps {
  profileId: string;
  onClose: () => void;
}
interface Draft {
  clearFriendWhiteList: string[];
  levelLimit: string;
  lastLoginDays: string;
  lastTotalAssaultRankLimit: string;
}
const WhiteListConfig: React.FC<WhiteListConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const serverMode = serverMap[settings.server];
  const initial = useMemo<Draft>(() => {
    const current = normalizeFriendCleanupConfig(settings);
    return {
      clearFriendWhiteList: current.clearFriendWhiteList,
      levelLimit: String(current.levelLimit),
      lastLoginDays: String(current.lastLoginDays),
      lastTotalAssaultRankLimit: String(current.lastTotalAssaultRankLimit),
    };
  }, [settings]);
  const [draft, setDraft] = useConfigurationDraft(profileId, "whitelist", initial, {
    serialize: (value) => {
      const thresholds = [value.levelLimit, value.lastLoginDays, value.lastTotalAssaultRankLimit];
      if (
        thresholds.some(
          (entry) => !entry.trim() || !Number.isInteger(Number(entry)) || Number(entry) < -1
        )
      )
        return null;
      return {
        clear_friend_white_list: value.clearFriendWhiteList,
        clear_friend_level_limit: Number(value.levelLimit),
        clear_friend_last_login_time_days: Number(value.lastLoginDays),
        clear_friend_last_total_assault_rank_limit: Number(value.lastTotalAssaultRankLimit),
      };
    },
  });
  const [inputCode, setInputCode] = useState("");
  const addFriend = () => {
    const code = inputCode.trim();
    const expectedLength = serverMode === "JP" || serverMode === "Global" ? 8 : 7;
    let error: string | null = null;
    if (code.length !== expectedLength) error = t("friend.invalidLength");
    else if (serverMode === "CN" && !/^[0-9a-z]+$/.test(code)) error = t("friend.invalidFormatCN");
    else if (serverMode === "Global" && !/^[A-Z]+$/.test(code))
      error = t("friend.invalidFormatGlobal");
    else if (draft.clearFriendWhiteList.includes(code)) error = t("friend.alreadyExists");
    if (error) {
      toast.error(t("friend.addFailed"), { description: error });
      return;
    }
    setDraft((previous) => ({
      ...previous,
      clearFriendWhiteList: [...previous.clearFriendWhiteList, code],
    }));
    setInputCode("");
  };
  const change = (
    key: "levelLimit" | "lastLoginDays" | "lastTotalAssaultRankLimit",
    value: string
  ) => setDraft((previous) => ({ ...previous, [key]: value }));

  return (
    <div className="space-y-7">
      <ConfigurationGroup title={t("friend.filters")}>
        <ConfigurationInput
          type="number"
          min={-1}
          label={t("friend.levelLimit")}
          description={t("configurationHelp.friendLevel")}
          value={draft.levelLimit}
          onChange={(event) => change("levelLimit", event.target.value)}
        />
        <ConfigurationInput
          type="number"
          min={-1}
          label={t("friend.lastLoginDays")}
          description={t("configurationHelp.friendLogin")}
          value={draft.lastLoginDays}
          onChange={(event) => change("lastLoginDays", event.target.value)}
        />
        <ConfigurationInput
          type="number"
          min={-1}
          label={t("friend.lastTotalAssaultRankLimit")}
          description={t("configurationHelp.friendRank")}
          value={draft.lastTotalAssaultRankLimit}
          onChange={(event) => change("lastTotalAssaultRankLimit", event.target.value)}
        />
      </ConfigurationGroup>
      <ConfigurationGroup title={t("friend.whitelist")}>
        <ConfigurationRow
          label={t("friend.add")}
          description={t("configurationHelp.friendCode")}
          className="configuration-row-stacked"
        >
          <div className="flex min-w-0 items-center gap-2">
            <FormInput
              aria-label={t("friend.placeholder")}
              value={inputCode}
              onChange={(event) => setInputCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  addFriend();
                }
              }}
              placeholder={t("friend.placeholder")}
              className="min-w-0 flex-1"
            />
            <button type="button" onClick={addFriend} className="configuration-action shrink-0">
              {t("friend.add")}
            </button>
          </div>
        </ConfigurationRow>
        <ConfigurationRow
          label={t("friend.whitelist")}
          description={t("configurationHelp.friendWhitelist")}
          className="configuration-row-stacked"
        >
          <div className="flex min-w-0 flex-wrap gap-2">
            {draft.clearFriendWhiteList.map((code) => (
              <span
                key={code}
                className="inline-flex items-center gap-2 rounded-lg bg-secondary px-2.5 py-1.5 font-mono text-sm"
              >
                {code}
                <button
                  type="button"
                  aria-label={t("common.delete") + " " + code}
                  onClick={() =>
                    setDraft((previous) => ({
                      ...previous,
                      clearFriendWhiteList: previous.clearFriendWhiteList.filter(
                        (entry) => entry !== code
                      ),
                    }))
                  }
                  className="rounded text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
            {draft.clearFriendWhiteList.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("friend.empty")}</p>
            )}
          </div>
        </ConfigurationRow>
      </ConfigurationGroup>
    </div>
  );
};
export default WhiteListConfig;
