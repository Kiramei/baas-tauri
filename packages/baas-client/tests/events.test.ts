import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BaasClient, BaasConflictError } from "../src";
import { encodePipeFrame, PipeFrameDecoder } from "../src/pipe";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "baas-events-"));
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\events-${process.pid}-${Date.now()}`
      : join(root, "sync.sock");
  const events = [
    { func_name: "alpha", event_name: "Alpha", enabled: true, priority: 1, pre_task: [] },
    { func_name: "beta", event_name: "Beta", enabled: false, priority: 2, pre_task: [] },
  ];
  let timestamp = 1000;
  let conflict = false;
  const received: Record<string, any>[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = new PipeFrameDecoder();
    const send = (value: unknown) =>
      socket.write(encodePipeFrame(1, Buffer.from(JSON.stringify(value))));
    socket.on("data", (data) => {
      for (const frame of decoder.feed(data)) {
        const message = JSON.parse(frame.payload.toString("utf8"));
        received.push(message);
        if (message.type === "open") send({ type: "open_ok", channel: message.channel });
        else if (message.type === "pull" && message.resource === "static")
          send({
            type: "snapshot",
            resource: "static",
            timestamp,
            data: { student_names: [{ CN_name: "爱丽丝" }] },
          });
        else if (message.type === "pull")
          send({
            type: "snapshot",
            resource: "event",
            resource_id: "main",
            timestamp,
            data: events,
          });
        else if (message.type === "patch") {
          if (conflict || message.timestamp !== timestamp) {
            send({
              type: "patch_conflict",
              resource: "event",
              resource_id: "main",
              request_timestamp: message.timestamp,
              timestamp: timestamp + 1,
              data: events,
            });
            continue;
          }
          for (const operation of message.ops) {
            const [, index, key] = operation.path.split("/");
            events[Number(index)][key.replace(/~1/g, "/").replace(/~0/g, "~")] = operation.value;
          }
          timestamp++;
          send({
            type: "patch_ack",
            resource: "event",
            resource_id: "main",
            timestamp: message.timestamp,
          });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  const client = new BaasClient({ pipe, timeoutMs: 1000 });
  cleanup.push(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    client,
    received,
    get events() {
      return events;
    },
    change(mutator: (events: typeof events) => void) {
      mutator(events);
      timestamp++;
    },
    reorder() {
      events.reverse();
      timestamp++;
    },
    conflict() {
      conflict = true;
    },
  };
}

describe("scheduler event compare-and-set", () => {
  test("static catalogs use the actual singleton resource without a profile ID", async () => {
    const target = await fixture();
    const data = await target.client.staticData();
    expect(data).toEqual({ student_names: [{ CN_name: "爱丽丝" }] });
    (data.student_names as Record<string, string>[])[0].CN_name = "changed";
    expect(await target.client.staticData()).toEqual({ student_names: [{ CN_name: "爱丽丝" }] });
    expect(target.received.filter((message) => message.type === "pull")).toEqual([
      { type: "pull", resource: "static" },
      { type: "pull", resource: "static" },
    ]);
  });
  test("reads array order and locates edits by task ID in a fresh reordered snapshot", async () => {
    const target = await fixture();
    const read = await target.client.events("main");
    read[0].enabled = false;
    expect(target.events[0].enabled).toBe(true);
    target.reorder();
    const saved = await target.client.patchEvents("main", [
      { func_name: "alpha", fields: { enabled: false }, expected: { enabled: true } },
    ]);
    expect(saved.find((task) => task.func_name === "alpha")?.enabled).toBe(false);
    expect(target.received.find((message) => message.type === "patch")).toMatchObject({
      resource: "event",
      resource_id: "main",
      timestamp: 1001,
      ops: [{ op: "replace", path: "/1/enabled", value: false }],
    });
  });
  test("a same-field approval race rejects before sending any patch", async () => {
    const target = await fixture();
    await target.client.events("main");
    target.change((events) => {
      events[0].enabled = false;
    });
    await expect(
      target.client.patchEvents("main", [
        { func_name: "alpha", fields: { enabled: false }, expected: { enabled: true } },
      ])
    ).rejects.toBeInstanceOf(BaasConflictError);
    expect(target.received.filter((message) => message.type === "patch")).toHaveLength(0);
  });
  test("unrelated changes survive a field-level edit and batch updates use one atomic patch", async () => {
    const target = await fixture();
    target.change((events) => {
      events[0].priority = 99;
    });
    const saved = await target.client.patchEvents("main", [
      { func_name: "alpha", fields: { enabled: false }, expected: { enabled: true } },
      { func_name: "beta", fields: { enabled: true }, expected: { enabled: false } },
    ]);
    expect(saved[0]).toMatchObject({ priority: 99, enabled: false });
    expect(saved[1].enabled).toBe(true);
    expect(target.received.filter((message) => message.type === "patch")).toHaveLength(1);
    expect(target.received.find((message) => message.type === "patch")?.ops).toHaveLength(2);
  });
  test("backend CAS conflicts are surfaced without retries", async () => {
    const target = await fixture();
    target.conflict();
    await expect(
      target.client.patchEvents("main", [{ func_name: "alpha", fields: { enabled: false } }])
    ).rejects.toBeInstanceOf(BaasConflictError);
    expect(target.received.filter((message) => message.type === "patch")).toHaveLength(1);
    expect(target.events[0].enabled).toBe(true);
  });
  test("removed tasks and malformed batch identities never partially update other tasks", async () => {
    const target = await fixture();
    await expect(
      target.client.patchEvents("main", [
        { func_name: "alpha", fields: { enabled: false } },
        { func_name: "removed", fields: { enabled: true } },
      ])
    ).rejects.toBeInstanceOf(BaasConflictError);
    await expect(
      target.client.patchEvents("main", [{ func_name: "alpha", fields: { func_name: "renamed" } }])
    ).rejects.toThrow("immutable");
    await expect(
      target.client.patchEvents("main", [
        { func_name: "alpha", fields: { enabled: false } },
        { func_name: "alpha", fields: { priority: 3 } },
      ])
    ).rejects.toThrow("Invalid scheduler changes");
    expect(target.received.filter((message) => message.type === "patch")).toHaveLength(0);
    expect(target.events[0].enabled).toBe(true);
  });
  test("a relationship target removed after approval cannot leave a dangling reference", async () => {
    const target = await fixture();
    await target.client.events("main");
    target.change((events) => events.splice(1, 1));
    await expect(
      target.client.patchEvents("main", [
        { func_name: "alpha", fields: { pre_task: ["beta"] }, expected: { pre_task: [] } },
      ])
    ).rejects.toBeInstanceOf(BaasConflictError);
    expect(target.received.filter((message) => message.type === "patch")).toHaveLength(0);
    expect(target.events[0].pre_task).toEqual([]);
  });
});
