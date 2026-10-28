import { describe, expect, test } from "bun:test";
import {
  hasConfigurationField,
  mainStoryEpisodeOptions,
  parseCafeInteractionDelay,
  parseMainStoryRegions,
  readMainStoryRegions,
  runStageTaskAfterSave,
  serializeArenaConfig,
  serializeCafeInteractionSettings,
  serializeStageConfig,
  supportedConfigurationPatch,
  type ArenaConfigDraft,
  type StageConfigDraft,
  type StageLaunchStore,
} from "../../src/features/upstreamConfig";
import {
  ConfigurationHistory,
  type ConfigurationValues,
} from "../../src/shared/ConfigurationHistory";

const arena: ArenaConfigDraft = {
  ArenaLevelDiff: "0",
  maxArenaRefreshTimes: "10",
  ArenaComponentNumber: "1",
  ArenaStopFightWhenRank1: false,
};
const stage: StageConfigDraft & Record<string, unknown> = {
  manual_boss: false,
  explore_task_use_simple_mode: false,
  explore_normal_task_list: "4",
  explore_hard_task_list: "1",
  main_story_regions: "",
};

describe("upstream behavior settings", () => {
  test("rank-one behavior keeps a boolean and preserves arena numeric types", () => {
    expect(serializeArenaConfig({ ...arena, ArenaStopFightWhenRank1: true })).toEqual({
      ArenaLevelDiff: 0,
      maxArenaRefreshTimes: 10,
      ArenaComponentNumber: 1,
      ArenaStopFightWhenRank1: true,
    });
    expect(serializeArenaConfig({ ...arena, maxArenaRefreshTimes: "" })).toBeNull();
    expect(serializeArenaConfig({ ...arena, maxArenaRefreshTimes: "9007199254740992" })).toBeNull();
    expect(serializeArenaConfig({ ...arena, ArenaComponentNumber: "4" })).toBeNull();
  });

  test("the story catalog preserves backend ordering and accepts future episode IDs", () => {
    expect(mainStoryEpisodeOptions([3, 1, 2, 3, 15, 0, -1, 1.5, "4", null])).toEqual([3, 1, 2, 15]);
    expect(mainStoryEpisodeOptions(undefined)).toEqual([]);
    expect(parseMainStoryRegions("15,3,1", [3, 1, 2, 15])).toEqual({
      episodes: [15, 3, 1],
      value: "15,3,1",
      error: null,
    });
  });

  test("blank means all episodes and explicit selections retain execution order", () => {
    expect(parseMainStoryRegions("  ", [])).toEqual({ episodes: [], value: "", error: null });
    expect(parseMainStoryRegions(" 3, 1 ,2 ", [1, 2, 3])).toEqual({
      episodes: [3, 1, 2],
      value: "3,1,2",
      error: null,
    });
    expect(
      serializeStageConfig({ ...stage, main_story_regions: " 3, 1 " }, [1, 2, 3])
    ).toMatchObject({ main_story_regions: "3,1" });
  });

  test("ranges, partial lists, duplicate IDs and non-integers never reach the backend", () => {
    for (const value of [
      "1-3",
      "1,",
      ",1",
      "1,,2",
      "0",
      "-1",
      "1.5",
      "1e1",
      "0x1",
      "NaN",
      "Infinity",
      "01",
      "1,1",
      "9007199254740992",
    ]) {
      expect(parseMainStoryRegions(value, [1, 2, 3]).error).toBe("format");
      expect(
        serializeStageConfig({ ...stage, main_story_regions: value }, [1, 2, 3])
      ).not.toHaveProperty("main_story_regions");
    }
  });

  test("a list for another server remains editable, but cannot silently run all chapters", () => {
    const imported = "12, 1";
    expect(readMainStoryRegions(imported)).toBe(imported);
    expect(readMainStoryRegions([12, 1])).toBe("12,1");
    expect(readMainStoryRegions(undefined)).toBe("");
    expect(parseMainStoryRegions(imported, [1, 2, 3]).error).toBe("unavailable");
    expect(parseMainStoryRegions("1", []).error).toBe("unavailable");
    expect(
      serializeStageConfig({ ...stage, main_story_regions: imported }, [1, 2, 3])
    ).not.toHaveProperty("main_story_regions");
  });

  test("story repair, simple mode and rank-one settings use isolated profile history", () => {
    const writes: { id: string; patch: ConfigurationValues }[] = [];
    const history = new ConfigurationHistory({
      persist: (id, patch) => writes.push({ id, patch }),
      schedule: () => 0,
      cancel: () => {},
    });
    const serialize = (draft: StageConfigDraft) => serializeStageConfig(draft, [1, 2, 3]);
    history.ensure("first", "stage", stage, serialize);
    history.ensure("second", "stage", stage, serialize);
    history.ensure("first", "arena", arena, serializeArenaConfig);
    expect(writes).toEqual([]);
    history.update("first", "stage", { ...stage, main_story_regions: "12,1" });
    history.flush("first");
    expect(writes).toEqual([]);
    history.update("first", "stage", {
      ...stage,
      explore_task_use_simple_mode: true,
      main_story_regions: "12,1",
    });
    history.flush("first");
    expect(writes.at(-1)).toEqual({ id: "first", patch: { explore_task_use_simple_mode: true } });
    history.update("first", "stage", {
      ...stage,
      explore_task_use_simple_mode: true,
      main_story_regions: "3,1",
    });
    history.flush("first");
    expect(writes.at(-1)).toEqual({ id: "first", patch: { main_story_regions: "3,1" } });
    history.update("first", "arena", { ...arena, ArenaStopFightWhenRank1: true });
    history.flush("first");
    expect(writes.at(-1)).toEqual({ id: "first", patch: { ArenaStopFightWhenRank1: true } });
    history.undo("first");
    expect(writes.at(-1)).toEqual({ id: "first", patch: { ArenaStopFightWhenRank1: false } });
    expect(history.getDraft("second", "stage", null)).toEqual(stage);
  });

  test("interaction capture delay accepts zero and fractional seconds, excluding unsafe input", () => {
    for (const [value, expected] of [
      ["0", 0],
      [" 0.25 ", 0.25],
      [".5", 0.5],
      ["1e-2", 0.01],
    ] as const) {
      expect(parseCafeInteractionDelay(value)).toBe(expected);
    }
    for (const value of ["", " ", "-0.1", "NaN", "Infinity", "1e309", "0x10", "1,2", "abc"])
      expect(parseCafeInteractionDelay(value)).toBeNull();
  });

  test("invalid interaction delay stays local while other cafe edits remain usable", () => {
    expect(
      serializeCafeInteractionSettings({
        cafe_reward_interaction_shot_delay: "0.2",
        patStyle: "拖动礼物",
      })
    ).toEqual({ cafe_reward_interaction_shot_delay: 0.2, patStyle: "拖动礼物" });
    expect(
      serializeCafeInteractionSettings({
        cafe_reward_interaction_shot_delay: "-1",
        patStyle: "普通",
      })
    ).toEqual({ patStyle: "普通" });
  });

  test("unsupported behavior controls use real own keys, including supported false values", () => {
    expect(hasConfigurationField({}, "ArenaStopFightWhenRank1")).toBe(false);
    expect(
      hasConfigurationField({ ArenaStopFightWhenRank1: false }, "ArenaStopFightWhenRank1")
    ).toBe(true);
    expect(
      hasConfigurationField(
        Object.create({ explore_task_use_simple_mode: false }),
        "explore_task_use_simple_mode"
      )
    ).toBe(false);
    expect(hasConfigurationField(undefined, "main_story_regions")).toBe(false);
  });

  test("older snapshots never acquire unsupported defaults through another control's autosave", () => {
    const legacyArena = { ArenaLevelDiff: 0, maxArenaRefreshTimes: 10, ArenaComponentNumber: 1 };
    expect(serializeArenaConfig({ ...arena, ArenaStopFightWhenRank1: true }, legacyArena)).toEqual(
      legacyArena
    );
    const legacyStage = {
      manual_boss: false,
      explore_normal_task_list: "4",
      explore_hard_task_list: "1",
    };
    expect(
      serializeStageConfig(
        { ...stage, explore_task_use_simple_mode: true, main_story_regions: "2,1" },
        [1, 2, 3],
        legacyStage
      )
    ).toEqual(legacyStage);
    expect(
      serializeCafeInteractionSettings(
        { cafe_reward_interaction_shot_delay: "0.2", patStyle: "拖动礼物" },
        { patStyle: "普通" }
      )
    ).toEqual({ patStyle: "拖动礼物" });
    expect(supportedConfigurationPatch(stage, null)).toEqual({});
  });
});

function launchFixture(
  automaticCommandAck = true,
  snapshot: Record<string, unknown> = { ...stage, main_story_regions: "1" }
) {
  const events: string[] = [];
  const writes: { patch: Record<string, unknown>; acknowledge?: () => void }[] = [];
  const commands: { task: unknown; savedAtAcceptance: Record<string, unknown> }[] = [];
  let saved: Record<string, unknown> = { ...snapshot };
  let nextTimestamp = 1;
  let cancelledWrites = 0;
  const pendingCallbacks: StageLaunchStore["pendingCallbacks"] = {};
  const state: StageLaunchStore = {
    _auth_phase: "authenticated",
    _session: null,
    configStore: { first: { ...snapshot } } as unknown as StageLaunchStore["configStore"],
    connections: {
      sync: { readyState: 1 } as NonNullable<StageLaunchStore["connections"]["sync"]>,
      trigger: { readyState: 1 } as NonNullable<StageLaunchStore["connections"]["trigger"]>,
    },
    pendingCallbacks,
    modify: (_path, patch, _showToast, onAcknowledged) => {
      const write = { patch, acknowledge: onAcknowledged };
      writes.push(write);
      events.push("write");
      return () => {
        cancelledWrites += 1;
      };
    },
    trigger: (payload, onResponse) => {
      events.push("solve");
      commands.push({ task: payload.payload.task, savedAtAcceptance: { ...saved } });
      const timestamp = nextTimestamp++;
      pendingCallbacks[timestamp] = onResponse ?? (() => {});
      if (automaticCommandAck)
        queueMicrotask(() => {
          pendingCallbacks[timestamp]?.({
            status: "ok",
            data: { status: "ok", task: "main_story", result: 0 },
          });
          delete pendingCallbacks[timestamp];
        });
      return timestamp;
    },
  };
  return {
    state,
    events,
    writes,
    commands,
    pendingCallbacks,
    getState: () => state,
    flush: () => {
      events.push("flush");
    },
    acknowledge: () => {
      saved = { ...saved, ...writes.at(-1)!.patch };
      events.push("ack");
      writes.at(-1)!.acknowledge?.();
    },
    cancelledWrites: () => cancelledWrites,
  };
}

describe("save-confirmed stage execution", () => {
  test("a task reads the saved order only after this write's real ACK", async () => {
    const f = launchFixture();
    const patch = serializeStageConfig({ ...stage, main_story_regions: "3,1" }, [1, 2, 3]);
    const launching = runStageTaskAfterSave(
      f.getState,
      "first",
      "start_main_story",
      patch,
      f.flush
    );
    await Promise.resolve();
    expect(f.events).toEqual(["flush", "write"]);
    expect(f.commands).toHaveLength(0);
    expect(f.writes[0].patch).toEqual(patch);
    f.acknowledge();
    await launching;
    expect(f.events).toEqual(["flush", "write", "ack", "solve"]);
    expect(f.commands).toEqual([{ task: "start_main_story", savedAtAcceptance: patch }]);
    expect(f.pendingCallbacks).toEqual({});
  });

  test("missing ACK times out without starting automation", async () => {
    const f = launchFixture();
    await expect(
      runStageTaskAfterSave(f.getState, "first", "start_normal_task", stage, f.flush, {
        saveTimeoutMs: 8,
      })
    ).rejects.toMatchObject({ code: "save_unconfirmed" });
    expect(f.commands).toHaveLength(0);
    expect(f.cancelledWrites()).toBe(1);
    f.acknowledge();
    await Promise.resolve();
    expect(f.commands).toHaveLength(0);
  });

  test("unmount cancellation ignores a late save ACK", async () => {
    const f = launchFixture();
    const controller = new AbortController();
    const launching = runStageTaskAfterSave(
      f.getState,
      "first",
      "start_main_story",
      stage,
      f.flush,
      { signal: controller.signal }
    );
    controller.abort();
    await expect(launching).rejects.toMatchObject({ code: "cancelled" });
    f.acknowledge();
    await Promise.resolve();
    expect(f.commands).toHaveLength(0);
    expect(f.cancelledWrites()).toBe(1);
  });

  test("session and command-channel replacement prevent an old editor from launching", async () => {
    for (const change of [
      (state: StageLaunchStore) => {
        state._auth_phase = "revoked";
      },
      (state: StageLaunchStore) => {
        state._session = {} as NonNullable<StageLaunchStore["_session"]>;
      },
      (state: StageLaunchStore) => {
        state.connections.trigger = { readyState: 1 } as NonNullable<
          StageLaunchStore["connections"]["trigger"]
        >;
      },
    ]) {
      const f = launchFixture();
      const launching = runStageTaskAfterSave(
        f.getState,
        "first",
        "start_main_story",
        stage,
        f.flush
      );
      f.acknowledge();
      // The guard after await catches a connection replaced before the solve microtask.
      change(f.state);
      await expect(launching).rejects.toMatchObject({ code: "session_changed" });
      expect(f.commands).toHaveLength(0);
    }
  });

  test("unknown command outcome times out and releases its callback", async () => {
    const f = launchFixture(false);
    const launching = runStageTaskAfterSave(
      f.getState,
      "first",
      "start_main_story",
      stage,
      f.flush,
      { commandTimeoutMs: 8 }
    );
    f.acknowledge();
    await expect(launching).rejects.toMatchObject({ code: "command_unconfirmed" });
    expect(f.commands).toHaveLength(1);
    expect(f.pendingCallbacks).toEqual({});
  });

  test("a rejected solve never reports success", async () => {
    const f = launchFixture(false);
    const launching = runStageTaskAfterSave(
      f.getState,
      "first",
      "start_main_story",
      stage,
      f.flush
    );
    f.acknowledge();
    await Promise.resolve();
    expect(f.commands).toHaveLength(1);
    Object.values(f.pendingCallbacks)[0]({ status: "error", error: "busy" });
    await expect(launching).rejects.toMatchObject({ code: "command_unconfirmed" });
    expect(f.pendingCallbacks).toEqual({});
  });

  test("unmount after sending solve removes the callback without cancelling another command", async () => {
    const f = launchFixture(false);
    const controller = new AbortController();
    const launching = runStageTaskAfterSave(
      f.getState,
      "first",
      "start_main_story",
      stage,
      f.flush,
      { signal: controller.signal }
    );
    f.acknowledge();
    await Promise.resolve();
    expect(f.commands).toHaveLength(1);
    const unrelated = () => {};
    f.pendingCallbacks[1] = unrelated;
    controller.abort();
    await expect(launching).rejects.toMatchObject({ code: "cancelled" });
    expect(f.pendingCallbacks[1]).toBe(unrelated);
  });

  test("the final save barrier filters defaults against the current old-backend snapshot", async () => {
    const legacy = {
      manual_boss: false,
      explore_normal_task_list: "4",
      explore_hard_task_list: "1",
    };
    const f = launchFixture(true, legacy);
    const launching = runStageTaskAfterSave(
      f.getState,
      "first",
      "start_main_story",
      stage,
      f.flush
    );
    expect(f.writes[0].patch).toEqual(legacy);
    f.acknowledge();
    await expect(launching).resolves.toBe("started");
    expect(f.commands[0].savedAtAcceptance).toEqual(legacy);
  });

  test("device initialization has its own longer command budget after saving", async () => {
    const f = launchFixture(false);
    const launching = runStageTaskAfterSave(
      f.getState,
      "first",
      "start_main_story",
      stage,
      f.flush,
      { saveTimeoutMs: 5, commandTimeoutMs: 100 }
    );
    f.acknowledge();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(f.commands).toHaveLength(1);
    expect(Object.keys(f.pendingCallbacks)).toHaveLength(1);
    Object.values(f.pendingCallbacks)[0]({
      command: "solve",
      status: "ok",
      data: { status: "ok", task: "main_story", result: 0 },
    });
    await expect(launching).resolves.toBe("started");
  });

  test("the real already-running envelope never reports a newly started task", async () => {
    const f = launchFixture(false);
    const launching = runStageTaskAfterSave(
      f.getState,
      "first",
      "start_main_story",
      stage,
      f.flush
    );
    f.acknowledge();
    await Promise.resolve();
    Object.values(f.pendingCallbacks)[0]({
      command: "solve",
      status: "ok",
      data: { status: "already-running", config_id: "first" },
    });
    await expect(launching).resolves.toBe("already-running");
    expect(f.commands).toHaveLength(1);
    expect(f.pendingCallbacks).toEqual({});
  });

  test("an outer ok with an unknown inner result remains unconfirmed", async () => {
    const f = launchFixture(false);
    const launching = runStageTaskAfterSave(
      f.getState,
      "first",
      "start_main_story",
      stage,
      f.flush
    );
    f.acknowledge();
    await Promise.resolve();
    Object.values(f.pendingCallbacks)[0]({ command: "solve", status: "ok", data: {} });
    await expect(launching).rejects.toMatchObject({ code: "command_unconfirmed" });
  });
});
