"use client";

import React, { useLayoutEffect, useRef } from "react";
import type { LogItem } from "@/types/app";
import { formatIsoToReadableTime } from "@/shared/GlobalUtilities.ts";
import { List } from "react-window";
import { type ListImperativeAPI, type RowComponentProps, useDynamicRowHeight } from "react-window";
import { Logs } from "lucide-react";
import { useTranslation } from "react-i18next";

interface LoggerProps {
  logs: LogItem[];
  scrollToEnd: boolean; // Controls whether the logger scrolls to the bottom.
}

const LOG_ROW_LINE_HEIGHT = 20;

const getLevelColor = (level: string) => {
  switch (level) {
    case "INFO":
      return "text-muted-foreground";
    case "WARNING":
      return "text-amber-600 dark:text-amber-400";
    case "ERROR":
      return "text-red-600 dark:text-red-400";
    case "CRITICAL":
      return "text-violet-600 dark:text-violet-400";
    default:
      return "text-muted-foreground/60";
  }
};

const getMessageStyle = (level: string) => {
  switch (level) {
    case "INFO":
      return "text-foreground font-normal border-l-[3px] border-gray-400";
    case "WARNING":
      return "text-amber-700 dark:text-amber-300 font-bold border-l-[5px] border-amber-500";
    case "ERROR":
      return "text-red-600 dark:text-red-300 font-bold border-l-[5px] border-red-500";
    case "CRITICAL":
      return "text-violet-700 dark:text-violet-300 font-bold border-l-[5px] border-violet-500";
    default:
      return "text-foreground font-normal border-l-[3px] border-gray-400";
  }
};

const getLogLevelDisplay = (level: string) => {
  switch (level) {
    case "INFO":
      return "INFO";
    case "WARNING":
      return "WARN";
    case "ERROR":
      return "FAIL";
    case "CRITICAL":
      return "CRIT";
    default:
      return "DBUG";
  }
};

/** Renders the row component. */
const Row = ({ index, logs, style }: RowComponentProps<{ logs: LogItem[] }>) => {
  const log: LogItem = logs[index];
  return (
    <div
      style={style}
      className="flex cursor-text items-start px-2 font-mono text-[12px] leading-5"
    >
      {/* Time */}
      <span className="hidden min-w-[88px] shrink-0 whitespace-nowrap tabular-nums text-muted-foreground sm:block">
        {formatIsoToReadableTime(log.time)}
      </span>

      {/* Level */}
      <span
        className={`mr-2 flex w-3 shrink-0 justify-end font-bold sm:min-w-11 ${getLevelColor(log.level)}`}
      >
        {/* Show only the first letter on small screens and the full label on larger screens. */}
        <span className="block sm:hidden">{getLogLevelDisplay(log.level).trim().charAt(0)}</span>
        <span className="hidden sm:block">{getLogLevelDisplay(log.level)}</span>
      </span>

      {/* Message */}
      <div
        className={`min-w-0 flex-1 whitespace-pre-wrap wrap-break-word pl-2 ${getMessageStyle(log.level)}`}
      >
        {log.message}
      </div>
    </div>
  );
};

/** Renders the logger component. */
const Logger: React.FC<LoggerProps> = ({ logs = [], scrollToEnd = false }) => {
  const { t } = useTranslation();
  const listRef = useRef<ListImperativeAPI | null>(null);
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: LOG_ROW_LINE_HEIGHT });

  useLayoutEffect(() => {
    if (!scrollToEnd || logs.length === 0) return;

    listRef.current?.scrollToRow({ index: logs.length - 1, align: "end" });
  }, [scrollToEnd, logs.length, rowHeight]);

  return (
    <div className="allow-select-text relative h-full min-h-0 w-full overflow-hidden text-foreground">
      {logs.length > 0 ? (
        <List
          listRef={listRef}
          rowComponent={Row}
          rowCount={logs.length}
          rowHeight={rowHeight}
          rowProps={{ logs }}
        />
      ) : (
        <div className="flex h-full min-h-48 select-none flex-col items-center justify-center px-6 pb-10 text-center">
          <Logs className="mb-4 h-7 w-7 text-muted-foreground/50" strokeWidth={1.3} />
          <p className="text-sm font-medium text-foreground/85">{t("log.empty.title")}</p>
          <p className="mt-1.5 max-w-72 text-xs leading-5 text-muted-foreground">
            {t("log.empty.description")}
          </p>
        </div>
      )}
    </div>
  );
};

export default Logger;
