import { describe, expect, test } from "bun:test";
import { runProfileCommand, waitForProfileConfig } from "../../src/shared/ProfileCommands";

const createStore = () => {
  const requests: any[] = [];
  const sync: any[] = [];
  let nextId = 100;
  const state = {
    connections: { trigger: { readyState: 1 } },
    configStore: {} as Record<string, any>,
    pendingCallbacks: {} as Record<number, (event: any) => void>,
    pendingBinaryCallbacks: {} as Record<number, (binary: ArrayBuffer) => void>,
    send: (_name: string, message: any) => {
      sync.push(message);
    },
    trigger: (request: any, callback: (event: any) => void) => {
      const timestamp = nextId++;
      requests.push({ ...request, timestamp });
      state.pendingCallbacks[timestamp] = callback;
      return timestamp;
    },
    triggerBinary: (
      request: any,
      binary: ArrayBuffer | Uint8Array,
      callback: (event: any) => void
    ) => {
      const timestamp = state.trigger(request, callback);
      requests.at(-1).binary = binary;
      return timestamp;
    },
  };
  const getState = () => state as any;
  const respond = (event: any) => {
    const timestamp = requests.at(-1).timestamp;
    state.pendingCallbacks[timestamp](event);
    delete state.pendingCallbacks[timestamp];
  };
  return { state, getState, requests, sync, respond };
};

describe("profile command completion", () => {
  test("ZIP import forwards bytes and resolves the backend result", async () => {
    const store = createStore();
    const zip = new Uint8Array([80, 75]);
    const result = runProfileCommand(store.getState, "import_config", {}, zip);
    expect(store.requests[0].binary).toBe(zip);
    expect(Number.isSafeInteger(store.requests[0].timestamp)).toBe(true);
    store.respond({ status: "ok", data: { serial: "imported" } });
    expect(await result).toEqual({ serial: "imported" });
  });

  test("backend errors retain their message instead of leaving the editor busy", async () => {
    const store = createStore();
    const result = runProfileCommand(store.getState, "import_config", {}, new Uint8Array());
    store.respond({ status: "error", error: "invalid configuration archive" });
    await expect(result).rejects.toThrow("invalid configuration archive");
    expect(store.state.pendingCallbacks).toEqual({});
  });

  test("a missing ACK times out and cleans up the actual allocated callback ID", async () => {
    const store = createStore();
    await expect(
      runProfileCommand(store.getState, "import_config", {}, new Uint8Array(), 5)
    ).rejects.toThrow("Backend command timed out: import_config");
    expect(store.state.pendingCallbacks).toEqual({});
  });

  test("unavailable command channels fail immediately", async () => {
    const store = createStore();
    store.state.connections.trigger.readyState = 3;
    await expect(
      runProfileCommand(store.getState, "import_config", {}, new Uint8Array())
    ).rejects.toThrow("Backend command channel is unavailable");
    expect(store.requests).toEqual([]);
  });

  test("export keeps the binary response and filename", async () => {
    const store = createStore();
    const result = runProfileCommand(store.getState, "export_config", { id: "saved" });
    const binary = new Uint8Array([80, 75]).buffer;
    const response = { status: "ok", data: { filename: "saved.zip" }, binary };
    store.respond(response);
    expect(await result).toBe(response);
  });

  test("successful imports explicitly refresh the list and the imported snapshots", async () => {
    const store = createStore();
    const result = waitForProfileConfig(store.getState, "imported", 100, 1);
    expect(store.sync).toEqual([
      { type: "list" },
      { type: "pull", resource: "config", resource_id: "imported" },
      { type: "pull", resource: "event", resource_id: "imported" },
    ]);
    const profile = { name: "B服", server: "CN", ap: {}, _pass: {} };
    store.state.configStore.imported = profile;
    expect(await result).toBe(profile);
  });

  test("missing snapshots stop waiting and distinguish saved data from refresh failure", async () => {
    const store = createStore();
    await expect(waitForProfileConfig(store.getState, "imported", 5, 1)).rejects.toThrow(
      "Profile was saved, but refreshing its configuration timed out"
    );
  });

  test("invalid response IDs fail instead of waiting for an undefined profile", async () => {
    const store = createStore();
    await expect(waitForProfileConfig(store.getState, undefined as any, 5, 1)).rejects.toThrow(
      "Missing profile ID in command response"
    );
  });
});
