import { getTimestampMs } from "@/shared/GlobalUtilities";
import { resolveHttpBase, useWebSocketStore } from "@/store/WebsocketStore";

/** A new service process may close the trigger stream before its final frame arrives. */
export async function updateDockerBackend(append: (line: string) => void) {
  const store = useWebSocketStore.getState();
  if (!store.connections.trigger) throw new Error("Backend command channel is unavailable");
  const base = resolveHttpBase();
  let expected = store.versionStore.remote;
  let error: string | undefined;
  let skipped = false;
  const timestamp = store.triggerStream(
    { timestamp: getTimestampMs(), command: "update_to_latest_stream", payload: {} },
    (event) => {
      const data = event.data ?? {};
      if (event.status === "error" || data.type === "error") {
        error = String(event.error ?? data.error ?? "Backend update failed");
      } else if (data.type === "progress") {
        append(String(data.stage));
      } else if (data.type === "result") {
        const result = data.result;
        if (result.status === "skipped" || result.status === "unchanged") {
          skipped = true;
          append(result.reason ?? result.status);
        } else if (result.status === "updated") {
          expected = result.current;
          append(`Restarting backend at ${expected}`);
        }
      }
    }
  );
  try {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      if (error) throw new Error(error);
      if (skipped) return false;
      // This header identifies the code loaded at startup, including after reauthentication.
      try {
        const health = await fetch(`${base}/health`, {
          cache: "no-store",
          signal: AbortSignal.timeout(3000),
        });
        if (health.ok && expected && health.headers.get("X-BAAS-Revision") === expected)
          return true;
      } catch {
        // nginx remains available while the service worker is replaced.
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Timed out waiting for the updated backend to become healthy");
  } finally {
    delete useWebSocketStore.getState().pendingStreamCallbacks[timestamp];
  }
}
