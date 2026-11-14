export type AndroidWorkflowFinished = { sessionId: string; success: boolean };
type NativeRequest = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type AndroidBackendUpdateDependencies = {
  invoke: NativeRequest;
  listen: (event: string, handler: (event: { payload: any }) => void) => Promise<() => void>;
  beforeRestart: () => void;
  timeoutMs?: number;
  onLog?: (message: string, error: boolean) => void;
};

/** Only this workflow's completion can authorize a fresh Python process. */
export async function runAndroidBackendUpdate(deps: AndroidBackendUpdateDependencies) {
  let sessionId: string | null = null;
  const early = new Map<string, boolean>();
  let finish!: (success: boolean) => void;
  const finished = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const unlisten = await deps.listen("term:session-finished", ({ payload }) => {
    if (typeof payload?.sessionId !== "string" || typeof payload.success !== "boolean") return;
    if (sessionId === null) {
      if (early.size < 32) early.set(payload.sessionId, payload.success);
    } else if (payload.sessionId === sessionId) finish(payload.success);
  });
  const unlisteners = [unlisten];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let logBytes = 0;
  const pendingLogs: { sessionId: string; text: string; error: boolean }[] = [];
  const log = (item: { sessionId: string; text: string; error: boolean }) => {
    if (logBytes > 64_000 || item.sessionId !== sessionId) return;
    const text = item.text.slice(0, Math.min(8_000, 64_000 - logBytes));
    if (!text) return;
    logBytes += text.length;
    try {
      deps.onLog?.(text, item.error);
    } catch {
      /* Diagnostics cannot own the update lifecycle. */
    }
  };
  const acceptLog = (item: { sessionId: string; text: string; error: boolean }) => {
    if (sessionId) log(item);
    else if (pendingLogs.length < 64) pendingLogs.push(item);
  };
  try {
    if (deps.onLog) {
      unlisteners.push(
        await deps.listen("term:task-started", ({ payload }) => {
          acceptLog({
            sessionId: payload.sessionId,
            text: String(payload.name ?? payload.taskId ?? ""),
            error: false,
          });
        })
      );
      unlisteners.push(
        await deps.listen("term:region-stable", ({ payload }) => {
          acceptLog({
            sessionId: payload.sessionId,
            text: [payload.title, ...(payload.lines ?? [])].filter(Boolean).join("\n"),
            error: false,
          });
        })
      );
      unlisteners.push(
        await deps.listen("term:task-status", ({ payload }) => {
          if (payload.error)
            acceptLog({ sessionId: payload.sessionId, text: String(payload.error), error: true });
        })
      );
    }
    timer = setTimeout(() => finish(false), deps.timeoutMs ?? 30 * 60_000);
    const session = await deps.invoke<{ sessionId?: string }>("updater_start_workflow", {
      request: { launch: false },
    });
    if (!session?.sessionId) throw new Error("Android updater did not return a workflow session");
    sessionId = session.sessionId;
    pendingLogs.forEach(log);
    if (early.has(sessionId)) finish(early.get(sessionId)!);
    if (!(await finished)) {
      await deps.invoke("updater_abort_workflow", {
        request: { cleanup: false, emitEvents: false },
      });
      throw new Error("Android backend update failed or timed out");
    }
    deps.beforeRestart();
    const restart = await deps.invoke<{ restartScheduled?: boolean }>("updater_restart_backend");
    if (restart?.restartScheduled !== true)
      throw new Error("Android backend restart was not scheduled");
  } finally {
    clearTimeout(timer);
    for (const release of unlisteners) {
      try {
        release();
      } catch {
        /* A closed WebView must not hide the workflow result. */
      }
    }
  }
}

export async function updateAndroidBackend(beforeRestart: () => void) {
  const [{ listen }, { invoke }, { useGlobalLogStore }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@/shared/TauriInvoke"),
    import("@/store/GlobalLogStore"),
  ]);
  await runAndroidBackendUpdate({
    invoke,
    listen,
    beforeRestart,
    onLog: (message, error) => {
      useGlobalLogStore
        .getState()
        .appendGlobalLog({
          time: new Date().toISOString(),
          level: error ? "ERROR" : "INFO",
          message,
        });
    },
  });
}
