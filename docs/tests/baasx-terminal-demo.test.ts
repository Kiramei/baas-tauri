import { describe, expect, test } from "bun:test";
import {
  demoReducer,
  demoRows,
  demoSteps,
  initialDemo,
  type DemoAction,
  type DemoScenario,
  type DemoState,
} from "../lib/baasx-terminal-demo";

const command = (value: string): DemoAction => ({ type: "command", value });
const key = (
  value: "up" | "down" | "left" | "right" | "enter" | "escape" | "space" | "save" | "plus" | "minus"
): DemoAction => ({ type: "key", key: value });
const act = (state: DemoState, ...actions: DemoAction[]) => actions.reduce(demoReducer, state);

describe("offline BAASX teaching behavior", () => {
  test("profile selection uses the actual profile command shape and survives reload", () => {
    const original = initialDemo("en", "quickstart");
    const picker = act(original, command("/profiles"));
    expect(picker.page).toBe("profiles");
    expect(demoRows(picker).join("\n")).toContain("sensei-demo");
    const selected = act(picker, key("enter"), command("/reload"));
    expect(selected.page).toBe("home");
    expect(selected.profile).toBe("Sensei Demo");
    expect(act(original, command("/use sensei-demo")).notice).toContain("Selected");
    expect(act(original, command("/use missing")).profile).toBe(original.profile);
    expect(act(original, command("/use missing")).notice).toContain("Only");
  });

  test("start runs directly, accepted is not completed, and stop waits for confirmation", () => {
    const started = act(initialDemo("en", "quickstart"), command("/start"));
    expect(started.running?.id).toBe("scheduler");
    expect(started.pending).toBeUndefined();
    expect(started.notice).toContain("not completed yet");
    const stopping = act(started, command("/stop"));
    expect(stopping.running).toEqual(started.running);
    expect(stopping.pending?.kind).toBe("stop");
    expect(act(stopping, key("escape")).running).toEqual(started.running);
    const cancelledWithArrows = act(stopping, key("right"), key("enter"));
    expect(cancelledWithArrows.running).toEqual(started.running);
    expect(cancelledWithArrows.pending).toBeUndefined();
    const stopped = act(stopping, key("enter"));
    expect(stopped.running).toBeUndefined();
    expect(stopped.logs.at(-1)).toContain("stopped");
  });

  test("single and one-off tasks require confirmation and never add daily events", () => {
    const state = initialDemo("zh", "quickstart");
    const single = act(state, command("/run mail"));
    expect(single.running).toBeUndefined();
    expect(single.pending).toEqual({ kind: "run", id: "mail" });
    expect(act(single, key("enter")).running?.id).toBe("mail");
    const oneoff = act(state, command("/oneoff"), key("down"), key("enter"), key("enter"));
    expect(oneoff.running?.id).toBe("start_main_story");
    expect(oneoff.schedule).toEqual(state.schedule);
    expect(act(state, command("/run unknown_task")).running).toBeUndefined();
  });

  test("every region count is editable while zeros, drafts, and cancellation are preserved", () => {
    const original = initialDemo("en", "configuration");
    let editing = act(original, key("enter"));
    expect(editing.page).toBe("counts");
    expect(editing.draftCounts[1]).toBe(0);
    for (let index = 0; index < original.counts.length; index++) {
      editing = act(editing, key("plus"), key("down"));
    }
    expect(editing.counts).toEqual(original.counts);
    expect(editing.draftCounts).toEqual([2, 1, 2, 2]);
    expect(act(editing, key("escape")).counts).toEqual(original.counts);
    const pending = act(editing, key("save"));
    expect(pending.counts).toEqual(original.counts);
    const saved = act(pending, key("enter"));
    expect(saved.counts).toEqual([2, 1, 2, 2]);
    expect(saved.page).toBe("config");
  });

  test("count entry and increment controls both enforce the actual 0–99 range", () => {
    const editing = act(initialDemo("en", "configuration"), key("enter"), key("enter"));
    for (const value of ["-1", "100", "1.5", "oops", ""]) {
      const invalid = act(editing, { type: "value", value }, key("enter"));
      expect(invalid.editValue).not.toBeUndefined();
      expect(invalid.draftCounts).toEqual([1, 0, 1, 1]);
    }
    const maximum = act(editing, { type: "value", value: "99" }, key("enter"), key("plus"));
    expect(maximum.draftCounts[0]).toBe(99);
    const minimum = act(editing, { type: "value", value: "0" }, key("enter"), key("minus"));
    expect(minimum.draftCounts[0]).toBe(0);
  });

  test("priority moves keep selection with the saved value and do not save cancelled drafts", () => {
    const original = initialDemo("en", "configuration");
    const editing = act(original, key("down"), key("enter"), key("right"));
    expect(editing.selected).toBe(1);
    expect(editing.draftPriority).toEqual(["金属", "花", "闪耀"]);
    expect(demoRows(editing).join("\n")).toContain("❯ 2. Flower");
    expect(act(editing, key("escape")).priority).toEqual(original.priority);
    expect(act(editing, key("save"), key("enter")).priority).toEqual(["金属", "花", "闪耀"]);
    const removed = act(editing, key("space"));
    expect(removed.draftPriority).toEqual(["金属", "闪耀"]);
  });

  test("schedule priority permits signed integers while interval rejects negative values", () => {
    const priority = act(
      initialDemo("en", "scheduler"),
      key("enter"),
      key("down"),
      key("enter"),
      { type: "value", value: "-10" },
      key("enter")
    );
    expect(priority.editValue).toBeUndefined();
    expect(priority.draftSchedule[0].priority).toBe(-10);
    const interval = act(
      priority,
      key("down"),
      key("enter"),
      { type: "value", value: "-1" },
      key("enter")
    );
    expect(interval.editValue).toBe("-1");
    expect(interval.draftSchedule[0].interval).toBe(86400);
    expect(interval.notice).toContain("nonnegative");
    const saved = act(
      interval,
      { type: "value", value: "0" },
      key("enter"),
      key("save"),
      key("enter")
    );
    expect(saved.schedule[0].priority).toBe(-10);
    expect(saved.schedule[0].interval).toBe(0);
  });

  test("read-only packs run immediately while mutating plans wait for confirmation", () => {
    const state = initialDemo("en", "packs");
    for (const id of ["briefing", "connection-check"]) {
      const read = act(state, command(`/pack ${id}`));
      expect(read.pending).toBeUndefined();
      expect(read.running).toBeUndefined();
      expect(read.logs.length).toBe(1);
      expect(read.page).toBe("logs");
    }
    const selected = act(state, key("enter"));
    expect(selected.pending).toBeUndefined();
    expect(selected.logs.at(-1)).toContain("status → tasks");
    const pending = act(state, command("/pack daily-wait"));
    expect(pending.running).toBeUndefined();
    expect(demoRows(pending).join("\n")).toContain("wait_run");
    expect(act(pending, key("escape")).running).toBeUndefined();
    expect(act(pending, key("enter")).running?.id).toBe("scheduler");
  });

  test("reload preserves saved configuration and the exact active run; reset clears them", () => {
    const configured = act(
      initialDemo("en", "configuration"),
      key("enter"),
      key("plus"),
      key("save"),
      key("enter"),
      command("/start"),
      { type: "tick" }
    );
    const reloaded = act(configured, command("/reload"));
    expect(reloaded.page).toBe("home");
    expect(reloaded.counts).toEqual(configured.counts);
    expect(reloaded.running).toEqual(configured.running);
    expect(reloaded.revision).toBe(1);
    const reset = act(reloaded, { type: "reset", locale: "en", scenario: "configuration" });
    expect(reset.running).toBeUndefined();
    expect(reset.counts).toEqual([1, 0, 1, 1]);
  });

  test("task completion is generated only after sample progress reaches its final step", () => {
    let state = act(initialDemo("en", "quickstart"), command("/run mail"), key("enter"));
    for (let tick = 0; tick < 3; tick++) {
      state = act(state, { type: "tick" });
      expect(state.running).toBeDefined();
      expect(state.logs.join("\n")).not.toContain("exit_code=0");
    }
    state = act(state, { type: "tick" });
    expect(state.running).toBeUndefined();
    expect(state.notice).toContain("exit_code=0");
    expect(state.notice).toContain("No game action");
  });

  test("all guided scenes finish consistently in both languages", () => {
    for (const locale of ["zh", "en"] as const) {
      for (const scenario of [
        "quickstart",
        "configuration",
        "scheduler",
        "packs",
      ] as DemoScenario[]) {
        const state = act(
          initialDemo(locale, scenario),
          ...demoSteps(scenario).map((step) => step.action)
        );
        expect(state.pending).toBeUndefined();
        expect(state.running).toBeUndefined();
        if (scenario === "configuration") {
          expect(state.counts).toEqual([1, 1, 1, 1]);
          expect(state.priority).toEqual(["金属", "花", "闪耀"]);
        }
        if (scenario === "scheduler") expect(state.schedule[0].enabled).toBe(false);
        expect(demoRows(state).length).toBeGreaterThan(0);
      }
    }
  });
});
