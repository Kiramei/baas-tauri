import { useMemo } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import type { LogItem } from "@/types/app";

type NoticeKind = "success" | "info" | "warning" | "error";
type NoticeOptions = { description?: string };
const EMPTY_NOTICES: LogItem[] = [];
const scope = (profileId?: string) => (profileId ? `config:${profileId}` : "global");

// Keep local notices separate so a backend history snapshot cannot erase them.
export const useProfileNoticeStore = create<{ logs: Record<string, LogItem[]> }>(() => ({
  logs: {},
}));

export const profileNotices = (logs: Record<string, LogItem[]>, profileId?: string): LogItem[] =>
  logs[scope(profileId)] ?? EMPTY_NOTICES;

/** Interleave local notices with the server log without changing either buffer. */
export function mergeProfileLogs(server: LogItem[], local: LogItem[]): LogItem[] {
  if (local.length === 0) return server;
  if (server.length === 0) return local;
  const result: LogItem[] = [];
  let index = 0;
  for (const entry of server) {
    while (index < local.length && Date.parse(local[index].time) < Date.parse(entry.time)) {
      result.push(local[index++]);
    }
    result.push(entry);
  }
  return result.concat(local.slice(index));
}

export function createProfileNotice(android: boolean, profileId?: string) {
  const notify = (kind: NoticeKind, message: string, options?: NoticeOptions) => {
    if (!android) {
      toast[kind](message, options);
      return;
    }
    const entry: LogItem = {
      time: new Date().toISOString(),
      level: kind === "error" ? "ERROR" : kind === "warning" ? "WARNING" : "INFO",
      message: options?.description ? `${message}\n${options.description}` : message,
    };
    useProfileNoticeStore.setState(({ logs }) => ({
      logs: {
        ...logs,
        [scope(profileId)]: [...profileNotices(logs, profileId), entry].slice(-200),
      },
    }));
  };
  return {
    success: (message: string, options?: NoticeOptions) => notify("success", message, options),
    info: (message: string, options?: NoticeOptions) => notify("info", message, options),
    warning: (message: string, options?: NoticeOptions) => notify("warning", message, options),
    error: (message: string, options?: NoticeOptions) => notify("error", message, options),
  };
}

export function useProfileNotice(profileId?: string) {
  return useMemo(() => createProfileNotice(__WITH_ANDROID__, profileId), [profileId]);
}
