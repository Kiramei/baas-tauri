import type { BackendTransportMode } from "@/transport/types";

export const SERVICE_TRANSPORT_DISCONNECTED_EVENT = "baas:service-transport-disconnected";

export type ServiceTransportDisconnectedDetail = {
  mode: BackendTransportMode;
};

/** Returns the bounded delay used between backend recovery attempts. */
export const transportRecoveryDelay = (attempt: number): number =>
  Math.min(1_000 * 2 ** Math.max(0, attempt), 15_000);

/** Announces one transport outage to UI integrations such as native notifications. */
export const announceServiceTransportDisconnected = (mode: BackendTransportMode): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ServiceTransportDisconnectedDetail>(SERVICE_TRANSPORT_DISCONNECTED_EVENT, {
      detail: { mode },
    })
  );
};
