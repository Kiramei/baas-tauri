import { describe, expect, test } from "bun:test";
import {
  createPluginRequestId,
  pluginDefaults,
  pluginText,
  requestPluginCommand,
  validatePluginValue,
  type PluginSchema,
} from "../../src/shared/Plugins";

function transport() {
  let callback!: (response: unknown) => void;
  const calls: unknown[] = [];
  const binaries: Uint8Array[] = [];
  const state: any = {
    transportMode: "websocket",
    _auth_phase: "authenticated",
    _session: { sessionId: "initial" },
    connections: { trigger: { readyState: 1 } },
    pendingCallbacks: {},
    trigger(request: unknown, listener: typeof callback) {
      calls.push(request);
      callback = listener;
      state.pendingCallbacks[42] = listener;
      return 42;
    },
    triggerBinary(request: unknown, bytes: Uint8Array, listener: typeof callback) {
      binaries.push(bytes);
      return state.trigger(request, listener);
    },
  };
  return { state, calls, binaries, reply: (value: unknown) => callback(value) };
}

describe("plugin authenticated command boundary", () => {
  test("HTTP WebUI can create a v4 request UUID without the secure-context randomUUID API", () => {
    const id = createPluginRequestId({
      getRandomValues: (array) => {
        (array as Uint8Array).fill(0);
        return array;
      },
    });
    expect(id).toBe("00000000-0000-4000-8000-000000000000");
    expect(createPluginRequestId()).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
    );
  });
  test("configuration identifiers and settings revisions stay in command payloads", async () => {
    const fixture = transport();
    const pending = requestPluginCommand(
      () => fixture.state,
      "update_plugin_settings",
      "official",
      { plugin_id: "example.tools", revision: 3, values: { count: 4 } }
    );
    expect(fixture.calls[0]).toMatchObject({
      command: "update_plugin_settings",
      config_id: "official",
      payload: { plugin_id: "example.tools", revision: 3, values: { count: 4 } },
    });
    fixture.reply({ status: "ok", data: { revision: 4 } });
    expect(await pending).toEqual({ revision: 4 });
    expect(fixture.state.pendingCallbacks[42]).toBeUndefined();
  });
  test("catalog browsing and binary installation do not require a selected profile", async () => {
    const fixture = transport();
    const bytes = new Uint8Array([80, 75, 3, 4]);
    const pending = requestPluginCommand(
      () => fixture.state,
      "install_plugin",
      undefined,
      { filename: "plugin.zip" },
      bytes
    );
    expect(fixture.calls[0]).not.toHaveProperty("config_id");
    expect(fixture.binaries[0]).toBe(bytes);
    fixture.reply({ status: "ok", data: { installed: true } });
    expect(await pending).toEqual({ installed: true });
  });
  test("never sends plugin commands on unverified or disconnected sessions", async () => {
    for (const change of [
      (state: any) => {
        state._auth_phase = "challenge";
      },
      (state: any) => {
        state._session = null;
      },
      (state: any) => {
        state.connections.trigger.readyState = 3;
      },
    ]) {
      const fixture = transport();
      change(fixture.state);
      await expect(
        requestPluginCommand(() => fixture.state, "get_plugin_catalog")
      ).rejects.toMatchObject({ code: "connection_unavailable" });
      expect(fixture.calls).toHaveLength(0);
    }
  });
  test("late replies from a replaced authentication session cannot update settings", async () => {
    const fixture = transport();
    const pending = requestPluginCommand(() => fixture.state, "get_plugin_settings", "one");
    fixture.state._session.sessionId = "replacement";
    fixture.reply({ status: "ok", data: {} });
    await expect(pending).rejects.toMatchObject({ code: "session_changed" });
  });
  test("native pipe and shared-memory transports send catalog and binary commands without a WebSocket session", async () => {
    for (const transportMode of ["pipe", "shm"]) {
      const fixture = transport();
      fixture.state.transportMode = transportMode;
      fixture.state._session = null;
      const catalog = requestPluginCommand(() => fixture.state, "get_plugin_catalog");
      fixture.reply({ status: "ok", data: { api_version: 1, plugins: [] } });
      expect(await catalog).toEqual({ api_version: 1, plugins: [] });
      const bytes = new Uint8Array([80, 75, 3, 4]);
      const installed = requestPluginCommand(
        () => fixture.state,
        "install_plugin",
        undefined,
        { filename: "plugin.zip" },
        bytes
      );
      expect(fixture.binaries[0]).toBe(bytes);
      fixture.reply({ status: "ok", data: { installed: true } });
      expect(await installed).toEqual({ installed: true });
      expect(fixture.state.pendingCallbacks[42]).toBeUndefined();
    }
  });
  test("native commands still require an authenticated open command connection", async () => {
    for (const transportMode of ["pipe", "shm"]) {
      for (const change of [
        (state: any) => {
          state._auth_phase = "idle";
        },
        (state: any) => {
          state.connections.trigger.readyState = 3;
        },
        (state: any) => {
          delete state.connections.trigger;
        },
      ]) {
        const fixture = transport();
        fixture.state.transportMode = transportMode;
        fixture.state._session = null;
        change(fixture.state);
        await expect(
          requestPluginCommand(() => fixture.state, "get_plugin_catalog")
        ).rejects.toMatchObject({ code: "connection_unavailable" });
        expect(fixture.calls).toHaveLength(0);
      }
    }
  });
  test("native replies from a replaced, closed or differently configured connection cannot update plugin state", async () => {
    for (const transportMode of ["pipe", "shm"]) {
      for (const change of [
        (state: any) => {
          state.connections.trigger = { readyState: 1 };
        },
        (state: any) => {
          state.connections.trigger.readyState = 3;
        },
        (state: any) => {
          state.transportMode = transportMode === "pipe" ? "shm" : "pipe";
        },
        (state: any) => {
          state._auth_phase = "idle";
        },
      ]) {
        const fixture = transport();
        fixture.state.transportMode = transportMode;
        fixture.state._session = null;
        const pending = requestPluginCommand(() => fixture.state, "get_plugin_settings", "one");
        change(fixture.state);
        fixture.reply({ status: "ok", data: {} });
        await expect(pending).rejects.toMatchObject({ code: "session_changed" });
      }
    }
  });
  test("WebSocket replies cannot cross replacement command connections within the same session", async () => {
    const fixture = transport();
    const pending = requestPluginCommand(() => fixture.state, "get_plugin_settings", "one");
    fixture.state.connections.trigger = { readyState: 1 };
    fixture.reply({ status: "ok", data: {} });
    await expect(pending).rejects.toMatchObject({ code: "session_changed" });
  });
  test("older backends get a compatibility code and server validation remains actionable", async () => {
    const fixture = transport();
    const unknown = requestPluginCommand(() => fixture.state, "get_plugin_catalog");
    fixture.reply({ status: "error", error: "Unknown command: get_plugin_catalog" });
    await expect(unknown).rejects.toMatchObject({ code: "unsupported" });
    const invalid = requestPluginCommand(() => fixture.state, "update_plugin_settings");
    fixture.reply({
      status: "error",
      code: "revision_conflict",
      error: "Settings were changed elsewhere",
    });
    await expect(invalid).rejects.toMatchObject({
      code: "revision_conflict",
      message: "Settings were changed elsewhere",
    });
  });
  test("timeouts clean only their own callback and ignore later replies", async () => {
    const fixture = transport();
    const unrelated = () => {};
    fixture.state.pendingCallbacks[9] = unrelated;
    const pending = requestPluginCommand(
      () => fixture.state,
      "get_plugin_catalog",
      undefined,
      {},
      undefined,
      5
    );
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(fixture.state.pendingCallbacks[42]).toBeUndefined();
    expect(fixture.state.pendingCallbacks[9]).toBe(unrelated);
    fixture.reply({ status: "ok", data: {} });
  });
});

describe("plugin schema controls", () => {
  const schema: PluginSchema = {
    type: "object",
    additionalProperties: false,
    required: ["count", "enabled", "nested"],
    properties: {
      count: { type: "integer", minimum: 1, maximum: 5 },
      enabled: { type: "boolean" },
      nested: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string", minLength: 2, maxLength: 4, default: "tool" } },
      },
      mode: { type: "string", enum: ["fast", "slow"], default: "slow" },
      optional: { type: "string" },
      rows: { type: "array", minItems: 1, maxItems: 2, items: { type: "integer", minimum: 0 } },
    },
  };
  test("defaults materialize required fields and explicit defaults without injecting absent optional values", () => {
    expect(pluginDefaults(schema)).toEqual({
      count: 1,
      enabled: false,
      nested: { name: "tool" },
      mode: "slow",
    });
    expect(validatePluginValue(schema, pluginDefaults(schema))).toEqual([]);
  });
  test("nested required properties and undeclared settings produce precise paths", () => {
    expect(
      validatePluginValue(schema, { count: 1, enabled: false, nested: {}, extra: true })
    ).toEqual([
      { path: "$.nested.name", reason: "required" },
      { path: "$.extra", reason: "unknown" },
    ]);
  });
  test("numbers are finite integers inside their declared range", () => {
    for (const value of [NaN, Infinity, "2", 1.5])
      expect(validatePluginValue({ type: "integer" }, value)).toMatchObject([{ reason: "type" }]);
    expect(validatePluginValue({ type: "number", minimum: 2 }, 1)).toEqual([
      { path: "$", reason: "minimum", limit: 2 },
    ]);
    expect(validatePluginValue({ type: "number", maximum: 2 }, 3)).toEqual([
      { path: "$", reason: "maximum", limit: 2 },
    ]);
  });
  test("enum values preserve boolean and numeric types", () => {
    expect(validatePluginValue({ type: "integer", enum: [1, 2] }, 2)).toEqual([]);
    expect(validatePluginValue({ type: "integer", enum: [1, 2] }, 3)).toMatchObject([
      { reason: "enum" },
    ]);
    expect(pluginDefaults({ type: "boolean", enum: [true] })).toBe(true);
  });
  test("object enum matching ignores key order and nested array order remains meaningful", () => {
    const object: PluginSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        items: { type: "array", items: { type: "integer" } },
      },
      enum: [{ name: "one", items: [1, 2] }],
    };
    expect(validatePluginValue(object, { items: [1, 2], name: "one" })).toEqual([]);
    expect(validatePluginValue(object, { name: "one", items: [2, 1] })).toMatchObject([
      { reason: "enum" },
    ]);
  });
  test("implicit closed objects and default string/array bounds match backend v1", () => {
    expect(validatePluginValue({ type: "object", properties: {} }, { unexpected: 1 })).toEqual([
      { path: "$.unexpected", reason: "unknown" },
    ]);
    expect(
      validatePluginValue({ type: "array", items: { type: "integer" } }, Array(257).fill(1))
    ).toEqual([{ path: "$", reason: "maxItems", limit: 256 }]);
    expect(validatePluginValue({ type: "string" }, "a".repeat(16385))).toEqual([
      { path: "$", reason: "maxLength", limit: 16384 },
    ]);
    expect(
      validatePluginValue(
        { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        Object.create({ name: "inherited" })
      )
    ).toEqual([{ path: "$.name", reason: "required" }]);
  });
  test("array values enforce item counts and validate individual nested items", () => {
    expect(validatePluginValue(schema.properties!.rows, [])).toEqual([
      { path: "$", reason: "minItems", limit: 1 },
    ]);
    expect(validatePluginValue(schema.properties!.rows, [1, 2, 3])).toMatchObject([
      { reason: "maxItems" },
    ]);
    expect(validatePluginValue(schema.properties!.rows, [1, -1])).toEqual([
      { path: "$[1]", reason: "minimum", limit: 0 },
    ]);
  });
  test("string length counts Unicode codepoints consistently with Python", () => {
    expect(validatePluginValue({ type: "string", maxLength: 1 }, "😀")).toEqual([]);
    expect(validatePluginValue({ type: "string", minLength: 2 }, "😀")).toMatchObject([
      { reason: "minLength" },
    ]);
  });
  test("localized plugin metadata supports exact language, base language and fallback", () => {
    expect(pluginText({ zh: "插件", en: "Plugin" }, "zh-CN")).toBe("插件");
    expect(pluginText({ en: "Plugin" }, "fr")).toBe("Plugin");
    expect(pluginText("Plain", "zh")).toBe("Plain");
    expect(pluginText(undefined, "en")).toBe("");
  });
});
