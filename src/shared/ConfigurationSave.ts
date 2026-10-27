import type { WebSocketState } from "@/types/app";

type SaveStore = Pick<WebSocketState, "_auth_phase" | "_session" | "connections" | "modify">;

/** Wait for this write's ACK before sending an action on the separate trigger channel. */
export function saveConfigurationPatch(
  getState: () => SaveStore,
  profileId: string,
  patch: Record<string, unknown>,
  { signal, timeoutMs = 10_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const initial = getState();
    const sync = initial.connections.sync;
    const trigger = initial.connections.trigger;
    const session = initial._session;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelWrite: void | (() => void);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      cancelWrite?.();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error("Configuration save was cancelled"));
    const validSession = () => {
      const current = getState();
      return (
        current._auth_phase === "authenticated" &&
        current._session === session &&
        current.connections.sync === sync &&
        sync?.readyState === 1 &&
        current.connections.trigger === trigger &&
        trigger?.readyState === 1
      );
    };
    if (signal?.aborted) return onAbort();
    if (!profileId || !Object.keys(patch).length || !validSession()) {
      finish(new Error("Authenticated configuration and command channels are required"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (settled) return;
      if (!validSession())
        finish(new Error("Authentication session changed while saving configuration"));
      else if (Date.now() >= deadline) finish(new Error("Configuration save was not acknowledged"));
      else timer = setTimeout(check, Math.min(50, Math.max(1, deadline - Date.now())));
    };
    try {
      cancelWrite = initial.modify(`${profileId}::config`, patch, false, () => {
        if (!validSession())
          finish(new Error("Authentication session changed while saving configuration"));
        else finish();
      });
      // Some test/native transports acknowledge synchronously.
      if (settled) cancelWrite?.();
      else check();
    } catch {
      finish(new Error("Configuration could not be saved"));
    }
  });
}
