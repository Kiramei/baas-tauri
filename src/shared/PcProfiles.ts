import type { WebSocketState } from "@/types/app";

export const PC_DEFAULT_METHODS = {
  screenshot_method: "mss",
  control_method: "pyautogui",
} as const;

export function pcMethodOptions(
  selected: string,
  kind: "screenshot" | "control",
  available: boolean
) {
  const valid = kind === "screenshot" ? ["mss", "pyautogui"] : ["pyautogui"];
  return [...new Set([...valid, ...(selected ? [selected] : [])])].map((value) => ({
    value,
    disabled: !available || !valid.includes(value),
  }));
}

export const validPcMethods = (screenshot: string, control: string): boolean =>
  ["mss", "pyautogui"].includes(screenshot) && control === "pyautogui";

type PcProfileStore = Pick<
  WebSocketState,
  "_auth_phase" | "_session" | "connections" | "configStore" | "modify" | "send"
>;

/** Creation has no initial-config payload: confirm the second write from the backend. */
export function configureNewPcProfile(
  getState: () => PcProfileStore,
  serial: string,
  {
    signal,
    timeoutMs = 10_000,
    intervalMs = 50,
  }: {
    signal?: AbortSignal;
    timeoutMs?: number;
    intervalMs?: number;
  } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error("PC profile setup was cancelled"));
    if (signal?.aborted) return onAbort();
    const initial = getState();
    const connection = initial.connections.sync;
    if (initial._auth_phase !== "authenticated" || connection?.readyState !== 1) {
      finish(new Error("Authenticated configuration channel is unavailable"));
      return;
    }
    const session = initial._session;
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (settled) return;
      const current = getState();
      if (
        current._auth_phase !== "authenticated" ||
        current._session !== session ||
        current.connections.sync !== connection ||
        connection.readyState !== 1
      ) {
        finish(new Error("Authentication session changed while saving PC profile settings"));
        return;
      }
      const profile = current.configStore[serial];
      if (
        profile &&
        Object.entries(PC_DEFAULT_METHODS).every(([key, value]) => profile[key] === value)
      ) {
        finish();
      } else if (Date.now() >= deadline) {
        finish(
          new Error("The PC profile was created, but its capture settings were not confirmed")
        );
      } else timer = setTimeout(check, intervalMs);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      initial.modify(`${serial}::config`, PC_DEFAULT_METHODS);
      // Sync requests are processed in order; this pull reads the persisted patch.
      initial.send("sync", { type: "pull", resource: "config", resource_id: serial });
      check();
    } catch {
      finish(new Error("The PC profile was created, but its capture settings could not be saved"));
    }
  });
}
