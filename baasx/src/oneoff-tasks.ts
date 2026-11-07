/** Explicit StageConfig actions understood by the backend's solve alias table.
 * They are not scheduler events and must never be added to the daily task list.
 */
export const ONE_OFF_TASKS = [
  { id: "start_normal_task", labelKey: "eventName.startNormalTask" },
  { id: "start_hard_task", labelKey: "eventName.startHardTask" },
  { id: "start_main_story", labelKey: "eventName.startMainStory" },
  { id: "start_group_story", labelKey: "eventName.startGroupStory" },
  { id: "start_mini_story", labelKey: "eventName.startMiniStory" },
  { id: "start_explore_activity_story", labelKey: "eventName.startExploreActivityStory" },
  { id: "start_explore_activity_mission", labelKey: "eventName.startExploreActivityMission" },
  { id: "start_explore_activity_challenge", labelKey: "eventName.startExploreActivityChallenge" },
] as const;

const aliases = new Set<string>(ONE_OFF_TASKS.map((task) => task.id));

export function isOneOffTask(id: string): boolean {
  return aliases.has(id);
}
