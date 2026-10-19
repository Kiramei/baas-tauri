import { Circle, List, LoaderCircle } from "lucide-react";
import React, { useState } from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { eventNameKey } from "@/shared/I18nKeys";
import { IconTooltip } from "@/components/ui/Tooltip";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import "./HomeTaskStatus.css";

/** Task context stays on a single quiet line when the window has room. */
export const TaskStatus: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const runningTask = useWebSocketStore((state) => state.statusStore[profileId]?.current_task);
  const runningTaskName = runningTask ? t(eventNameKey(runningTask)) : t("task.noneRunning");
  const taskQueue = useWebSocketStore((state) => state.statusStore[profileId]?.waiting_tasks);
  const taskNames = taskQueue?.map((task: string) => t(eventNameKey(task)));

  return (
    <div className="task-status-row flex min-w-0 shrink-0 items-start gap-3 text-[13px] leading-5">
      <div className="flex min-w-0 flex-1 items-center gap-x-6 pt-0.5">
        <div className="flex min-w-0 max-w-full shrink-0 items-center gap-2">
          {runningTask ? (
            <LoaderCircle
              className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
              strokeWidth={1.6}
            />
          ) : (
            <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" strokeWidth={1.6} />
          )}
          <span className="shrink-0 text-muted-foreground">{t("task.running")}</span>
          <IconTooltip content={runningTask ? runningTaskName : undefined}>
            <span
              data-running-task-name
              className={`block w-[144px] shrink-0 truncate text-center ${runningTask ? "font-medium text-foreground" : "text-muted-foreground/70"}`}
            >
              {runningTaskName}
            </span>
          </IconTooltip>
        </div>

        <div className="task-status-upcoming min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-muted-foreground">{t("task.next")}</span>
          <span
            data-task-chain
            className={`min-w-0 flex-1 truncate ${taskQueue?.length ? "font-medium text-foreground" : "text-muted-foreground/70"}`}
          >
            {taskNames?.length
              ? taskNames.map((name: string, index: number) => (
                  <React.Fragment key={`${name}-${index}`}>
                    {index > 0 && (
                      <CaretRightIcon
                        size={12}
                        weight="regular"
                        aria-hidden="true"
                        className="mx-1 inline-block align-[-1px] text-muted-foreground/60"
                      />
                    )}
                    {name}
                  </React.Fragment>
                ))
              : t("task.noneQueued")}
          </span>
        </div>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <IconTooltip content={t("task.overview")}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("task.overview")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <List className="h-3.5 w-3.5" strokeWidth={1.6} />
            </button>
          </PopoverTrigger>
        </IconTooltip>
        <PopoverContent
          align="end"
          className="max-h-80 w-64 overflow-y-auto rounded-lg bg-popover p-1.5 text-popover-foreground shadow-lg"
          onFocusOutside={() => setOpen(false)}
        >
          {taskQueue?.length ? (
            <ol className="space-y-0.5">
              {taskQueue.map((task: string, index: number) => (
                <li
                  key={`${task}-${index}`}
                  className="flex items-center gap-3 rounded-md px-2.5 py-1.5 text-xs"
                >
                  <span className="w-3 shrink-0 text-right tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 truncate">{t(eventNameKey(task))}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">{t("task.noneQueued")}</div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
};
