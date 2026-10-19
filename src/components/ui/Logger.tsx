"use client";

import React, { useLayoutEffect, useMemo, useRef } from "react";
import type { LogItem } from "@/types/app";
import { formatIsoToReadableTime } from "@/shared/GlobalUtilities.ts";
import { List } from "react-window";
import { type ListImperativeAPI, type RowComponentProps, useDynamicRowHeight } from "react-window";
import { Logs } from "lucide-react";
import { getLogLevelColor } from "@/shared/LogPresentation";
import { useTranslation } from "react-i18next";
import { IconTooltip } from "@/components/ui/Tooltip";
import { tokenizeScriptLog } from "@/shared/ScriptLogHighlight";
import "./script-log-highlight.css";

interface LoggerProps {
  logs: LogItem[];
  scrollToEnd: boolean; // Controls whether the logger scrolls to the bottom.
}

const LOG_ROW_LINE_HEIGHT = 20;

/** Renders the row component. */
const Row = ({ index, logs, style }: RowComponentProps<{ logs: LogItem[] }>) => {
  const log: LogItem = logs[index];
  const tokens = useMemo(() => tokenizeScriptLog(log.message), [log.message]);
  return (
    <div
      style={{ ...style, width: "max-content", minWidth: "100%" }}
      className="flex cursor-text items-start gap-2 pr-2 font-mono text-[12px] leading-5 hover:bg-foreground/[0.035]"
    >
      <IconTooltip content={log.level} side="right">
        <span
          role="img"
          aria-label={log.level}
          data-log-level={log.level}
          className="w-[3px] shrink-0 self-stretch"
          style={{ backgroundColor: getLogLevelColor(log.level) }}
        />
      </IconTooltip>
      {/* Time */}
      <span className="hidden min-w-[88px] shrink-0 whitespace-nowrap tabular-nums text-muted-foreground sm:block">
        {formatIsoToReadableTime(log.time)}
      </span>

      {/* Message */}
      <div className="script-log-message shrink-0 whitespace-pre font-normal text-foreground">
        {tokens.map((token, tokenIndex) =>
          token.kind === "plain" ? (
            token.text
          ) : (
            <span key={tokenIndex} className={`script-log-token-${token.kind}`}>
              {token.text}
            </span>
          )
        )}
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
          style={{ overflowX: "auto" }}
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
