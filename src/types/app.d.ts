import {DynamicConfig} from "@/types/dynamic";
import {Dispatch, SetStateAction} from "react";
import {PageKey} from "@/App.tsx";

export interface ConfigProfile {
  id: string;
  name: string;
  settings: DynamicConfig;
}

export interface UISettings {
  lang: string;
  theme: string;
  zoomScale: number;
  scrollToEnd: boolean;
  assetsDisplay: boolean;
}

export type Theme = 'light' | 'dark' | 'system';

/**
 * Identifiers for each primary application route.
 */
export type PageKey = 'home' | 'scheduler' | 'configuration' | 'settings' | 'wiki';

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

export interface WsCallBackDict {
  [key: string]: (message: WsMessageItem) => void;
}


type WsName = "provider" | "sync" | "trigger" | "heartbeat";

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

interface WsMessageItem {
  type: string;
  scopes?: string[];
  entry?: RawLogItem;
  entries?: RawLogItem[];
  status?: InitState | StatusItem | WrappedStatusItem | string;
  timestamp?: number;
  data?: any;
  resource?: string;
  resource_id?: string;
  "ops"?: SyncOperation;
  "command"?: string;
}


interface LogStoreSet {
  [key: string]: LogItem[];
}

interface WebSocketState {
  connections: Partial<Record<WsName, SecureWebSocket>>;
  logStore: LogStoreSet;
  configStore: any;
  staticStore: any;
  eventStore: any;
  updateStore: any;
  versionStore: any;
  statusStore: { [id: string]: StatusItem };
  connect: (name: WsName) => Promise<void>;
  disconnect: (name: WsName) => void;
  send: (name: WsName, data: any) => void;
  init: () => Promise<void>;
  modify: (path: string, value: any, showToast?: boolean) => void;
  patch: (path: string, value: any) => void;
  trigger: (payload: CommandPayload, callback?: (e: any) => void) => void;
  pendingCallbacks: Record<string, (data?: any) => void>;

  _all_data_initialized: boolean;
  _heartbeat_time: number;
  _initiating: boolean;
  _secret: string;
}

interface ConnectionError {
  reason: string;

  [key: string]: any;
}
