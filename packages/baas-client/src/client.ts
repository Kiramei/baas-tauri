import { ControlConnection, SecureWebSocket } from "./SecureWebSocket";
import { PipeConnection, type ChannelName, type ClientConnection, type Message } from "./pipe";

export interface BaasClientOptions {
  url?: string;
  pipe?: string;
  key?: string;
  serverSignPublicKey?: string;
  timeoutMs?: number;
}

export interface BaasLogEntry {
  scope: string;
  time: string;
  level: string;
  message: string;
}

/** Per-profile state is forward-compatible with backend scheduler fields. */
export interface BaasRunStatus extends Record<string, any> {
  run_id?: string | null;
  running?: boolean;
  exit_code?: number | null;
  timestamp?: number;
}
export type BaasStatusSnapshot = Record<string, BaasRunStatus>;
export interface BaasStatusUpdate {
  full: boolean;
  configId: string | null;
  status: Record<string, any>;
}
export interface BaasPatchOptions {
  expectedValue?: unknown;
  checkExpected?: boolean;
}

export class BaasCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly response: Message
  ) {
    super(typeof response.error === "string" ? response.error : `BAAS command failed: ${command}`);
    this.name = "BaasCommandError";
  }
}

export class BaasConflictError extends Error {
  constructor(public readonly snapshot: Message) {
    super("Configuration changed on the backend. Read it again before retrying this edit.");
    this.name = "BaasConflictError";
  }
}

interface PendingMessage {
  channel: ChannelName;
  matches: (message: Message) => boolean;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Headless BAAS service client; it does not start or depend on the desktop application. */
export class BaasClient {
  private readonly options: BaasClientOptions;
  private readonly timeoutMs: number;
  private connections: Partial<Record<ChannelName, ClientConnection>> = {};
  private control: ControlConnection | null = null;
  private connecting: Promise<void> | null = null;
  private connected = false;
  private lifecycleActive = false;
  private controller: AbortController | null = null;
  private generation = 0;
  private lastTimestamp = 0;
  private pending = new Set<PendingMessage>();
  private logEntries: BaasLogEntry[] = [];
  private logListeners = new Set<(entry: BaasLogEntry) => void>();
  private statusListeners = new Set<
    (update: BaasStatusUpdate, snapshot: BaasStatusSnapshot) => void
  >();
  private disconnectListeners = new Set<(error: Error) => void>();
  private cachedStatus: BaasStatusSnapshot = Object.create(null);
  private statusRevision = 0;
  private statusRevisions = new Map<string, number>();
  private patchQueue: Promise<void> = Promise.resolve();

  constructor(options: BaasClientOptions = {}) {
    if (options.pipe && options.url) throw new Error("Choose a backend URL or a local pipe");
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    )
      throw new Error("timeoutMs must be a positive number");
    this.options = { ...options };
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.lifecycleActive = true;
    // Start on the next microtask so close()/disconnect subscribers can safely
    // replace an attempt without a late finally clearing the newer promise.
    const opening = Promise.resolve().then(() => this.open(generation, controller.signal));
    this.connecting = opening;
    const clear = () => {
      if (this.connecting === opening) this.connecting = null;
    };
    void opening.then(clear, clear);
    return opening;
  }

  private async open(generation: number, signal: AbortSignal): Promise<void> {
    this.logEntries = [];
    this.cachedStatus = Object.create(null);
    this.statusRevisions.clear();
    this.statusRevision += 1;
    const current = () => generation === this.generation && !signal.aborted;
    try {
      if (!current()) throw new Error("Connection was closed");
      if (!this.options.pipe) {
        if (!this.options.key?.trim())
          throw new Error("A BAAS login Key is required for a WebSocket connection");
        const url = this.baseUrl();
        const control = await ControlConnection.open(
          `${url}/ws/control`,
          this.options.serverSignPublicKey,
          this.timeoutMs,
          signal
        );
        if (!current()) {
          control.close();
          throw new Error("Connection was closed");
        }
        this.control = control;
        const session = await control.authenticate(this.options.key);
        control.onClose = () => {
          if (current()) this.disconnect(new Error("BAAS authentication channel closed"));
        };
        control.onError = () => {
          if (current()) this.disconnect(new Error("BAAS authentication channel failed"));
        };
        control.onSecureMessage = (message) => {
          if (current() && message.type === "auth_revoked")
            this.disconnect(new Error("BAAS authentication session was revoked"));
        };
        for (const channel of ["provider", "sync", "trigger"] as const) {
          if (!current()) throw new Error("Connection was closed");
          const connection = new SecureWebSocket(
            `${url}/ws/${channel}`,
            channel,
            session,
            "arraybuffer",
            this.options.serverSignPublicKey,
            this.timeoutMs,
            signal
          );
          this.connections[channel] = connection;
          connection.onClose = () => {
            if (current()) this.disconnect(new Error(`BAAS ${channel} channel closed`));
          };
          connection.onError = () => {
            if (current()) this.disconnect(new Error(`BAAS ${channel} channel failed`));
          };
          await connection.connect((message) => {
            if (current()) this.receive(channel, message);
          });
        }
      } else {
        for (const channel of ["provider", "sync", "trigger"] as const) {
          if (!current()) throw new Error("Connection was closed");
          const connection = new PipeConnection(
            this.options.pipe,
            channel,
            this.timeoutMs,
            (message) => {
              if (current()) this.receive(channel, message);
            },
            (error) => {
              if (current()) this.disconnect(error);
            }
          );
          this.connections[channel] = connection;
          await connection.connect();
        }
      }
      if (!current()) throw new Error("Connection was closed");
      this.connected = true;
    } catch (error) {
      if (generation === this.generation) this.disconnect(asError(error));
      throw error;
    }
  }

  close(): void {
    this.disconnect(new Error("BAAS client closed"));
  }

  private disconnect(error: Error): void {
    const notify = this.lifecycleActive;
    this.lifecycleActive = false;
    this.generation += 1;
    this.connected = false;
    this.connecting = null;
    const controller = this.controller;
    this.controller = null;
    controller?.abort(error);
    const connections = this.connections;
    this.connections = {};
    const control = this.control;
    this.control = null;
    if (control) {
      control.onClose = undefined;
      control.onError = undefined;
      control.onSecureMessage = undefined;
      control.close();
    }
    for (const connection of Object.values(connections)) void connection.close();
    for (const request of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (notify)
      for (const listener of [...this.disconnectListeners]) {
        try {
          listener(error);
        } catch {
          /* One subscriber cannot suppress the others. */
        }
      }
  }

  private baseUrl(): string {
    const url = new URL(this.options.url ?? "ws://127.0.0.1:8190");
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol !== "ws:" && url.protocol !== "wss:")
      throw new Error("Backend URL must use http, https, ws or wss");
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Backend URL must not contain credentials, query parameters or a fragment");
    return url.toString().replace(/\/+$/, "");
  }

  private receive(channel: ChannelName, message: Message): void {
    if (!message || typeof message !== "object") return;
    if (channel === "provider") {
      if (message.type === "logs_full" && Array.isArray(message.entries)) {
        this.logEntries = clone(message.entries.slice(-10_000));
      } else if (message.type === "log" && message.entry) {
        this.logEntries.push(clone(message.entry));
        if (this.logEntries.length > 10_000)
          this.logEntries.splice(0, this.logEntries.length - 10_000);
        for (const listener of [...this.logListeners]) {
          try {
            listener(clone(message.entry));
          } catch {
            /* Subscribers cannot break protocol processing. */
          }
        }
      } else if (message.type === "status") {
        this.receiveStatus(message.status);
      }
    }
    for (const request of [...this.pending]) {
      if (request.channel === channel && request.matches(message)) {
        this.pending.delete(request);
        clearTimeout(request.timer);
        request.resolve(message);
      }
    }
  }

  private exchange(
    channel: ChannelName,
    payload: Message,
    matches: PendingMessage["matches"]
  ): Promise<Message> {
    const connection = this.connections[channel];
    if (!connection || !this.connected)
      return Promise.reject(new Error("BAAS client is not connected"));
    return new Promise((resolve, reject) => {
      const request: PendingMessage = {
        channel,
        matches,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(request);
          reject(
            new Error(`Timed out waiting for BAAS ${payload.command ?? payload.type} response`)
          );
        }, this.timeoutMs),
      };
      this.pending.add(request);
      try {
        const sent = connection.sendJson(payload);
        if (sent)
          void sent.catch((error) => {
            if (!this.pending.delete(request)) return;
            clearTimeout(request.timer);
            reject(asError(error));
          });
      } catch (error) {
        this.pending.delete(request);
        clearTimeout(request.timer);
        reject(asError(error));
      }
    });
  }

  private timestamp(minimum = 0): number {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1, minimum);
    return this.lastTimestamp;
  }

  async request(
    command: string,
    configId?: string,
    payload: Record<string, unknown> = {}
  ): Promise<any> {
    if (["import_config", "export_config"].includes(command))
      throw new Error("Binary configuration archives are not supported by this JSON client");
    if (command.endsWith("_stream")) throw new Error("Use a non-streaming command with request()");
    await this.connect();
    const timestamp = this.timestamp();
    const response = await this.exchange(
      "trigger",
      {
        type: "command",
        command,
        config_id: configId,
        payload,
        timestamp,
      },
      (message) =>
        message.type === "command_response" &&
        message.timestamp === timestamp &&
        message.command === command
    );
    if (response.status !== "ok") throw new BaasCommandError(command, response);
    return response.data;
  }

  private async snapshot(resource: string, resourceId?: string): Promise<Message> {
    await this.connect();
    return this.exchange(
      "sync",
      { type: "pull", resource, resource_id: resourceId },
      (message) =>
        message.type === "snapshot" &&
        message.resource === resource &&
        (message.resource_id ?? undefined) === resourceId
    );
  }

  async profiles(): Promise<Record<string, string>> {
    await this.connect();
    const response = await this.exchange(
      "sync",
      { type: "list" },
      (message) => message.type === "config_list"
    );
    const ids: unknown[] = response.data;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
      throw new Error("Invalid BAAS profile list");
    const entries = await Promise.all(
      (ids as string[]).map(async (id) => {
        const config = await this.config(id);
        return [id, String(config.name || id)] as const;
      })
    );
    return Object.fromEntries(entries);
  }

  async status(): Promise<BaasStatusSnapshot> {
    await this.connect();
    const generation = this.generation;
    const revision = this.statusRevision;
    const response = await this.request("status");
    if (generation !== this.generation) throw new Error("Connection changed while reading status");
    this.applyStatus(response, true, null, revision);
    return clone(this.cachedStatus);
  }

  get statusSnapshot(): BaasStatusSnapshot {
    return clone(this.cachedStatus);
  }

  onStatus(listener: (update: BaasStatusUpdate, snapshot: BaasStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  private receiveStatus(status: unknown): void {
    if (!isRecord(status)) return;
    if (typeof status.config_id === "string" && isRecord(status.status)) {
      this.applyStatus({ [status.config_id]: status.status }, false, status.config_id);
    } else if (!Object.hasOwn(status, "is_all_data_initialized")) {
      this.applyStatus(status, true, null);
    }
  }

  private applyStatus(
    raw: unknown,
    full: boolean,
    configId: string | null,
    readRevision = Number.POSITIVE_INFINITY
  ): void {
    if (!isRecord(raw)) return;
    const incoming = Object.fromEntries(
      Object.entries(raw).filter(([, value]) => isRecord(value))
    ) as BaasStatusSnapshot;
    const next: BaasStatusSnapshot = Object.assign(
      Object.create(null),
      full ? {} : this.cachedStatus
    );
    let changed = full && Object.keys(this.cachedStatus).length !== Object.keys(incoming).length;
    for (const [id, status] of Object.entries(incoming)) {
      const previous = this.cachedStatus[id];
      const older =
        previous &&
        typeof previous.timestamp === "number" &&
        typeof status.timestamp === "number" &&
        status.timestamp < previous.timestamp;
      const changedAfterRead =
        previous &&
        (this.statusRevisions.get(id) ?? 0) > readRevision &&
        (typeof status.timestamp !== "number" || typeof previous.timestamp !== "number");
      if (older || changedAfterRead) next[id] = previous;
      else {
        next[id] = clone(status);
        this.statusRevisions.set(id, ++this.statusRevision);
        changed = true;
      }
    }
    if (full)
      for (const [id, previous] of Object.entries(this.cachedStatus)) {
        if (!Object.hasOwn(next, id) && (this.statusRevisions.get(id) ?? 0) > readRevision)
          next[id] = previous;
      }
    this.cachedStatus = next;
    if (!changed && !full) return;
    const update: BaasStatusUpdate = {
      full,
      configId,
      status: clone(full ? next : (next[configId!] ?? {})),
    };
    for (const listener of [...this.statusListeners]) {
      try {
        listener(clone(update), clone(next));
      } catch {
        /* Subscribers cannot change cache or callback order. */
      }
    }
  }

  async config(id: string): Promise<Record<string, any>> {
    return (await this.snapshot("config", id)).data;
  }

  /** Event resources are arrays on the wire; expose them keyed by runnable func_name. */
  async tasks(id: string): Promise<Record<string, any>> {
    const data = (await this.snapshot("event", id)).data;
    if (!Array.isArray(data)) return data;
    return Object.fromEntries(
      data.map((task: Message, index: number) => [String(task.func_name ?? index), task])
    );
  }

  async logs(limit = 100, profile?: string): Promise<BaasLogEntry[]> {
    await this.connect();
    // The provider sends history immediately after open_ok. A status round trip
    // also ensures that history already queued on that channel has been received.
    await this.exchange(
      "provider",
      { type: "status_request" },
      (message) => message.type === "status"
    );
    const count = Math.max(0, Math.min(10_000, Math.floor(limit)));
    if (!Number.isFinite(count)) throw new Error("Log limit must be a finite number");
    const entries = profile
      ? this.logEntries.filter((entry) => entry.scope === `config:${profile}`)
      : this.logEntries;
    return count ? entries.slice(-count).map((entry) => ({ ...entry })) : [];
  }

  onLog(listener: (entry: BaasLogEntry) => void): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  patchConfig(
    id: string,
    path: string,
    value: unknown,
    options: BaasPatchOptions = {}
  ): Promise<Record<string, any>> {
    const generation = this.generation;
    const operation = this.patchQueue.then(() =>
      this.patchConfigOnce(id, path, value, options, generation)
    );
    this.patchQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async patchConfigOnce(
    id: string,
    path: string,
    value: unknown,
    options: BaasPatchOptions,
    generation: number
  ): Promise<Record<string, any>> {
    if (generation !== this.generation)
      throw new Error("Connection changed before configuration edit");
    const snapshot = await this.snapshot("config", id);
    if (generation !== this.generation)
      throw new Error("Connection changed before configuration edit");
    const timestamp = Number(snapshot.timestamp);
    if (!Number.isFinite(timestamp)) throw new Error("Invalid configuration snapshot timestamp");
    const pointer = path.startsWith("/")
      ? path
      : `/${path.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (
      options.checkExpected &&
      !jsonEqual(readPointer(snapshot.data, pointer), options.expectedValue)
    ) {
      throw new BaasConflictError({
        ...snapshot,
        type: "patch_conflict",
        error: "Configuration changed while awaiting approval",
      });
    }
    const response = await this.exchange(
      "sync",
      {
        type: "patch",
        resource: "config",
        resource_id: id,
        timestamp,
        ops: [{ op: "replace", path: pointer, value }],
      },
      (message) =>
        message.resource === "config" &&
        message.resource_id === id &&
        ((message.type === "patch_ack" && message.timestamp === timestamp) ||
          (message.type === "patch_conflict" && message.request_timestamp === timestamp))
    );
    if (response.type === "patch_conflict") throw new BaasConflictError(response);
    return this.config(id);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readPointer(document: unknown, path: string): unknown {
  if (path === "" || path === "/") return document;
  let current = document;
  for (const key of path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key))
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
  );
}
