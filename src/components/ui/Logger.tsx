"use client";

import React, { useLayoutEffect, useRef } from "react";
import type { LogItem } from "@/types/app";
import { formatIsoToReadableTime } from "@/shared/GlobalUtilities.ts";
import { List } from "react-window";
import {
  type ListImperativeAPI,
  type RowComponentProps,
  useDynamicRowHeight,
} from "react-window";

interface LoggerProps {
  logs: LogItem[];
  scrollToEnd: boolean; // Controls whether the logger scrolls to the bottom.
}

const LOG_ROW_LINE_HEIGHT = 20;

const getLevelColor = (level: string) => {
  switch (level) {
    case "INFO":
      return "text-blue-400";
    case "WARNING":
      return "text-yellow-400";
    case "ERROR":
      return "text-red-400";
    case "CRITICAL":
      return "text-purple-400";
    default:
      return "text-slate-400";
  }
};

const getMessageStyle = (level: string) => {
  switch (level) {
    case "INFO":
      return "text-inherit font-normal border-l-[3px] border-gray-400";
    case "WARNING":
      return "text-yellow-500 font-bold border-l-[5px] border-yellow-500";
    case "ERROR":
      return "text-red-500 font-bold border-l-[5px] border-red-500";
    case "CRITICAL":
      return "text-purple-500 font-bold border-l-[5px] border-purple-500";
    default:
      return "text-inherit font-normal border-l-[3px] border-gray-400";
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
    <div style={style} className="flex items-start cursor-text px-2">
      {/* Time */}
      <span className="text-gray-500 whitespace-nowrap min-w-25 hidden sm:block">
        {formatIsoToReadableTime(log.time)}
      </span>

      {/* Level */}
      <span className={`sm:min-w-11 ${getLevelColor(log.level)} font-bold flex justify-end mr-2`}>
        {/* Show only the first letter on small screens and the full label on larger screens. */}
        <span className="block sm:hidden">{getLogLevelDisplay(log.level).trim().charAt(0)}</span>
        <span className="hidden sm:block">{getLogLevelDisplay(log.level)}</span>
      </span>

      {/* Message */}
      <div
        className={`flex-1 pl-2 sm:pl-2 whitespace-pre-wrap wrap-break-word ${getMessageStyle(log.level)}`}
      >
        {log.message}
      </div>
    </div>
  );
};

/** Renders the logger component. */
const Logger: React.FC<LoggerProps> = ({ logs = [], scrollToEnd = false }) => {
  const listRef = useRef<ListImperativeAPI | null>(null);
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: LOG_ROW_LINE_HEIGHT });

  useLayoutEffect(() => {
    if (!scrollToEnd || logs.length === 0) return;

    listRef.current?.scrollToRow({ index: logs.length - 1, align: "end" });
  }, [scrollToEnd, logs.length, rowHeight]);

  return (
    <div className="w-full h-full bg-slate-900/80 dark:bg-slate/50 rounded-lg font-mono text-sm text-white py-1 pl-1 sm:py-4 sm:pl-4 overflow-x-auto allow-select-text">
      {logs.length > 0 ? (
        <List
          listRef={listRef}
          rowComponent={Row}
          rowCount={logs.length}
          rowHeight={rowHeight}
          rowProps={{ logs }}
        />
      ) : (
        <div className="text-slate-400 px-2 py-2 select-none">No logs yet.</div>
      )}
    </div>
  );
};

export default Logger;
