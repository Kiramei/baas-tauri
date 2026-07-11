export interface PendingTransportCallbackState {
  pendingCallbacks: Record<string, (data?: unknown) => void>;
  pendingStreamCallbacks: Record<string, (data?: unknown) => void>;
  pendingBinaryCallbacks: Record<string, (data: ArrayBuffer) => void>;
  pendingBinaryQueue: number[];
}

export interface PendingTransportCallbackReset {
  pendingCallbacks: Record<string, never>;
  pendingStreamCallbacks: Record<string, never>;
  pendingBinaryCallbacks: Record<string, never>;
  pendingBinaryQueue: never[];
}

/** Rejects and clears transport-level callbacks that would otherwise wait forever after close. */
export const rejectPendingTransportCallbacks = (
  state: PendingTransportCallbackState,
  reason: string
): PendingTransportCallbackReset => {
  const payload = { status: "error", error: reason };
  Object.values(state.pendingCallbacks).forEach((callback) => {
    try {
      callback(payload);
    } catch (error) {
      console.error("Pending callback failed during transport close:", error);
    }
  });
  Object.values(state.pendingStreamCallbacks).forEach((callback) => {
    try {
      callback(payload);
    } catch (error) {
      console.error("Pending stream callback failed during transport close:", error);
    }
  });
  return {
    pendingCallbacks: {},
    pendingStreamCallbacks: {},
    pendingBinaryCallbacks: {},
    pendingBinaryQueue: [],
  };
};
