import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BaasClient, BaasCommandError, BaasConflictError } from "../src/index";
import { encodePipeFrame, PipeFrameDecoder, PIPE_MAX_PAYLOAD_BYTES } from "../src/pipe";

type Message = Record<string, any>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(options: { conflict?: boolean; stall?: boolean; openStall?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "baas-client-"));
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\baas-client-${process.pid}-${Date.now()}`
      : join(directory, "service.sock");
  const sockets = new Set<Socket>();
  const channels = new Map<string, Socket>();
  const config = { name: "Arona", server: "Global", autostart: false };
  const received: Message[] = [];
  const commandWatchers = new Set<{ command: string; resolve: () => void }>();
  let statuses: Record<string, any> = { alpha: { running: false } };
  const frame = (message: Message) => encodePipeFrame(1, Buffer.from(JSON.stringify(message)));
  const send = (socket: Socket, message: Message) => socket.write(frame(message));
  let deferred: Message | null = null;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const decoder = new PipeFrameDecoder();
    socket.on("data", (chunk) => {
      for (const item of decoder.feed(chunk)) {
        const message: Message = JSON.parse(item.payload.toString("utf8"));
        received.push(message);
        if (message.type === "command")
          for (const watcher of [...commandWatchers]) {
            if (watcher.command === message.command) {
              commandWatchers.delete(watcher);
              watcher.resolve();
            }
          }
        if (message.type === "open") {
          if (options.openStall) continue;
          channels.set(message.channel, socket);
          const initial = [frame({ type: "open_ok", channel: message.channel })];
          if (message.channel === "provider")
            initial.push(
              frame({
                type: "logs_full",
                scopes: ["config:alpha"],
                entries: [
                  {
                    scope: "config:alpha",
                    time: "2026-10-29T00:00:00Z",
                    level: "INFO",
                    message: "Ready",
                  },
                  {
                    scope: "config:other",
                    time: "2026-10-29T00:00:00Z",
                    level: "INFO",
                    message: "Other",
                  },
                ],
              }),
              frame({ type: "status", status: statuses })
            );
          const bytes = Buffer.concat(initial);
          socket.write(bytes.subarray(0, 6));
          setImmediate(() => {
            if (!socket.destroyed) socket.write(bytes.subarray(6));
          });
        } else if (message.type === "list") {
          send(socket, { type: "config_list", timestamp: 12, data: ["alpha"] });
        } else if (message.type === "pull") {
          send(socket, {
            type: "snapshot",
            resource: message.resource,
            resource_id: message.resource_id,
            timestamp: 42.5,
            data:
              message.resource === "event"
                ? [{ func_name: "arena", event_name: "Arena", enabled: true }]
                : { ...config },
          });
        } else if (message.type === "patch") {
          if (options.conflict)
            send(socket, {
              type: "patch_conflict",
              resource: "config",
              resource_id: "alpha",
              request_timestamp: message.timestamp,
              timestamp: message.timestamp + 1,
              data: config,
            });
          else {
            config.autostart = message.ops[0].value;
            send(socket, {
              type: "patch",
              resource: "config",
              resource_id: "alpha",
              timestamp: message.timestamp,
              ops: message.ops,
            });
            send(socket, {
              type: "patch_ack",
              resource: "config",
              resource_id: "alpha",
              timestamp: message.timestamp,
            });
          }
        } else if (message.type === "status_request") {
          send(socket, { type: "status", status: statuses });
        } else if (message.type === "command" && !options.stall) {
          const respond = (request: Message) =>
            send(socket, {
              type: "command_response",
              command: request.command,
              timestamp: request.timestamp,
              status: request.command === "fail" ? "error" : "ok",
              error: request.command === "fail" ? "Fixture failure" : undefined,
              data: request.command === "status" ? statuses : request.payload,
            });
          if (message.command === "reorder") {
            if (!deferred) deferred = message;
            else {
              respond(message);
              respond(deferred);
              deferred = null;
            }
          } else respond(message);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const client = new BaasClient({ pipe: path, timeoutMs: 500 });
  cleanups.push(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    client,
    config,
    received,
    drop: (channel = "provider") => channels.get(channel)?.destroy(),
    waitForCommand: (command: string) =>
      received.some((message) => message.command === command)
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Fixture command was not received")),
              1000
            );
            commandWatchers.add({
              command,
              resolve: () => {
                clearTimeout(timer);
                resolve();
              },
            });
          }),
    push: (message: Message) => {
      if (message.type === "status" && message.status && !message.status.is_all_data_initialized) {
        if (typeof message.status.config_id === "string") {
          const id = message.status.config_id;
          const incoming = message.status.status;
          if (
            !(
              typeof statuses[id]?.timestamp === "number" &&
              typeof incoming?.timestamp === "number" &&
              incoming.timestamp < statuses[id].timestamp
            )
          )
            statuses[id] = incoming;
        } else statuses = message.status;
      }
      send(channels.get("provider")!, message);
    },
  };
}

describe("native pipe framing", () => {
  test("handles split headers, split UTF-8 payloads and multiple frames", () => {
    const bytes = Buffer.concat([
      encodePipeFrame(1, Buffer.from('{"message":"爱丽丝"}')),
      encodePipeFrame(2, Buffer.from([0, 255])),
    ]);
    const decoder = new PipeFrameDecoder();
    const frames = [];
    for (let index = 0; index < bytes.length; index += 3)
      frames.push(...decoder.feed(bytes.subarray(index, index + 3)));
    expect(frames.map((frame) => frame.kind)).toEqual([1, 2]);
    expect(JSON.parse(frames[0].payload.toString())).toEqual({ message: "爱丽丝" });
    expect([...frames[1].payload]).toEqual([0, 255]);
  });

  test("rejects invalid protocol headers and oversized declarations before buffering bodies", () => {
    expect(() => new PipeFrameDecoder().feed(Buffer.alloc(10))).toThrow("header");
    const bytes = encodePipeFrame(1, Buffer.alloc(0));
    bytes.writeUInt32LE(PIPE_MAX_PAYLOAD_BYTES + 1, 6);
    expect(() => new PipeFrameDecoder().feed(bytes)).toThrow("64 MiB");
  });
});

describe("BaasClient service contract", () => {
  test("reads profiles, task descriptors, status and filtered logs over real sockets", async () => {
    const { client } = await fixture();
    expect(await client.profiles()).toEqual({ alpha: "Arona" });
    expect(await client.config("alpha")).toMatchObject({ server: "Global" });
    expect(await client.tasks("alpha")).toEqual({
      arena: { func_name: "arena", event_name: "Arena", enabled: true },
    });
    expect(await client.status()).toEqual({ alpha: { running: false } });
    expect((await client.logs(20, "alpha")).map((entry) => entry.message)).toEqual(["Ready"]);
  });

  test("correlates concurrent command responses even when the backend reverses their order", async () => {
    const { client, received } = await fixture();
    const responses = await Promise.all([
      client.request("reorder", "alpha", { index: 1 }),
      client.request("reorder", "alpha", { index: 2 }),
    ]);
    expect(responses).toEqual([{ index: 1 }, { index: 2 }]);
    const commands = received.filter((message) => message.command === "reorder");
    expect(commands[0].timestamp).not.toBe(commands[1].timestamp);
    await expect(client.request("fail")).rejects.toBeInstanceOf(BaasCommandError);
  });

  test("writes patches only after a snapshot and awaits an acknowledgement", async () => {
    const { client, config, received } = await fixture();
    expect(await client.patchConfig("alpha", "autostart", true)).toMatchObject({ autostart: true });
    expect(config.autostart).toBe(true);
    const patch = received.find((message) => message.type === "patch")!;
    expect(patch.ops).toEqual([{ op: "replace", path: "/autostart", value: true }]);
    expect(received.findIndex((message) => message.type === "pull")).toBeLessThan(
      received.indexOf(patch)
    );
  });

  test("surfaces conflicts without overwriting a newer backend configuration", async () => {
    const { client, received } = await fixture({ conflict: true });
    await expect(client.patchConfig("alpha", "autostart", true)).rejects.toBeInstanceOf(
      BaasConflictError
    );
    expect(received.filter((message) => message.type === "patch")).toHaveLength(1);
  });

  test("publishes live logs and removes subscriptions", async () => {
    const { client, push } = await fixture();
    await client.connect();
    const entries: string[] = [];
    const stop = client.onLog((entry) => entries.push(entry.message));
    push({
      type: "log",
      entry: { scope: "config:alpha", level: "INFO", time: "now", message: "Working" },
    });
    await client.logs();
    expect(entries).toEqual(["Working"]);
    stop();
    push({
      type: "log",
      entry: { scope: "config:alpha", level: "INFO", time: "now", message: "Done" },
    });
    await client.logs();
    expect(entries).toEqual(["Working"]);
  });

  test("normalizes full and nested delta status, isolates subscribers, and rejects stale updates", async () => {
    const { client, push } = await fixture();
    const observations: string[] = [];
    const isolatedValues: unknown[] = [];
    client.onStatus((update, snapshot) => {
      observations.push(`first:${update.full}:${snapshot.alpha?.run_id ?? "none"}`);
      if (snapshot.alpha) snapshot.alpha.running = "corrupted";
      update.status.running = "corrupted";
    });
    client.onStatus((update, snapshot) => {
      observations.push(`second:${update.full}:${snapshot.alpha?.run_id ?? "none"}`);
      isolatedValues.push(snapshot.alpha?.running, update.status.running);
    });
    await client.connect();
    await client.logs();
    const before = observations.length;
    push({
      type: "status",
      status: { config_id: "alpha", status: { run_id: "run-1", running: true, timestamp: 20 } },
    });
    await client.logs();
    expect(observations.slice(before, before + 2)).toEqual([
      "first:false:run-1",
      "second:false:run-1",
    ]);
    const cached = client.statusSnapshot;
    cached.alpha.run_id = "mutated";
    expect(client.statusSnapshot.alpha.run_id).toBe("run-1");
    expect(isolatedValues).not.toContain("corrupted");
    const deltaCount = observations.filter((item) => item.startsWith("first:false")).length;
    push({
      type: "status",
      status: { config_id: "alpha", status: { run_id: "old-run", running: false, timestamp: 19 } },
    });
    push({ type: "status", status: { is_all_data_initialized: true } });
    await client.logs();
    expect(client.statusSnapshot.alpha.run_id).toBe("run-1");
    expect(observations.filter((item) => item.startsWith("first:false"))).toHaveLength(deltaCount);
  });

  test("emits one disconnect, reconnects queries, and never replays an interrupted mutation", async () => {
    const { client, received, drop, waitForCommand } = await fixture({ stall: true });
    await client.connect();
    const disconnected = new Promise<void>((resolve) => {
      const off = client.onDisconnect(() => {
        off();
        resolve();
      });
    });
    let notifications = 0;
    client.onDisconnect(() => {
      notifications += 1;
    });
    const mutation = client.request("start_scheduler", "alpha");
    // A query/command frame must reach the peer before the connection is dropped.
    await waitForCommand("start_scheduler");
    drop();
    await disconnected;
    await expect(mutation).rejects.toThrow("disconnected");
    expect(notifications).toBe(1);
    expect(await client.profiles()).toEqual({ alpha: "Arona" });
    expect(received.filter((message) => message.command === "start_scheduler")).toHaveLength(1);
    client.close();
    client.close();
    expect(notifications).toBe(2);
  });

  test("preserves approval-time values and exact backend baseline when patching", async () => {
    const { client, config, received } = await fixture();
    const previous = (await client.config("alpha")).name;
    config.name = "Changed by another client";
    await expect(
      client.patchConfig("alpha", "/name", "New name", {
        checkExpected: true,
        expectedValue: previous,
      })
    ).rejects.toBeInstanceOf(BaasConflictError);
    expect(received.filter((message) => message.type === "patch")).toHaveLength(0);
    await client.patchConfig("alpha", "/autostart", true, {
      checkExpected: true,
      expectedValue: false,
    });
    const patch = received.find((message) => message.type === "patch")!;
    expect(patch.timestamp).toBe(42.5);
    expect(config.autostart).toBe(true);
  });

  test("closing a client rejects an in-flight pipe handshake", async () => {
    const { client } = await fixture({ openStall: true });
    const opening = client.connect();
    client.close();
    await expect(opening).rejects.toThrow("closed");
  });

  test("times out unacknowledged commands and rejects pending calls on close", async () => {
    const { client } = await fixture({ stall: true });
    await expect(client.request("never")).rejects.toThrow("Timed out");
    const pending = client.request("pending");
    await new Promise((resolve) => setImmediate(resolve));
    client.close();
    await expect(pending).rejects.toThrow("closed");
  });
});
