import assert from "node:assert/strict";
import { mock } from "bun:test";

Object.assign(globalThis, {
  __WITH_TAURI__: false,
  __WITH_ANDROID__: false,
  __WITH_WEBUI__: true,
});

async function storageScenario() {
  const values = new Map<string, string>();
  let storageFailure: Error | undefined;
  const focusListeners = new Set<() => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 1;
  const runTimers = (delay: number) => {
    for (const [id, timer] of timers) {
      if (timer.delay !== delay) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  const children = new Set<any>();
  const elements: any[] = [];
  let pickerSupportsCancel = true;
  let click: (element: any) => void = () => {};
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (storageFailure) throw storageFailure;
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    },
    window: {
      addEventListener: (name: string, listener: () => void) => {
        if (name === "focus") focusListeners.add(listener);
      },
      removeEventListener: (name: string, listener: () => void) => {
        if (name === "focus") focusListeners.delete(listener);
      },
    },
    document: {
      body: { appendChild: (element: any) => children.add(element) },
      createElement: (tag: string) => {
        const element: any = {
          tag,
          style: {},
          files: [],
          click: () => {
            assert.ok(children.has(element), "picker/download must be attached during activation");
            click(element);
          },
          remove: () => children.delete(element),
        };
        if (tag === "input" && pickerSupportsCancel) element.oncancel = null;
        elements.push(element);
        return element;
      },
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  URL.createObjectURL = (blob) => {
    const url = `blob:fixture/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  const { default: storage } = await import("../../../src/shared/StorageManager");
  const translate = ((key: string) => key) as any;

  const originalPreferences = { theme: "dark", lang: "zh", zoomScale: 110 };
  assert.equal(storage.trySet("uiSettings", originalPreferences), true);
  storageFailure = new DOMException("storage full", "QuotaExceededError");
  assert.equal(storage.trySet("uiSettings", { theme: "light", background: "large" }), false);
  assert.deepEqual(storage.get("uiSettings"), originalPreferences);
  await assert.rejects(storage.setDurable("uiSettings", { theme: "light" }), storageFailure);
  assert.deepEqual(storage.get("uiSettings"), originalPreferences);
  storageFailure = undefined;
  await storage.setDurable("uiSettings", { ...originalPreferences, zoomScale: 120 });
  assert.equal(storage.get("uiSettings").zoomScale, 120);

  const zip = new Uint8Array([80, 75, 3, 4, 0, 255, 0, 128]);
  const padded = new Uint8Array([99, ...zip, 98]);
  let downloads = 0;
  click = (anchor) => {
    assert.equal(anchor.tag, "a");
    assert.equal(anchor.download, "日常配置.zip");
    assert.ok(blobs.has(anchor.href));
    assert.ok(!revoked.includes(anchor.href), "URL must survive the download navigation");
    downloads++;
  };
  for (const data of [zip.buffer, padded.subarray(1, -1), new Blob([zip])]) {
    await storage.download("日常配置.zip", data, translate);
    assert.deepEqual(new Uint8Array(await [...blobs.values()].at(-1)!.arrayBuffer()), zip);
    assert.equal(children.size, 0);
  }
  assert.equal(downloads, 3);
  assert.equal(revoked.length, 0);
  runTimers(60_000);
  assert.equal(revoked.length, 3);
  await storage.download("no-data.zip", null, translate);
  assert.equal(downloads, 3);
  const blocked = new Error("download blocked");
  click = () => {
    throw blocked;
  };
  await assert.rejects(storage.download("blocked.zip", zip, translate), blocked);
  assert.equal(children.size, 0);
  assert.equal(revoked.length, 4, "failed navigation releases its URL immediately");

  click = (input) => {
    assert.equal(input.accept, ".zip");
    input.files = [{ arrayBuffer: async () => zip.buffer }];
    void input.onchange();
  };
  assert.deepEqual(await storage.upload(translate, ".zip"), zip);
  assert.equal(children.size, 0);
  assert.equal(focusListeners.size, 0);
  click = (input) => input.oncancel();
  assert.equal(await storage.upload(translate), null);
  assert.equal(children.size, 0);
  const unreadable = new Error("file read failed");
  click = (input) => {
    input.files = [
      {
        arrayBuffer: async () => {
          throw unreadable;
        },
      },
    ];
    void input.onchange();
  };
  await assert.rejects(storage.upload(translate), unreadable);
  assert.equal(children.size, 0);
  assert.equal(focusListeners.size, 0);
  click = () => {
    throw blocked;
  };
  await assert.rejects(storage.upload(translate), blocked);
  assert.equal(children.size, 0);

  pickerSupportsCancel = false;
  click = () => {
    for (const listener of focusListeners) listener();
  };
  const cancelled = storage.upload(translate);
  runTimers(500);
  assert.equal(await cancelled, null);
  assert.equal(focusListeners.size, 0);
  assert.equal(children.size, 0);
  assert.equal(timers.size, 0);
}

async function logsScenario() {
  let requests = 0;
  mock.module("@/store/WebsocketStore", () => ({
    resolveHttpBase: () => {
      throw new Error("WebUI must not resolve a protected diagnostics URL");
    },
  }));
  Object.assign(globalThis, {
    fetch: () => {
      requests++;
      throw new Error("unexpected diagnostic request");
    },
  });
  const { recordFrontendSystemLog, collectSystemLogs, clearSystemLogs } =
    await import("../../../src/shared/SystemLogService");
  recordFrontendSystemLog("INFO", "browser", "page opened", { source: "fixture" });
  recordFrontendSystemLog("WARNING", "browser", "network interrupted");
  const before = await collectSystemLogs();
  assert.deepEqual(
    before.entries.map(({ message }) => message),
    ["page opened", "network interrupted"]
  );
  assert.ok(before.entries.every(({ source }) => source === "frontend"));
  assert.deepEqual(before.errors, []);
  assert.deepEqual(before.pythonFiles, []);
  await clearSystemLogs();
  const after = await collectSystemLogs();
  assert.ok(
    after.entries.every(({ message }) => !["page opened", "network interrupted"].includes(message))
  );
  assert.equal(requests, 0, "viewing and clearing browser diagnostics cannot access server logs");
}

async function clipboardScenario() {
  let clipboard: any;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      get clipboard() {
        return clipboard;
      },
    },
  });
  const children = new Set<any>();
  const original = {
    focus: () => {
      documentState.activeElement = original;
    },
  };
  const range = { id: "original-selection" };
  const restored: unknown[] = [];
  let copied = "";
  let copyResult = true;
  let throwOnCopy = false;
  const documentState: any = {
    activeElement: original,
    body: { appendChild: (element: any) => children.add(element) },
    createElement: () => {
      const element: any = {
        style: {},
        setAttribute: () => {},
        focus: () => {
          documentState.activeElement = element;
        },
        select: () => {
          copied = element.value;
        },
        remove: () => children.delete(element),
      };
      return element;
    },
    execCommand: (command: string) => {
      assert.equal(command, "copy");
      if (throwOnCopy) throw new Error("permission denied");
      return copyResult;
    },
  };
  Object.assign(globalThis, {
    document: documentState,
    window: {
      getSelection: () => ({
        rangeCount: 1,
        getRangeAt: () => ({ cloneRange: () => range }),
        removeAllRanges: () => {
          restored.length = 0;
        },
        addRange: (value: unknown) => restored.push(value),
      }),
    },
  });
  const { copyBrowserText } = await import("../../../src/shared/BrowserClipboard");
  clipboard = {
    writeText: async (text: string) => {
      copied = text;
    },
  };
  assert.equal(await copyBrowserText("modern clipboard"), true);
  assert.equal(copied, "modern clipboard");
  assert.equal(children.size, 0);
  clipboard = undefined;
  assert.equal(await copyBrowserText("HTTP 浏览器日志"), true);
  assert.equal(copied, "HTTP 浏览器日志");
  assert.equal(documentState.activeElement, original);
  assert.deepEqual(restored, [range]);
  assert.equal(children.size, 0);
  clipboard = {
    writeText: async () => {
      throw new Error("clipboard denied");
    },
  };
  assert.equal(await copyBrowserText("fallback after denial"), true);
  assert.equal(copied, "fallback after denial");
  copyResult = false;
  assert.equal(await copyBrowserText("cannot copy"), false);
  throwOnCopy = true;
  assert.equal(await copyBrowserText("cannot copy"), false);
  assert.equal(children.size, 0);
  assert.equal(documentState.activeElement, original);
}

async function localeScenario() {
  const preferences = { lang: "ja" };
  mock.module("@/shared/StorageManager.ts", () => ({
    default: { init: async () => {}, get: () => preferences },
  }));
  const paths: string[] = [];
  Object.assign(globalThis, {
    fetch: async (path: string) => {
      paths.push(path);
      if (path.endsWith("/zh.json")) return Response.json({ app: { close: "关闭" } });
      if (path.endsWith("/ko.json")) return Response.json({});
      return new Response("missing", { status: 404 });
    },
  });
  const {
    default: i18n,
    initI18n,
    loadLocale,
  } = await import("../../../src/shared/I18nTranslator");
  await initI18n();
  assert.equal(i18n.language, "en", "missing saved language falls back to bundled English");
  assert.equal(i18n.t("app.close"), "Close");
  assert.equal(await loadLocale("zh"), true);
  assert.equal(i18n.language, "zh");
  assert.equal(i18n.t("app.close"), "关闭");
  assert.notEqual(i18n.t("app.minimize"), "app.minimize", "partial locale falls back to English");
  assert.equal(await loadLocale("ja"), false);
  assert.equal(i18n.language, "zh", "failed switching preserves the currently active language");
  assert.equal(await loadLocale("ko"), false);
  const previousRequests = paths.length;
  assert.equal(await loadLocale("../../private"), false);
  assert.equal(paths.length, previousRequests);
  assert.equal(await loadLocale("en"), true);
  assert.equal(i18n.language, "en");
  assert.equal(
    paths.length,
    previousRequests,
    "bundled English does not depend on a locale HTTP request"
  );
}

async function authRetryScenario() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  Object.assign(globalThis, {
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextId++;
      pending.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => pending.delete(id),
  });
  const tick = (duration: number) => {
    now += duration;
    for (const [id, timer] of pending) {
      if (timer.at > now) continue;
      pending.delete(id);
      timer.callback();
    }
  };
  const { createStartupAuthRetry } = await import("../../../src/shared/StartupAuthRetry");
  const retry = createStartupAuthRetry(true);
  const connectedAt: number[] = [];
  const connect = () => connectedAt.push(now);
  const cancelledMount = retry.schedule(connect);
  cancelledMount();
  retry.schedule(connect);
  tick(0);
  assert.deepEqual(connectedAt, [0], "StrictMode cleanup must not delay the first real attempt");
  for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
    const before = connectedAt.length;
    retry.schedule(connect);
    tick(delay - 1);
    assert.equal(connectedAt.length, before, "failed startup cannot reconnect before its delay");
    tick(1);
    assert.equal(connectedAt.length, before + 1);
  }
  const cancelRetry = retry.schedule(connect);
  cancelRetry();
  tick(15_000);
  assert.equal(connectedAt.length, 7, "leaving the loading state cancels its pending retry");
  retry.reset();
  retry.schedule(connect);
  const beforeReset = connectedAt.length;
  tick(0);
  assert.equal(connectedAt.length, beforeReset + 1, "successful connection resets the delay");

  const native = createStartupAuthRetry(false);
  let nativeConnections = 0;
  for (let index = 0; index < 3; index++) {
    native.schedule(() => nativeConnections++);
    tick(0);
    assert.equal(nativeConnections, index + 1, "native startup retains immediate retry behavior");
  }
}

const scenarios: Record<string, () => Promise<void>> = {
  storage: storageScenario,
  logs: logsScenario,
  clipboard: clipboardScenario,
  locale: localeScenario,
  "auth-retry": authRetryScenario,
};
const scenario = process.argv[2];
assert.ok(scenarios[scenario], `unknown scenario: ${scenario}`);
await scenarios[scenario]();
console.log(`WebUI ${scenario} behavior passed`);
