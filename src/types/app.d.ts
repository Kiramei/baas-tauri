import { DynamicConfig } from "@/types/dynamic";
import { Dispatch, SetStateAction } from "react";
import { PageKey } from "@/App.tsx";
import type {
  BackendAuthPhase,
  BackendConnection,
  BackendControlConnection,
  BackendControlSessionBundle,
} from "@/transport/types";

export interface ConfigProfile {
  id: string;
  name: string;
  settings: DynamicConfig;
}

export interface RemoteSettings {
  streamPlayer: "mse" | "broadway" | "tinyh264" | "webcodecs";
  enableSafeStream: boolean;
  maxWidth: number;
  maxHeight: number;
  maxFPS: number;
  bitRate: number;
  iFrameRate: number;
  showStatus: boolean;
}

export interface UISettings {
  lang: string;
  theme: string;
  themeColor: string;
  backgroundImageBase64: string | null;
  backgroundImageOpacity: number;
  zoomScale: number;
  scrollToEnd: boolean;
  assetsDisplay: boolean;
  enableBAComet: boolean;
  lowPerformanceMode: boolean;
  enableSystemNotifications: boolean;
  remoteSettings: RemoteSettings;
}

export type Theme = "light" | "dark" | "system";

/**
 * Identifiers for each primary application route.
 */
export type PageKey = "home" | "scheduler" | "configuration" | "settings" | "wiki";

export interface ProfileProps {
  profileId?: string;
  setActivePage?: Dispatch<SetStateAction<PageKey>>;
}

export interface ProfileDTO {
  id: string;
  name: string;
  server: string;
  settings: DynamicConfig;
}

export interface StringKVMap {
  [key: string]: string;
}

export interface BackendCallbackDict {
  [key: string]: (message: BackendMessageItem) => void;
}

export type WsCallBackDict = BackendCallbackDict;
export type BackendChannelKey = "provider" | "sync" | "trigger" | `remote-${string}`;
export type WsName = BackendChannelKey;
export type TransportMode = "shared-memory" | "websocket";
export type ConnectionPhase = "idle" | "starting-backend" | "connecting" | "ready" | "failed";

export interface LogItem {
  time: string;
  level: string;
  message: string;
}

interface RawLogItem extends LogItem {
  scope: string;

  [key: string]: any;
}

interface StatusItem {
  running: boolean;
  config_id: string | null;
  current_task: string | null;
  waiting_tasks: string[];
  timestamp: number;

  [key: string]: any;
}

interface WrappedStatusItem {
  config_id: string | null;
  status: StatusItem;

  [key: string]: any;
}

interface CommandPayload {
  command: string;
  config_id?: string;
  timestamp: number;
  payload: { [id: string]: any };
}

interface InitState {
  all_data_initialized: boolean;

  [key: string]: any;
}

interface SyncOperation {
  op: string;
  path: string;
  value: any | null;
}

export interface BackendMessageItem {
  type: string;
  scopes?: string[];
  entry?: RawLogItem;
  entries?: RawLogItem[];
  status?: InitState | StatusItem | WrappedStatusItem | string;
  timestamp?: number;
  data?: any;
  resource?: string;
  resource_id?: string;
  ops?: SyncOperation[];
  command?: string;
  error?: string;
}

export type WsMessageItem = BackendMessageItem;

interface LogStoreSet {
  [key: string]: LogItem[];
}

export interface BackendState {
  transportMode: TransportMode;
  connectionPhase: ConnectionPhase;
  requiresAuthentication: boolean;
  connections: Partial<Record<BackendChannelKey, BackendConnection>>;
  logStore: LogStoreSet;
  configStore: any;
  staticStore: any;
  eventStore: any;
  updateStore: any;
  versionStore: any;
  statusStore: { [id: string]: StatusItem };
  startAuthFlow: () => Promise<void>;
  submitPassword: (password: string) => Promise<void>;
  checkTauriUpdater: (notify?: boolean, visible?: boolean) => Promise<void>;
  startTauriUpdaterPolling: () => void;
  connect: (name: BackendChannelKey) => Promise<void>;
  disconnect: (name: BackendChannelKey) => void;
  send: (name: BackendChannelKey, data: any) => void;
  init: () => Promise<void>;
  modify: (path: string, value: any, showToast?: boolean) => void;
  patch: (path: string, value: any) => void;
  trigger: (payload: CommandPayload, callback?: (e: any) => void) => void;
  triggerStream: (payload: CommandPayload, callback?: (e: any) => void) => void;
  triggerBinary: (
    payload: CommandPayload,
    binary: ArrayBuffer | Uint8Array,
    callback?: (e: any) => void
  ) => void;
  connectRemote: () => Promise<BackendConnection>;
  pendingCallbacks: Record<string, (data?: any) => void>;
  pendingStreamCallbacks: Record<string, (data?: any) => void>;
  pendingBinaryCallbacks: Record<string, (data: ArrayBuffer) => void>;
  pendingBinaryQueue: number[];

  _all_data_initialized: boolean;
  _heartbeat_time: number;
  _initiating: boolean;
  _auth_phase: BackendAuthPhase;
  _auth_error: string | null;
  _server_initialized: boolean;
  _server_verified: boolean;
  _pwd_epoch: number;
  _control: BackendControlConnection | null;
  _session: BackendControlSessionBundle | null;
}

export type WebSocketState = BackendState;

interface BaseBackendInterface {
  baseBackendAddr: string;
  baseBackendPort: number;
  serviceSecret: string;
}
