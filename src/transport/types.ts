export type BackendChannelName = "provider" | "sync" | "trigger" | "remote";
export type BackendConnectionState = number;

export interface BackendIncomingMessage {
  data: unknown;
}

export interface BackendCloseReason {
  code?: number;
  reason?: string;
}

export interface BackendChannelOptions {
  name?: string;
  binaryType?: BinaryType;
}

export type BackendAuthPhase =
  | "idle"
  | "control_connecting"
  | "server_verified"
  | "waiting_password"
  | "resuming"
  | "initializing"
  | "authenticating"
  | "authenticated"
  | "revoked";

export interface BackendControlSessionBundle {
  sessionId: string;
  resumeTicket: string;
  pwdEpoch: number;
  expiresAt: number;
  masterSecret: Uint8Array;
  resumeSecret: Uint8Array;
  authMode?: "password" | "remember";
}

export interface BackendControlConnection {
  readonly initialized: boolean;
  readonly pwdEpoch: number;
  onSecureMessage?: ((payload: Record<string, any>) => void) | null;
  onClose?: ((event: CloseEvent) => void) | null;
  onError?: ((event: Event) => void) | null;
  close(): void;
  resumeWithCookie(): Promise<BackendControlSessionBundle | null>;
  authenticate(password: string): Promise<BackendControlSessionBundle>;
}

export interface BackendConnection {
  readonly readyState: BackendConnectionState | undefined;
  connect(onMessage: (message: any) => void, decodeJson?: boolean, decrypt?: boolean): Promise<void>;
  sendJson(payload: Record<string, unknown>): Promise<void> | void;
  sendBytes(payload: ArrayBuffer | Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  onOpen?: (event: Event) => void;
  onClose?: (reason: CloseEvent) => void;
  onError?: (error: Event) => void;
  hookClose?: () => void;
}

export interface BackendTransport {
  openChannel(channel: BackendChannelName, options?: BackendChannelOptions): Promise<BackendConnection>;
  start(): Promise<void>;
  close(): Promise<void>;
}
