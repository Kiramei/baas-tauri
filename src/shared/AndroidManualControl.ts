import type { WebSocketState } from "@/types/app";
import { otherRunningAndroidProfiles } from "@/shared/AndroidProfileGame";

let manualControlActive = false;
let backendUpdateActive = false;
/** Manual play must not trigger an idle backend update/reload behind the game. */
export const androidManualControl = {
  isActive: () => manualControlActive,
  begin: () => {
    if (manualControlActive || backendUpdateActive) return false;
    manualControlActive = true;
    return true;
  },
  beginBackendUpdate: () => {
    if (manualControlActive || backendUpdateActive) return false;
    backendUpdateActive = true;
    return true;
  },
  endBackendUpdate: () => {
    backendUpdateActive = false;
  },
  setActive: (active: boolean) => {
    manualControlActive = active;
  },
};

/** Only an explicit new Start may re-enable automation after manual play. */
export async function resumeAndroidAutomationBeforeStart(
  displayId: number,
  resume: (request: { displayId: number }) => Promise<{ resumed: boolean }>
): Promise<boolean> {
  if (androidManualControl.isActive()) return false;
  if (!Number.isSafeInteger(displayId) || displayId <= 0)
    throw new Error("The owned Android game display is unavailable");
  const response = await resume({ displayId });
  if (response?.resumed !== true) throw new Error("Android automation input was not enabled");
  // Manual entry can reserve the session while this native request is awaiting
  // acknowledgement. Never dispatch a late scheduler start behind that entry.
  return !androidManualControl.isActive();
}

type SchedulerStore = Pick<
  WebSocketState,
  "statusStore" | "connections" | "trigger" | "pendingCallbacks"
>;

/** Viewing/playing the owned game must never stop or restart its scheduler. */
export async function verifyAndroidManualControlOwnership(
  getState: () => SchedulerStore,
  profileId: string,
  timeoutMs = 15_000
): Promise<void> {
  const state = getState();
  if (otherRunningAndroidProfiles(state.statusStore, profileId).length) {
    throw new Error("Another profile owns the Android game session");
  }
  if (state.connections.trigger?.readyState !== 1)
    throw new Error("Backend command channel is unavailable");
  const statuses = await new Promise<any>((resolve, reject) => {
    const name = "status";
    let timestamp: number | undefined;
    let registeredCallback: WebSocketState["pendingCallbacks"][number] | undefined;
    const callback = (response: any) => {
      clearTimeout(timer);
      if (response?.status === "error")
        reject(new Error(response.error || "Unable to verify the game session"));
      else resolve(response?.data);
    };
    const timer = setTimeout(() => {
      if (
        timestamp !== undefined &&
        registeredCallback &&
        getState().pendingCallbacks[timestamp] === registeredCallback
      )
        delete getState().pendingCallbacks[timestamp];
      reject(new Error("Checking the game session timed out; manual game control was not enabled"));
    }, timeoutMs);
    try {
      timestamp = state.trigger({ timestamp: Date.now(), command: name, payload: {} }, callback);
      registeredCallback = getState().pendingCallbacks[timestamp];
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
  if (
    !statuses ||
    typeof statuses !== "object" ||
    Array.isArray(statuses) ||
    Object.values(statuses).some((item: any) => !item || typeof item.running !== "boolean")
  ) {
    throw new Error("Unable to confirm the backend scheduler state");
  }
  if (
    Object.entries(statuses).some(
      ([id, item]: [string, any]) => item.running && id !== profileId
    ) ||
    otherRunningAndroidProfiles(getState().statusStore, profileId).length
  ) {
    throw new Error("Another profile owns the Android game session");
  }
}
