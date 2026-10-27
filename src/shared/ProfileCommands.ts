import type { WebSocketState } from "@/types/app";

type ProfileCommandStore = Pick<
  WebSocketState,
  | "connections"
  | "trigger"
  | "triggerBinary"
  | "pendingCallbacks"
  | "pendingBinaryCallbacks"
  | "send"
  | "configStore"
>;

/** Wait for a profile command without leaving the editor permanently busy. */
export const runProfileCommand = (
  getState: () => ProfileCommandStore,
  command: string,
  payload: Record<string, unknown>,
  binary?: ArrayBuffer | Uint8Array,
  timeoutMs = 30_000
): Promise<any> =>
  new Promise((resolve, reject) => {
    const state = getState();
    const connection = state.connections.trigger;
    if (!connection || connection.readyState !== 1) {
      reject(new Error("Backend command channel is unavailable"));
      return;
    }
    let timestamp: number | undefined;
    const timer = setTimeout(() => {
      if (timestamp !== undefined) {
        const current = getState();
        delete current.pendingCallbacks[timestamp];
        // A binary header may already have arrived. Consume its eventual bytes
        // instead of removing its queue slot and routing them to another export.
        if (current.pendingBinaryCallbacks[timestamp])
          current.pendingBinaryCallbacks[timestamp] = () => {};
      }
      reject(new Error(`Backend command timed out: ${command}`));
    }, timeoutMs);
    const callback = (event: any) => {
      clearTimeout(timer);
      if (event?.status === "error") reject(new Error(event.error || `${command} failed`));
      else resolve(event?.binary ? event : event?.data);
    };
    try {
      const request = { timestamp: Date.now(), command, payload };
      timestamp =
        binary === undefined
          ? state.trigger(request, callback)
          : state.triggerBinary(request, binary, callback);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });

/** Refresh explicitly: an import ACK must not depend on a separate patch arriving. */
export const waitForProfileConfig = async (
  getState: () => ProfileCommandStore,
  serial: string,
  timeoutMs = 10_000,
  intervalMs = 50
): Promise<any> => {
  if (typeof serial !== "string" || !serial)
    throw new Error("Missing profile ID in command response");
  const state = getState();
  state.send("sync", { type: "list" });
  for (const resource of ["config", "event"]) {
    state.send("sync", { type: "pull", resource, resource_id: serial });
  }
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const profile = getState().configStore[serial];
      if (profile?.name && profile?.ap && profile?._pass) resolve(profile);
      else if (Date.now() >= deadline) {
        reject(new Error("Profile was saved, but refreshing its configuration timed out"));
      } else setTimeout(check, intervalMs);
    };
    check();
  });
};
