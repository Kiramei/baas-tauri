import {Hourglass, List} from "lucide-react";
import React, {useState} from "react";
import {useTranslation} from "react-i18next";
import {Popover, PopoverContent, PopoverTrigger} from "@/components/ui/popover";
import {useWebSocketStore} from "@/store/websocketStore.ts";

export const TaskStatus: React.FC<{ profileId: string }> = ({profileId}) => {
  const {t} = useTranslation();
  const [open, setOpen] = useState(false);
  const runningTask = useWebSocketStore((e) => e.statusStore[profileId]?.current_task);
  const taskQueue = useWebSocketStore((e) => e.statusStore[profileId]?.waiting_tasks);

  return (
    <div className={'grid grid-cols-1 lg:grid-cols-2 gap-1'}>

      <div
        className={'bg-white dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center'}>
        <Hourglass className="w-5 h-5 mr-2 text-primary-500"/>
        <div className={'flex-grow'}>
          {t('runningTask')}:
        </div>
        <div className={'flex flex-col items-center justify-center float-end'}>
          {runningTask ? (
            <span className="text-lg font-semibold text-primary-600 dark:text-primary-400">
                {t(runningTask)}
              </span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">{t('noTaskRunning')}</span>
          )}
        </div>
      </div>

      <div
        className="bg-white dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center">
        <Hourglass className="w-5 h-5 mr-2 text-primary-500"/>
        <div className="flex-grow">{t("nextTask")}:</div>

        <div className="flex flex-col items-center justify-center float-end mr-2">
          {taskQueue && taskQueue.length > 0 ? (
            <span className="text-lg font-semibold text-primary-600 dark:text-primary-400">
            {taskQueue[0]}
          </span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">
            {t("noTasksQueued")}
          </span>
          )}
        </div>

        {/* 队列图标 + 浮动菜单 */}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg outline-none"
              onClick={() => setOpen(!open)}
            >
              <List className="w-5 h-5 text-slate-600 dark:text-slate-300"/>
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
                    {task}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-slate-500 dark:text-slate-400">
                {t("noTasksQueued")}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
};
