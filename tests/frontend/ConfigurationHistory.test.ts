import { describe, expect, test } from "bun:test";
import {
  ConfigurationHistory,
  type ConfigurationValues,
} from "../../src/shared/ConfigurationHistory";

function fixture() {
  const writes: { profileId: string; patch: ConfigurationValues }[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const history = new ConfigurationHistory({
    persist: (profileId, patch) => writes.push({ profileId, patch }),
    schedule: (callback) => {
      timers.set(++timerId, callback);
      return timerId;
    },
    cancel: (timer) => timers.delete(timer as number),
  });
  const tick = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
  };
  return { history, writes, timers, tick };
}

describe("configuration autosave history", () => {
  test("registration, source synchronization and no-op edits never write initial values", () => {
    const { history, writes, tick } = fixture();
    const initial = { screenshot_interval: "0.3", autostart: false };
    history.ensure("a", "script", initial);
    history.update("a", "script", { ...initial });
    history.flush("a");
    tick();
    history.syncSource("a", "script", { ...initial, autostart: true });
    expect(writes).toEqual([]);
    expect(history.getDraft("a", "script", initial)).toEqual({ ...initial, autostart: true });
    expect(history.getSnapshot("a").canUndo).toBe(false);
  });

  test("typing coalesces until debounce and persists only modified backend fields", () => {
    const { history, writes, timers, tick } = fixture();
    const initial = { server: "CN", adbPort: "5555" };
    history.ensure("a", "server", initial);
    history.update<typeof initial>("a", "server", (previous) => ({ ...previous, adbPort: "1" }));
    history.update<typeof initial>("a", "server", (previous) => ({ ...previous, adbPort: "12" }));
    history.update<typeof initial>("a", "server", (previous) => ({ ...previous, adbPort: "123" }));
    expect(timers.size).toBe(1);
    expect(writes).toEqual([]);
    expect(history.getSnapshot("a").canUndo).toBe(true);
    tick();
    expect(writes).toEqual([{ profileId: "a", patch: { adbPort: "123" } }]);
    history.undo("a");
    expect(history.getDraft("a", "server", initial)).toEqual(initial);
    expect(writes.at(-1)?.patch).toEqual({ adbPort: "5555" });
    expect(history.getSnapshot("a").canUndo).toBe(false);
    expect(history.getSnapshot("a").canRedo).toBe(true);
  });

  test("undo and redo cross sections in edit order and isolate profiles", () => {
    const { history, writes } = fixture();
    history.ensure("a", "cafe", { collect: false });
    history.ensure("a", "arena", { opponent: 1 });
    history.ensure("b", "cafe", { collect: false });
    history.update("a", "cafe", { collect: true });
    history.update("a", "arena", { opponent: 3 });
    history.flush("a");
    history.update("b", "cafe", { collect: true });
    history.flush("b");
    history.undo("a");
    expect(writes.at(-1)).toEqual({ profileId: "a", patch: { opponent: 1 } });
    history.undo("a");
    expect(writes.at(-1)).toEqual({ profileId: "a", patch: { collect: false } });
    history.redo("a");
    expect(writes.at(-1)).toEqual({ profileId: "a", patch: { collect: true } });
    expect(history.getDraft("b", "cafe", null)).toEqual({ collect: true });
    expect(history.getSnapshot("b").canUndo).toBe(true);
  });

  test("undo before autosave cancels the pending write and redo persists it", () => {
    const { history, writes, tick } = fixture();
    history.ensure("a", "cafe", { collect: false });
    history.update("a", "cafe", { collect: true });
    history.undo("a");
    tick();
    expect(writes).toEqual([]);
    expect(history.getDraft("a", "cafe", null)).toEqual({ collect: false });
    history.redo("a");
    expect(writes).toEqual([{ profileId: "a", patch: { collect: true } }]);
  });

  test("new edits clear redo and reverting pending typing deduplicates history", () => {
    const { history, writes, tick } = fixture();
    history.ensure("a", "arena", { opponent: 1 });
    history.update("a", "arena", { opponent: 2 });
    history.flush("a");
    history.undo("a");
    history.update("a", "arena", { opponent: 3 });
    expect(history.getSnapshot("a").canRedo).toBe(false);
    history.update("a", "arena", { opponent: 1 });
    tick();
    expect(writes).toHaveLength(2);
    expect(history.getSnapshot("a").canUndo).toBe(false);
    expect(history.getSnapshot("a").canRedo).toBe(false);
  });

  test("invalid drafts stay editable and undoable but never persist, including redo", () => {
    const { history, writes, tick } = fixture();
    type Draft = { count: string; uiOnly: string };
    const serialize = (draft: Draft) =>
      /^\d+$/.test(draft.count) ? { actual_count: Number(draft.count) } : null;
    history.ensure("a", "artifact", { count: "1", uiOnly: "label" }, serialize);
    history.update("a", "artifact", { count: "", uiOnly: "label" });
    tick();
    expect(writes).toEqual([]);
    history.undo("a");
    history.redo("a");
    expect(writes).toEqual([]);
    history.update("a", "artifact", { count: "12", uiOnly: "different label" });
    history.flush("a");
    expect(writes).toEqual([{ profileId: "a", patch: { actual_count: 12 } }]);
    history.undo("a");
    expect(history.getDraft("a", "artifact", null)).toEqual({ count: "", uiOnly: "label" });
    // Undoing into incomplete input restores the last valid persisted value from that point.
    expect(writes.at(-1)?.patch).toEqual({ actual_count: 1 });
    expect(writes).toHaveLength(2);
  });

  test("own provider ACK retains UI representation and history after autosave", () => {
    const { history, writes } = fixture();
    type Draft = { count: string | number };
    const serialize = (draft: Draft) => ({ count: Number(draft.count) });
    history.ensure("a", "artifact", { count: 1 } as Draft, serialize);
    history.update("a", "artifact", { count: "02" });
    history.flush("a");
    history.syncSource("a", "artifact", { count: 2 });
    expect(history.getDraft("a", "artifact", null)).toEqual({ count: "02" });
    expect(history.getSnapshot("a").canUndo).toBe(true);
    history.undo("a");
    expect(writes.at(-1)?.patch).toEqual({ count: 1 });
  });

  test("navigation cleanup flushes only its section and subscriptions survive reconnect", () => {
    const { history, writes, tick } = fixture();
    let changes = 0;
    const unsubscribe = history.subscribe("a", () => changes++);
    history.ensure("a", "cafe", { collect: false });
    history.ensure("a", "script", { auto: false });
    history.update("a", "script", { auto: true });
    history.flush("a", "cafe");
    expect(writes).toEqual([]);
    unsubscribe();
    history.flush("a", "script");
    expect(writes).toEqual([{ profileId: "a", patch: { auto: true } }]);
    expect(changes).toBe(1);
    history.ensure("a", "script", { auto: false });
    expect(history.getDraft("a", "script", null)).toEqual({ auto: true });
    const stop = history.subscribe("a", () => changes++);
    history.undo("a");
    tick();
    expect(changes).toBe(2);
    stop();
  });

  test("external clean replacement clears only stale section history without writing", () => {
    const { history, writes } = fixture();
    history.ensure("a", "cafe", { collect: false });
    history.ensure("a", "arena", { opponent: 1 });
    history.update("a", "cafe", { collect: true });
    history.flush("a");
    history.update("a", "arena", { opponent: 2 });
    history.flush("a");
    history.syncSource("a", "cafe", { collect: "remote-value" });
    expect(writes).toHaveLength(2);
    expect(history.getDraft("a", "cafe", null)).toEqual({ collect: "remote-value" });
    history.undo("a");
    expect(writes.at(-1)?.patch).toEqual({ opponent: 1 });
    expect(history.getSnapshot("a").canUndo).toBe(false);
  });

  test("an older in-flight provider ACK cannot replace a newer draft or clear undo", () => {
    const { history, writes } = fixture();
    history.ensure("a", "arena", { opponent: 1 });
    history.update("a", "arena", { opponent: 2 });
    history.flush("a");
    history.update("a", "arena", { opponent: 3 });
    history.flush("a");
    history.syncSource("a", "arena", { opponent: 2 });
    history.syncSource("a", "arena", { opponent: 3 });
    expect(history.getDraft("a", "arena", null)).toEqual({ opponent: 3 });
    expect(history.undo("a")).toBe("arena");
    expect(writes.at(-1)?.patch).toEqual({ opponent: 2 });
    expect(history.undo("a")).toBe("arena");
    expect(writes.at(-1)?.patch).toEqual({ opponent: 1 });
    expect(history.undo("a")).toBeUndefined();
    expect(history.redo("a")).toBe("arena");
  });

  test("two independent fields edited rapidly are separate undo actions", () => {
    const { history, writes, tick } = fixture();
    const initial = { collect: false, invite: false };
    history.ensure("a", "cafe", initial);
    history.update("a", "cafe", { collect: true, invite: false });
    history.update("a", "cafe", { collect: true, invite: true });
    expect(writes).toEqual([{ profileId: "a", patch: { collect: true } }]);
    history.undo("a");
    tick();
    expect(history.getDraft("a", "cafe", initial)).toEqual({ collect: true, invite: false });
    expect(writes).toHaveLength(1);
    history.undo("a");
    expect(writes.at(-1)?.patch).toEqual({ collect: false });
    history.redo("a");
    history.redo("a");
    expect(history.getDraft("a", "cafe", initial)).toEqual({ collect: true, invite: true });
    expect(writes.at(-1)?.patch).toEqual({ invite: true });
  });

  test("partial own ACKs in reverse field order preserve newer values and both undo steps", () => {
    const { history, writes } = fixture();
    const initial = { collect: false, invite: false };
    history.ensure("a", "cafe", initial);
    history.update("a", "cafe", { collect: true, invite: false });
    history.update("a", "cafe", { collect: true, invite: true });
    history.flush("a");
    // The invite ACK is merged into the old provider snapshot before collect's ACK arrives.
    history.syncSource("a", "cafe", { collect: false, invite: true });
    expect(history.getDraft("a", "cafe", initial)).toEqual({ collect: true, invite: true });
    history.syncSource("a", "cafe", { collect: true, invite: true });
    history.undo("a");
    expect(writes.at(-1)?.patch).toEqual({ invite: false });
    history.undo("a");
    expect(writes.at(-1)?.patch).toEqual({ collect: false });
  });

  test("an invalid initial source can be corrected externally without a synthetic ACK match", () => {
    const { history, writes } = fixture();
    history.ensure("a", "server", { port: "" }, (draft) =>
      draft.port ? { port: draft.port } : null
    );
    history.syncSource("a", "server", { port: "5555" });
    expect(history.getDraft("a", "server", null)).toEqual({ port: "5555" });
    expect(history.getSnapshot("a").canUndo).toBe(false);
    expect(writes).toEqual([]);
  });
});
