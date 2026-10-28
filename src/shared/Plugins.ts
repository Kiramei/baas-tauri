import type { WebSocketState } from "@/types/app";

export type PluginText = string | Record<string, string>;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface PluginSchema {
  type?: "object" | "array" | "boolean" | "number" | "integer" | "string" | "null";
  title?: PluginText;
  description?: PluginText;
  properties?: Record<string, PluginSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: PluginSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: JsonValue[];
  default?: JsonValue;
  format?: "date-time";
}
export interface PluginAction {
  id: string;
  name: PluginText;
  description?: PluginText;
  execution: "compute" | "device_task" | "host_automation";
  input_schema: PluginSchema;
  output_schema?: PluginSchema;
  timeout_seconds?: number;
}
export interface PluginDescriptor {
  schema_version: 1;
  api_version: 1;
  id: string;
  version: string;
  name: PluginText;
  description?: PluginText;
  author?: string;
  permissions: string[];
  settings_schema: PluginSchema;
  actions: PluginAction[];
  source: "builtin" | "external";
  enabled: boolean;
  trusted: boolean;
  state: "available" | "incompatible" | "error";
  error?: { code: string; message: string };
  contributions?: {
    home?: { id: string; title: PluginText; description?: PluginText; action_id: string }[];
  };
}
export interface PluginCatalog {
  api_version: 1;
  capabilities: string[];
  plugins: PluginDescriptor[];
  errors: { code: string; message: string; plugin_id?: string }[];
}
export interface PluginSettings {
  plugin_id: string;
  config_id: string;
  revision: number;
  values: Record<string, JsonValue>;
}
export interface PluginJob {
  id: string;
  plugin_id: string;
  action_id: string;
  config_id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at: number;
  updated_at: number;
  result?: JsonValue;
  error?: { code: string; message: string };
}

export class PluginRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PluginRequestError";
  }
}

let requestedPlugin: string | null = null;
export const PLUGIN_OPEN_EVENT = "baas:open-plugin";
/** Navigation only; opening a home contribution never runs plugin code. */
export function requestPluginOpen(pluginId: string): void {
  requestedPlugin = pluginId;
  window.dispatchEvent(new Event(PLUGIN_OPEN_EVENT));
}
export function consumeRequestedPlugin(): string | null {
  const id = requestedPlugin;
  requestedPlugin = null;
  return id;
}

/** randomUUID requires HTTPS in browsers; getRandomValues also works on a local HTTP WebUI. */
export function createPluginRequestId(
  source: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">> = crypto
): string {
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
type PluginStore = Pick<
  WebSocketState,
  "trigger" | "triggerBinary" | "connections" | "pendingCallbacks" | "_auth_phase" | "_session"
>;

/** Keep commands on the authenticated transport and discard replies from a replaced session. */
export async function requestPluginCommand<T>(
  getState: () => PluginStore,
  command: string,
  configId?: string,
  payload: Record<string, unknown> = {},
  binary?: Uint8Array,
  timeoutMs = 30_000
): Promise<T> {
  const state = getState();
  const sessionId = state._session?.sessionId;
  if (
    state._auth_phase !== "authenticated" ||
    !sessionId ||
    state.connections.trigger?.readyState !== 1
  )
    throw new PluginRequestError(
      "connection_unavailable",
      "Authenticated command connection is unavailable"
    );
  return new Promise((resolve, reject) => {
    let timestamp: number | undefined;
    let registered: PluginStore["pendingCallbacks"][number] | undefined;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (
        timestamp !== undefined &&
        registered &&
        getState().pendingCallbacks[timestamp] === registered
      )
        delete getState().pendingCallbacks[timestamp];
    };
    const callback = (response: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (
        getState()._auth_phase !== "authenticated" ||
        getState()._session?.sessionId !== sessionId
      ) {
        reject(new PluginRequestError("session_changed", "Authentication session changed"));
      } else if (response?.status !== "ok") {
        const message =
          typeof response?.error === "string" ? response.error : "Plugin command failed";
        const unsupported =
          /unknown.?command|not.?supported|unsupported.?command|unrecognized.?command/i.test(
            `${response?.code ?? ""} ${message}`
          );
        reject(
          new PluginRequestError(
            unsupported ? "unsupported" : (response?.code ?? "request_failed"),
            message
          )
        );
      } else resolve(response.data as T);
    };
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new PluginRequestError("timeout", "Plugin command timed out"));
    }, timeoutMs);
    try {
      const request = {
        timestamp: Date.now(),
        command,
        ...(configId ? { config_id: configId } : {}),
        payload,
      };
      timestamp = binary
        ? state.triggerBinary(request, binary, callback)
        : state.trigger(request, callback);
      registered = getState().pendingCallbacks[timestamp];
      if (settled) cleanup();
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

export async function pluginRequest<T>(
  command: string,
  configId?: string,
  payload: Record<string, unknown> = {},
  binary?: Uint8Array
): Promise<T> {
  const { useWebSocketStore } = await import("@/store/WebsocketStore");
  const result = await requestPluginCommand<T>(
    useWebSocketStore.getState,
    command,
    configId,
    payload,
    binary
  );
  if (
    ["set_plugin_enabled", "update_plugin_settings", "install_plugin", "uninstall_plugin"].includes(
      command
    )
  )
    window.dispatchEvent(new CustomEvent("baas:plugins-changed", { detail: { configId } }));
  return result;
}

export function pluginText(value: PluginText | undefined, language: string): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  return (
    value[language] ??
    value[language.split("-")[0]] ??
    value.en ??
    value.zh ??
    Object.values(value)[0] ??
    ""
  );
}

/** Only materialize declared defaults and required properties, leaving optional values absent. */
export function pluginDefaults(schema: PluginSchema): JsonValue {
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.enum?.length) return structuredClone(schema.enum[0]);
  if (schema.type === "object") {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key, child]) => child.default !== undefined || schema.required?.includes(key))
        .map(([key, child]) => [key, pluginDefaults(child)])
    );
  }
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 0;
  if (schema.type === "null") return null;
  return "";
}
export interface PluginValidationIssue {
  path: string;
  reason:
    | "required"
    | "type"
    | "enum"
    | "minimum"
    | "maximum"
    | "minLength"
    | "maxLength"
    | "minItems"
    | "maxItems"
    | "unknown";
  limit?: number;
}

/** JSON objects are unordered; enum matching must not depend on a producer's key order. */
export function pluginJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right || typeof left !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => pluginJsonEqual(item, right[index]))
    );
  const leftKeys = Object.keys(left);
  const rightObject = right as Record<string, unknown>;
  return (
    leftKeys.length === Object.keys(rightObject).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightObject, key) &&
        pluginJsonEqual((left as Record<string, unknown>)[key], rightObject[key])
    )
  );
}
/** The server remains authoritative; this validator provides immediate feedback for the v1 subset. */
export function validatePluginValue(
  schema: PluginSchema,
  value: unknown,
  path = "$"
): PluginValidationIssue[] {
  if (value === undefined) return [];
  const issue = (reason: PluginValidationIssue["reason"], limit?: number) => [
    { path, reason, ...(limit !== undefined ? { limit } : {}) },
  ];
  const type = schema.type;
  if (
    (type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) ||
    (type === "array" && !Array.isArray(value)) ||
    (type === "null" && value !== null) ||
    (type === "boolean" && typeof value !== "boolean") ||
    (type === "string" && typeof value !== "string") ||
    ((type === "number" || type === "integer") &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        (type === "integer" && !Number.isInteger(value))))
  )
    return issue("type");
  if (schema.enum && !schema.enum.some((item) => pluginJsonEqual(item, value)))
    return issue("enum");
  if (type === "object") {
    const object = value as Record<string, unknown>;
    const issues: PluginValidationIssue[] = (schema.required ?? [])
      .filter((key) => !Object.hasOwn(object, key) || object[key] === undefined)
      .map((key) => ({ path: `${path}.${key}`, reason: "required" }));
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      issues.push(...validatePluginValue(child, object[key], `${path}.${key}`));
    for (const key of Object.keys(object))
      if (!Object.hasOwn(schema.properties ?? {}, key))
        issues.push({ path: `${path}.${key}`, reason: "unknown" });
    return issues;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return issue("minItems", schema.minItems);
    if (value.length > (schema.maxItems ?? 256)) return issue("maxItems", schema.maxItems ?? 256);
    return value.flatMap((item, index) =>
      schema.items ? validatePluginValue(schema.items, item, `${path}[${index}]`) : []
    );
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      return issue("minimum", schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum)
      return issue("maximum", schema.maximum);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength)
      return issue("minLength", schema.minLength);
    if ([...value].length > (schema.maxLength ?? 16384))
      return issue("maxLength", schema.maxLength ?? 16384);
  }
  return [];
}
