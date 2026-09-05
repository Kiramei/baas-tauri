import { Hourglass, List } from "lucide-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { eventNameKey } from "@/shared/I18nKeys";

/** Renders the task status component. */
export const TaskStatus: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const runningTask = useWebSocketStore((e) => e.statusStore[profileId]?.current_task);
  const taskQueue = useWebSocketStore((e) => e.statusStore[profileId]?.waiting_tasks);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-1 lg:grid-cols-2">
      <div
        className={
          "min-w-0 bg-white dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center"
        }
      >
        <Hourglass className="mr-2 h-[20px] w-[20px] shrink-0 text-primary-500" />
        <div className="shrink-0">{t("task.running")}:</div>
        <div className="ml-2 flex min-w-0 flex-1 flex-col items-end justify-center text-right">
          {runningTask ? (
            <span className="max-w-full truncate font-semibold text-primary-600 dark:text-primary-400 sm:text-lg">
              {t(eventNameKey(runningTask))}
            </span>
          ) : (
            <span className="max-w-full truncate text-slate-500 dark:text-slate-400">
              {t("task.noneRunning")}
            </span>
          )}
        </div>
      </div>

      <div className="flex min-w-0 items-center rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-800/50">
        <Hourglass className="mr-2 h-[20px] w-[20px] shrink-0 text-primary-500" />
        <div className="shrink-0">{t("task.next")}:</div>

        <div className="mx-2 flex min-w-0 flex-1 flex-col items-end justify-center text-right">
          {taskQueue && taskQueue.length > 0 ? (
            <span className="max-w-full truncate font-semibold text-primary-600 dark:text-primary-400 sm:text-lg">
              {t(eventNameKey(taskQueue[0]))}
            </span>
          ) : (
            <span className="max-w-full truncate text-slate-500 dark:text-slate-400">
              {t("task.noneQueued")}
            </span>
          )}
        </div>

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              className="shrink-0 p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg outline-none"
              onClick={() => setOpen(!open)}
            >
              <List className="h-[20px] w-[20px] text-slate-600 dark:text-slate-300" />
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
