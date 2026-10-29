import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { HitBox, Marquee } from "./terminal-components";
import { translate } from "./i18n";
import { terminalText } from "./ui";
import type { InstallationProgress, InstallationTask } from "./installation";

const TEAL = "#70d7e5",
  MUTED = "#89969f",
  GREEN = "#98cf9e",
  AMBER = "#e9bd78",
  RED = "#f38b91";
export function installationStage(id: string): string {
  const labels: Record<string, string> = {
    "updater-config": "准备安装配置",
    "main-repository": "同步后端",
    "cpp-repository": "下载 OCR 组件",
    "git-record-sha": "记录组件版本",
    "uv-install": "安装环境工具",
    "cpython-source-ranking": "选择 Python 下载源",
    "uv-python-install": "准备 Python 环境",
    "uv-venv": "创建虚拟环境",
    "uv-requirements": "解析依赖清单",
    "uv-compile": "生成依赖锁定",
    "pypi-source-ranking": "选择依赖下载源",
    "uv-sync": "安装依赖",
    "uv-cache-clean": "清理缓存",
    "launch-backend": "启动本地后端",
    "backend": "启动本地后端",
    "prepare": "检查环境",
    "complete": "安装完成",
    "ready": "启动本地后端",
    "launch": "启动本地后端",
    "update-backend": "检查后端更新",
    "update-ocr": "检查 OCR 更新",
    "verify": "校验安装",
    "error": "失败",
    "cancelled": "操作已取消",
  };
  return labels[id] || (id.includes("update") ? "检查更新" : id);
}
const size = (n: number) =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MiB`
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${n} B`;
const elapsed = (task: InstallationTask, now: number) =>
  task.startedAt === undefined
    ? ""
    : `${(Math.max(0, (task.finishedAt ?? now) - task.startedAt) / 1000).toFixed(1)}s`;
type Row = {
  task: InstallationTask;
  index: number;
  kind: "header" | "progress" | "log";
  text?: string;
  color: string;
  expanded: boolean;
};

/** BuildKit-style task groups: each command owns its changing progress and log tail. */
export function InstallationPanel({
  progress,
  language,
  title,
  columns,
  height,
  tick,
  failed = false,
}: {
  progress: InstallationProgress;
  language: string;
  title?: string;
  columns: number;
  height: number;
  tick: number;
  failed?: boolean;
}) {
  const t = (value: string) => translate(value, language);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [scroll, setScroll] = useState<number>();
  const tasks = progress.tasks;
  const [now, setNow] = useState(Date.now);
  const running = tasks.some((task) => task.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  const finished = tasks.filter(
    (task) => task.status === "complete" || task.status === "skipped"
  ).length;
  const end =
    tasks.length && tasks.every((task) => ["complete", "failed", "skipped"].includes(task.status))
      ? Math.max(...tasks.map((task) => task.finishedAt || now))
      : now;
  const duration =
    progress.startedAt === undefined
      ? ""
      : `${(Math.max(0, end - progress.startedAt) / 1000).toFixed(1)}s`;
  const rows: Row[] = [];
  for (const [index, task] of tasks.entries()) {
    const expanded = open[task.id] ?? (task.status === "running" || task.status === "failed");
    const color =
      task.status === "failed"
        ? RED
        : task.status === "complete"
          ? GREEN
          : task.status === "running"
            ? AMBER
            : MUTED;
    rows.push({ task, index, kind: "header", color, expanded });
    if (!expanded) continue;
    const percent =
      task.percent ??
      (task.total && task.current !== undefined ? (task.current / task.total) * 100 : undefined);
    if (percent !== undefined && task.status !== "complete") {
      const width = Math.max(4, Math.min(30, columns - 33));
      const fill = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
      const transfer =
        task.downloadedBytes !== undefined
          ? `${size(task.downloadedBytes)}${task.totalBytes ? " / " + size(task.totalBytes) : ""}`
          : task.current !== undefined
            ? `${task.current}${task.total ? " / " + task.total : ""}`
            : "";
      rows.push({
        task,
        index,
        kind: "progress",
        text: `${"━".repeat(fill)}${"─".repeat(width - fill)} ${Math.round(percent)}% ${transfer}`,
        color: TEAL,
        expanded,
      });
    }
    const tail = [...(task.lines || [])];
    const current = task.currentLine || task.message;
    if (current && tail.at(-1) !== current) tail.push(current);
    for (const text of (tail.length ? tail : [t("暂无日志")]).slice(
      task.status === "failed" ? -6 : -3
    ))
      rows.push({
        task,
        index,
        kind: "log",
        text: terminalText(text).replace(/\n/g, " "),
        color: task.status === "failed" ? RED : MUTED,
        expanded,
      });
  }
  const available = Math.max(1, height - 2);
  const lastActive = rows.reduce(
    (last, row, index) =>
      row.task.status === "running" || row.task.status === "failed" ? index : last,
    -1
  );
  const automatic = Math.max(
    0,
    Math.min(Math.max(0, rows.length - available), lastActive - available + 3)
  );
  const offset = Math.max(0, Math.min(scroll ?? automatic, Math.max(0, rows.length - available)));
  const move = (delta: number) =>
    setScroll(Math.max(0, Math.min(Math.max(0, rows.length - available), offset + delta)));
  useInput((_text, key) => {
    if (key.pageUp) move(-available);
    if (key.pageDown) move(available);
  });
  return (
    <Box flexDirection="column" width={columns} height={height} paddingX={1}>
      <Marquee
        value={`[${failed ? "!" : "+"}] ${t(title || "安装进度")} ${duration} (${finished}/${tasks.length})`}
        width={columns - 2}
        color={failed ? RED : TEAL}
        bold
      />
      <HitBox
        flexDirection="column"
        height={available}
        flexShrink={0}
        overflow="hidden"
        onWheel={move}
      >
        {!rows.length && <Text color={AMBER}> =&gt; {t(progress.message)}</Text>}
        {rows.slice(offset, offset + available).map((row, index) =>
          row.kind === "header" ? (
            <HitBox
              key={`${row.task.id}-header`}
              height={1}
              flexShrink={0}
              onPress={() => setOpen((old) => ({ ...old, [row.task.id]: !row.expanded }))}
            >
              <Text color={row.color}>
                {row.task.status === "running" ? ` ${["=>", "⇒ ", "=>", "→ "][tick % 4]} ` : " => "}
              </Text>
              <Marquee
                value={`[${row.index + 1}/${tasks.length}] ${t(installationStage(row.task.id))}`}
                width={Math.max(1, columns - 28)}
                color={row.color}
              />
              <Box flexGrow={1} />
              <Text color={row.color}>
                {t(
                  row.task.status === "complete"
                    ? "已完成"
                    : row.task.status === "failed"
                      ? "失败"
                      : row.task.status === "skipped"
                        ? "已跳过"
                        : row.task.status === "pending"
                          ? "等待中"
                          : "进行中"
                )}
              </Text>
              <Box width={8} justifyContent="flex-end">
                <Text color={MUTED}>{elapsed(row.task, now)}</Text>
              </Box>
            </HitBox>
          ) : (
            <Box key={`${row.task.id}-${row.kind}-${index}`} height={1} flexShrink={0}>
              <Text color={MUTED}> =&gt; =&gt; </Text>
              <Marquee
                value={t(row.text || "")}
                width={Math.max(1, columns - 9)}
                color={row.color}
              />
            </Box>
          )
        )}
      </HitBox>
      <Marquee
        value={t("滚轮查看步骤 · 点击展开日志 · Esc 取消")}
        width={columns - 2}
        color={MUTED}
      />
    </Box>
  );
}
