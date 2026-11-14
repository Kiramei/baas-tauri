import { describe, expect, test } from "bun:test";
import {
  SystemNotificationDispatcher,
  type SystemNotificationPayload,
  type SystemNotificationRequest,
} from "../../src/shared/SystemNotificationPolicy";

function fixture() {
  const state = { enabled: true, background: true, now: 1000 };
  const sent: SystemNotificationPayload[] = [];
  const dispatcher = new SystemNotificationDispatcher({
    enabled: () => state.enabled,
    isBackground: async () => state.background,
    send: async (payload) => {
      sent.push(payload);
    },
    summarize: (latest, count) => `${count}: ${latest}`,
    now: () => state.now,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  return { state, sent, dispatcher };
}
const event = (id: string, kind = "completed"): SystemNotificationRequest => ({
  key: `run:${id}:${kind}`,
  runKey: `run:${id}`,
  terminal: kind !== "started",
  group: `script:${kind}`,
  payload: { title: kind, body: id, tag: `script:${id}:${kind}` },
});

describe("background-only delivery", () => {
  test("events received in the foreground are consumed rather than deferred", async () => {
    const { state, sent, dispatcher } = fixture();
    state.background = false;
    await dispatcher.enqueue(event("foreground"));
    state.background = true;
    await dispatcher.flush();
    expect(sent).toEqual([]);
    await dispatcher.enqueue(event("foreground"));
    await dispatcher.flush();
    expect(sent).toEqual([]);
    await dispatcher.enqueue(event("new-background-event"));
    await dispatcher.flush();
    expect(sent).toHaveLength(1);
  });

  test("returning to the foreground or disabling the existing switch cancels pending toasts", async () => {
    for (const option of ["background", "enabled"] as const) {
      const { state, sent, dispatcher } = fixture();
      await dispatcher.enqueue(event(option));
      state[option] = false;
      await dispatcher.flush();
      state[option] = true;
      await dispatcher.flush();
      expect(sent).toEqual([]);
    }
  });

  test("a reset while the native focus query is pending cannot leak an old generation", async () => {
    let resolve!: (value: boolean) => void;
    const sent: unknown[] = [];
    const dispatcher = new SystemNotificationDispatcher({
      enabled: () => true,
      isBackground: () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
      send: async (payload) => {
        sent.push(payload);
      },
      summarize: (latest) => latest,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    const pending = dispatcher.enqueue(event("old"));
    dispatcher.clear();
    resolve(true);
    await pending;
    expect(sent).toEqual([]);
  });

  test("wake-up timers discard events queued before suspension", async () => {
    const { state, sent, dispatcher } = fixture();
    await dispatcher.enqueue(event("before-sleep"));
    state.now += 60_000;
    await dispatcher.flush();
    expect(sent).toEqual([]);
  });

  test("a focus query started before sleep cannot refresh an old event on resume", async () => {
    let now = 1000;
    let resolve!: (value: boolean) => void;
    const sent: unknown[] = [];
    const dispatcher = new SystemNotificationDispatcher({
      enabled: () => true,
      isBackground: () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
      send: async (payload) => {
        sent.push(payload);
      },
      summarize: (latest) => latest,
      now: () => now,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    const pending = dispatcher.enqueue(event("pre-sleep"));
    now += 60_000;
    resolve(true);
    await pending;
    expect(sent).toEqual([]);
    // A non-expired enqueue would have scheduled a batch; the dependency's
    // next focus query would otherwise leave this flush unresolved.
    const flushing = dispatcher.flush();
    resolve(true);
    await flushing;
    expect(sent).toEqual([]);
  });

  test("a second focus query cannot send a batch that expired during its await", async () => {
    let now = 1000;
    let calls = 0;
    let resolve!: (value: boolean) => void;
    const sent: unknown[] = [];
    const dispatcher = new SystemNotificationDispatcher({
      enabled: () => true,
      isBackground: () =>
        ++calls < 3
          ? Promise.resolve(true)
          : new Promise<boolean>((done) => {
              resolve = done;
            }),
      send: async (payload) => {
        sent.push(payload);
      },
      summarize: (latest) => latest,
      now: () => now,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await dispatcher.enqueue(event("pre-sleep"));
    const flushing = dispatcher.flush();
    await Promise.resolve();
    now += 60_000;
    resolve(true);
    await flushing;
    expect(sent).toEqual([]);
  });
});

describe("bounded notification batches", () => {
  test("thirty new completions become one summary instead of thirty system toasts", async () => {
    const { sent, dispatcher } = fixture();
    await Promise.all(Array.from({ length: 30 }, (_, id) => dispatcher.enqueue(event(String(id)))));
    await dispatcher.flush();
    expect(sent).toEqual([{ title: "completed", body: "30: 29", tag: "script:batch:completed" }]);
  });

  test("fast completions supersede pending starts, while failures stay separate", async () => {
    const { sent, dispatcher } = fixture();
    await dispatcher.enqueue(event("one", "started"));
    await dispatcher.enqueue(event("one"));
    await dispatcher.enqueue(event("two", "failed"));
    await dispatcher.flush();
    expect(sent.map((payload) => payload.title)).toEqual(["failed", "completed"]);
    expect(sent[0].tag).not.toBe(sent[1].tag);
  });

  test("new events during cooldown are combined and later delivered", async () => {
    const { state, sent, dispatcher } = fixture();
    await dispatcher.enqueue(event("first"));
    await dispatcher.flush();
    await dispatcher.enqueue(event("second"));
    await dispatcher.enqueue(event("third"));
    await dispatcher.flush();
    expect(sent).toHaveLength(1);
    state.now += 3000;
    await dispatcher.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toBe("2: third");
  });

  test("one disconnect storm emits once, and a later genuine outage can notify", async () => {
    const { state, sent, dispatcher } = fixture();
    const outage = {
      key: "service:pipe",
      group: "service:pipe",
      cooldownMs: 30_000,
      payload: { title: "outage", body: "pipe", tag: "service:disconnected:pipe" },
    };
    for (let index = 0; index < 20; index++) await dispatcher.enqueue(outage);
    await dispatcher.flush();
    expect(sent).toHaveLength(1);
    state.now += 30_001;
    await dispatcher.enqueue(outage);
    await dispatcher.flush();
    expect(sent).toHaveLength(2);
  });
});
