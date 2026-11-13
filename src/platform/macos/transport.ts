import type { BackendTransportMode } from "@/transport/types";

/** macOS supports local shared memory and remote WebSocket connections. */
export function macTransportMode(value: unknown): BackendTransportMode {
  return value === "websocket" ? "websocket" : "shm";
}
