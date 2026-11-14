import { useWebSocketStore } from "@/store/WebsocketStore";
import { getTimestampMs } from "@/shared/GlobalUtilities";

let commandTimestamp = 0;

/** Keep a command and its callback bound to the original authenticated channel. */
export async function command(name: string, configId?: string): Promise<any> {
  const store = useWebSocketStore.getState();
  const connection = store.connections.trigger;
  const session = store._session;
  if (!connection || connection.readyState !== 1 || store._auth_phase !== "authenticated")
    throw new Error("Backend command channel is unavailable");
  const timestamp = Math.max(getTimestampMs(), commandTimestamp + 1);
  commandTimestamp = timestamp;
  return new Promise((resolve, reject) => {
    let allocated = timestamp;
    let callback: unknown;
    const timer = setTimeout(() => {
      const pending = useWebSocketStore.getState().pendingCallbacks;
      if (callback && pending[allocated] === callback) delete pending[allocated];
      reject(new Error(`Backend command timed out: ${name}`));
    }, 30_000);
    try {
      allocated = store.trigger(
        { timestamp, command: name, config_id: configId, payload: {} },
        (response) => {
          clearTimeout(timer);
          const current = useWebSocketStore.getState();
          if (current.connections.trigger !== connection || current._session !== session)
            reject(new Error("Backend command session changed"));
          else if (response.status === "error") reject(new Error(String(response.error ?? name)));
          else resolve(response.data);
        }
      );
      callback = useWebSocketStore.getState().pendingCallbacks[allocated];
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
