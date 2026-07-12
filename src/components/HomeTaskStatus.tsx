import { Hourglass, List } from "lucide-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { useBackendStore } from "@/store/BackendStore";
import { eventNameKey } from "@/shared/I18nKeys";

/** Renders the task status component. */
export const TaskStatus: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const runningTask = useBackendStore((e) => e.statusStore[profileId]?.current_task);
  const taskQueue = useBackendStore((e) => e.statusStore[profileId]?.waiting_tasks);

  return (
    <div className="grid shrink-0 grid-cols-1 gap-1 lg:grid-cols-2">
      <div
        className="flex h-11 min-h-11 items-center overflow-hidden rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-800/50"
      >
        <Hourglass className="w-5 h-5 mr-2 text-primary-500" />
        <div className="grow">{t("task.running")}:</div>
        <div className="flex h-6 min-w-0 max-w-[65%] items-center justify-end overflow-hidden">
          {runningTask ? (
            <span className="truncate font-semibold text-primary-600 dark:text-primary-400">
              {t(eventNameKey(runningTask))}
            </span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">{t("task.noneRunning")}</span>
          )}
        </div>
      </div>

      <div className="flex h-11 min-h-11 items-center overflow-hidden rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-800/50">
        <Hourglass className="w-5 h-5 mr-2 text-primary-500" />
        <div className="flex-grow">{t("task.next")}:</div>

        <div className="mr-2 flex h-6 min-w-0 max-w-[55%] items-center justify-end overflow-hidden">
          {taskQueue && taskQueue.length > 0 ? (
            <span className="truncate font-semibold text-primary-600 dark:text-primary-400">
              {t(eventNameKey(taskQueue[0]))}
            </span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">{t("task.noneQueued")}</span>
          )}
        </div>

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg outline-none"
              onClick={() => setOpen(!open)}
            >
              <List className="w-5 h-5 text-slate-600 dark:text-slate-300" />
            </button>
          </PopoverTrigger>

          <PopoverContent
            className="w-56 p-2 mr-6 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 max-h-100 overflow-y-auto"
            onFocusOutside={() => setOpen(false)}
          >
            {taskQueue && taskQueue.length > 0 ? (
              <ul className="space-y-1">
                {taskQueue.map((task: string, idx: number) => (
                  <li
                    key={idx}
                    className="text-lg px-3 py-2 bg-slate-100 dark:bg-slate-800 rounded-md"
                  >
                    {t(eventNameKey(task))}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-slate-500 dark:text-slate-400">
                {t("task.noneQueued")}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
};
