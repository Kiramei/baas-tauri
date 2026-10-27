import type { WebSocketState } from "@/types/app";

export interface CommitHistoryEntry {
  hash: string;
  author: string;
  message: string;
}

export interface CommitHistoryReport {
  entries: CommitHistoryEntry[];
  repository: string;
  reference: string;
  current: string | null;
  source: "github" | "local" | "bundle" | "cache";
  stale: boolean;
  partial: boolean;
  hasMore: boolean;
  issue: "offline" | "rate_limited" | "unavailable" | null;
}

export interface CommitHistoryRequest {
  channel: "stable" | "dev";
  limit: number;
  refresh: boolean;
}

/** Discard unexpected fields; commit metadata is always rendered as plain text. */
export function parseCommitHistory(value: unknown): CommitHistoryReport {
  if (!value || typeof value !== "object") throw new Error("Invalid commit history");
  const report = value as CommitHistoryReport;
  if (
    !Array.isArray(report.entries) ||
    report.entries.length > 500 ||
    !["pur1fying/blue_archive_auto_script", "Kiramei/baas-dev"].includes(report.repository) ||
    report.reference !== "master" ||
    !["github", "local", "bundle", "cache"].includes(report.source) ||
    typeof report.stale !== "boolean" ||
    typeof report.partial !== "boolean" ||
    typeof report.hasMore !== "boolean" ||
    ![null, "offline", "rate_limited", "unavailable"].includes(report.issue) ||
    (report.current !== null && !/^[a-f0-9]{40}$/i.test(report.current))
  )
    throw new Error("Invalid commit history");
  const seen = new Set<string>();
  const entries = report.entries.map((entry) => {
    if (
      !entry ||
      typeof entry.hash !== "string" ||
      !/^[a-f0-9]{40}$/i.test(entry.hash) ||
      typeof entry.author !== "string" ||
      !entry.author.trim() ||
      entry.author.length > 256 ||
      typeof entry.message !== "string" ||
      entry.message.length > 4096 ||
      /[\r\n]/.test(entry.author + entry.message) ||
      seen.has(entry.hash.toLowerCase())
    )
      throw new Error("Invalid commit history entry");
    seen.add(entry.hash.toLowerCase());
    return { hash: entry.hash.toLowerCase(), author: entry.author, message: entry.message };
  });
  return {
    entries,
    repository: report.repository,
    reference: report.reference,
    current: report.current?.toLowerCase() ?? null,
    source: report.source,
    stale: report.stale,
    partial: report.partial,
    hasMore: report.hasMore,
    issue: report.issue,
  };
}

type HistoryStore = Pick<
  WebSocketState,
  "trigger" | "connections" | "pendingCallbacks" | "_auth_phase" | "_session"
>;

/** WebUI uses its authenticated command channel; never puts a Key into an HTTP URL. */
export async function requestWebCommitHistory(
  getState: () => HistoryStore,
  request: CommitHistoryRequest,
  timeoutMs = 60_000
): Promise<CommitHistoryReport> {
  const state = getState();
  const sessionId = state._session?.sessionId;
  if (
    state._auth_phase !== "authenticated" ||
    !sessionId ||
    state.connections.trigger?.readyState !== 1
  )
    throw new Error("Commit history requires an authenticated connection");

  return new Promise((resolve, reject) => {
    let timestamp: number | undefined;
    let registered: HistoryStore["pendingCallbacks"][number] | undefined;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (
        timestamp !== undefined &&
        registered &&
        getState().pendingCallbacks[timestamp] === registered
      )
        delete getState().pendingCallbacks[timestamp];
    };
    const callback = (response: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (
          getState()._auth_phase !== "authenticated" ||
          getState()._session?.sessionId !== sessionId ||
          response?.status !== "ok"
        )
          throw new Error("Commit history is unavailable");
        resolve(parseCommitHistory(response.data));
      } catch {
        reject(new Error("Commit history is unavailable"));
      }
    };
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new Error("Commit history timed out"));
    }, timeoutMs);
    try {
      timestamp = state.trigger(
        { timestamp: Date.now(), command: "get_commit_history", payload: request },
        callback
      );
      registered = getState().pendingCallbacks[timestamp];
      if (settled) cleanup();
    } catch {
      settled = true;
      cleanup();
      reject(new Error("Commit history is unavailable"));
    }
  });
}
