import React, {Dispatch, SetStateAction} from "react";
import {useTranslation} from "react-i18next";
import {toast} from "sonner";
import {getTimestampMs} from "@/lib/utils.ts";
import {PageKey} from "@/types/app";
import {useWebSocketStore} from "@/store/websocketStore.ts";

type OtherConfigProps = {
  profileId: string;
  onClose: () => void;
  setActivePage?: Dispatch<SetStateAction<PageKey>>;
};

const OtherConfig: React.FC<OtherConfigProps> = (
  {
    profileId,
    onClose,
    setActivePage
  }
) => {
  const {t} = useTranslation();
  const trigger = useWebSocketStore(state => state.trigger);

  const handleTrigger = (taskName: string) => async () => {
    trigger({
      timestamp: getTimestampMs(),
      command: "solve",
      config_id: profileId,
      payload: {
        task: taskName,
      }
    }, (_) => {
      toast(t("stage.taskTriggerStart"), {
        description: t("stage.taskTriggered", {task: t(taskName)}),
      })
    });
    onClose();
    setActivePage?.("home")
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
        <div>
          <label className="text-slate-700 dark:text-slate-200 font-medium">
            {t("other.fhx")}
          </label>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("other.fhxDesc")}
          </p>
        </div>
        <button
          onClick={handleTrigger("start_fhx")}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors duration-200"
        >
          {t("execute")}
        </button>
      </div>
    </div>
  );
};

export default OtherConfig;
