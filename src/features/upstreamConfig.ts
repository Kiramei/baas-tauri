import type { WebSocketState } from "@/types/app";
import { saveConfigurationPatch } from "@/shared/ConfigurationSave";

export interface ArenaConfigDraft {
  ArenaLevelDiff: string;
  ArenaComponentNumber: string;
  maxArenaRefreshTimes: string;
  ArenaStopFightWhenRank1: boolean;
}

export function hasConfigurationField(snapshot: object | null | undefined, key: string): boolean {
  return snapshot !== null && snapshot !== undefined && Object.hasOwn(snapshot, key);
}

/** Older backends cannot accept replacement operations for keys absent from their snapshot. */
export function supportedConfigurationPatch(
  patch: Record<string, unknown>,
  snapshot?: object | null
): Record<string, unknown> {
  return snapshot === undefined
    ? patch
    : Object.fromEntries(
        Object.entries(patch).filter(([key]) => hasConfigurationField(snapshot, key))
      );
}

/** Convert editable numbers only after all arena values are valid. */
export function serializeArenaConfig(draft: ArenaConfigDraft, snapshot?: object) {
  const level = Number(draft.ArenaLevelDiff);
  const refresh = Number(draft.maxArenaRefreshTimes);
  const opponent = Number(draft.ArenaComponentNumber);
  if (
    !draft.ArenaLevelDiff.trim() ||
    !Number.isInteger(level) ||
    level < -89 ||
    level > 89 ||
    !draft.maxArenaRefreshTimes.trim() ||
    !Number.isSafeInteger(refresh) ||
    refresh < 0 ||
    ![1, 2, 3].includes(opponent)
  )
    return null;
  return supportedConfigurationPatch(
    {
      ArenaLevelDiff: level,
      ArenaComponentNumber: opponent,
      maxArenaRefreshTimes: refresh,
      ArenaStopFightWhenRank1: draft.ArenaStopFightWhenRank1,
    },
    snapshot
  );
}

export interface StageConfigDraft {
  manual_boss: boolean;
  explore_task_use_simple_mode: boolean;
  explore_normal_task_list: string;
  explore_hard_task_list: string;
  main_story_regions: string;
}

/** Keep malformed/imported values visible until the user repairs them. */
export function readMainStoryRegions(value: unknown): string {
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? value.map(String).join(",") : String(value);
}

/** The server's catalog defines valid episode IDs, including future additions. */
export function mainStoryEpisodeOptions(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (episode): episode is number =>
          typeof episode === "number" && Number.isSafeInteger(episode) && episode > 0
      )
    ),
  ];
}

export interface MainStorySelection {
  episodes: number[];
  value: string;
  error: "format" | "unavailable" | null;
}

/** The backend accepts comma-separated IDs, with an empty string meaning all episodes. */
export function parseMainStoryRegions(
  value: string,
  availableEpisodes: readonly number[]
): MainStorySelection {
  if (!value.trim()) return { episodes: [], value: "", error: null };
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => !/^[1-9]\d*$/.test(part)))
    return { episodes: [], value, error: "format" };
  const episodes = parts.map(Number);
  if (
    episodes.some((episode) => !Number.isSafeInteger(episode)) ||
    new Set(episodes).size !== episodes.length
  )
    return { episodes, value, error: "format" };
  if (episodes.some((episode) => !availableEpisodes.includes(episode)))
    return { episodes, value, error: "unavailable" };
  return { episodes, value: episodes.join(","), error: null };
}

/** An invalid story list stays local; unrelated valid settings can still be saved. */
export function serializeStageConfig(
  draft: StageConfigDraft,
  availableEpisodes: readonly number[],
  snapshot?: object
) {
  const { main_story_regions, ...settings } = draft;
  const selection = parseMainStoryRegions(main_story_regions, availableEpisodes);
  return supportedConfigurationPatch(
    selection.error ? settings : { ...settings, main_story_regions: selection.value },
    snapshot
  );
}

/** Seconds may be fractional, but incomplete, negative and non-finite input stays local. */
export function parseCafeInteractionDelay(value: string): number | null {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function serializeCafeInteractionSettings<
  T extends { cafe_reward_interaction_shot_delay: string },
>(draft: T, snapshot?: object) {
  const { cafe_reward_interaction_shot_delay, ...settings } = draft;
  const delay = parseCafeInteractionDelay(cafe_reward_interaction_shot_delay);
  return supportedConfigurationPatch(
    delay === null ? settings : { ...settings, cafe_reward_interaction_shot_delay: delay },
    snapshot
  );
}
export type StageLaunchStore = Pick<
  WebSocketState,
  | "_auth_phase"
  | "_session"
  | "connections"
  | "configStore"
  | "modify"
  | "trigger"
  | "pendingCallbacks"
>;

export class StageLaunchError extends Error {
  constructor(
    readonly code: "save_unconfirmed" | "session_changed" | "cancelled" | "command_unconfirmed"
  ) {
    super(code);
    this.name = "StageLaunchError";
  }
}

/** Both channels must still belong to the authenticated session which saved the draft. */
export async function runStageTaskAfterSave(
  getState: () => StageLaunchStore,
  profileId: string,
  task: string,
  expected: Record<string, unknown>,
  flush: () => void,
  {
    signal,
    saveTimeoutMs = 10_000,
    commandTimeoutMs = 300_000,
  }: { signal?: AbortSignal; saveTimeoutMs?: number; commandTimeoutMs?: number } = {}
): Promise<"started" | "already-running"> {
  if (signal?.aborted) throw new StageLaunchError("cancelled");
  const initial = getState();
  const session = initial._session;
  const sync = initial.connections.sync;
  const trigger = initial.connections.trigger;
  const patch = supportedConfigurationPatch(expected, initial.configStore[profileId] ?? {});
  if (
    initial._auth_phase !== "authenticated" ||
    sync?.readyState !== 1 ||
    trigger?.readyState !== 1
  )
    throw new StageLaunchError("save_unconfirmed");
  const assertSession = () => {
    if (signal?.aborted) throw new StageLaunchError("cancelled");
    const state = getState();
    if (
      state._auth_phase !== "authenticated" ||
      state._session !== session ||
      state.connections.sync !== sync ||
      state.connections.trigger !== trigger ||
      sync.readyState !== 1 ||
      trigger.readyState !== 1
    )
      throw new StageLaunchError("session_changed");
  };
  try {
    flush();
    assertSession();
    // Use this write's ACK: an older snapshot may happen to contain the same values.
    if (Object.keys(patch).length)
      await saveConfigurationPatch(getState, profileId, patch, {
        signal,
        timeoutMs: saveTimeoutMs,
      });
    assertSession();
  } catch (error) {
    if (signal?.aborted) throw new StageLaunchError("cancelled");
    if (error instanceof StageLaunchError) throw error;
    assertSession();
    throw new StageLaunchError("save_unconfirmed");
  }
  return new Promise<"started" | "already-running">((resolve, reject) => {
    let timestamp: number | undefined;
    let settled = false;
    const callbacks = getState().pendingCallbacks;
    const timer = setTimeout(
      () => finish(new StageLaunchError("command_unconfirmed")),
      commandTimeoutMs
    );
    const finish = (
      error?: StageLaunchError,
      result: "started" | "already-running" = "started"
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (timestamp !== undefined && callbacks[timestamp] === onResponse)
        delete callbacks[timestamp];
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(new StageLaunchError("cancelled"));
    const onResponse: NonNullable<Parameters<StageLaunchStore["trigger"]>[1]> = (response) => {
      try {
        assertSession();
        if (response?.status !== "ok") {
          finish(new StageLaunchError("command_unconfirmed"));
          return;
        }
        if (response.data?.status === "already-running") finish(undefined, "already-running");
        else if (response.data?.status === "ok" || response.data?.status === "started") finish();
        else finish(new StageLaunchError("command_unconfirmed"));
      } catch (error) {
        finish(
          error instanceof StageLaunchError ? error : new StageLaunchError("command_unconfirmed")
        );
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      assertSession();
      timestamp = getState().trigger(
        { timestamp: Date.now(), command: "solve", config_id: profileId, payload: { task } },
        onResponse
      );
    } catch (error) {
      finish(
        error instanceof StageLaunchError ? error : new StageLaunchError("command_unconfirmed")
      );
    }
  });
}
