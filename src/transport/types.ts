import type { ControlConnection, ControlSessionBundle } from "@/shared/SecureWebSocket";

export type BackendChannelName = "provider" | "sync" | "trigger" | "remote";
export type BackendTransportMode = "websocket" | "pipe";
export type BackendRuntimeKind = "python" | "cpp";

export interface BackendConnection {
  readonly readyState: number | undefined;
  connect(
    onMessage: (message: any) => void,
    decodeJson?: boolean,
    decrypt?: boolean
  ): Promise<void>;
  sendJson(payload: Record<string, unknown>): Promise<void> | void;
  sendBytes(payload: ArrayBuffer | Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  hookClose?: () => void;
}

export type BackendControlConnection = ControlConnection;
export type BackendControlSessionBundle = ControlSessionBundle;
