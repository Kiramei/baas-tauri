/**
 * Type definitions for the dynamic configuration payload exchanged between the UI and backend.
 * Regenerate this file alongside the service schema to keep type expectations synchronized.
 */

export interface DynamicConfig {
  name: string;
  purchase_arena_ticket_times: string;
  screenshot_interval: string;
  autostart: boolean;
  then: string;
  program_address: string;
  open_emulator_stat: boolean;
  emulator_wait_time: string;
  ArenaLevelDiff: number;
  ArenaComponentNumber: number;
  maxArenaRefreshTimes: number;
  createPriority_phase1: string;
  createPriority_phase2: string;
  createPriority_phase3: string;
  create_phase_1_select_item_rule: string;
  create_phase_2_select_item_rule: string;
  create_phase_3_select_item_rule: string;
  create_phase: number;
  create_item_holding_quantity: CreateItemHoldingQuantity;
  use_acceleration_ticket: boolean;
  createTime: string;
  last_refresh_config_time: string;
  alreadyCreateTime: string;
  totalForceFightDifficulty: string;
  hardPriority: string;
  unfinished_hard_tasks: any[];
  mainlinePriority: string;
  unfinished_normal_tasks: any[];
  main_story_regions: string;
  rewarded_task_times: string;
  purchase_rewarded_task_ticket_times: string;
  special_task_times: string;
  purchase_scrimmage_ticket_times: string;
  scrimmage_times: string;
  patStyle: string;
  antiHarmony: boolean;
  bannerVisibility: boolean;
  push_after_error: boolean;
  push_after_completion: boolean;
  push_json: string;
  push_serverchan: string;
  cafe_reward_affection_pat_round: number;
  cafe_reward_lowest_affection_first: boolean;
  cafe_reward_invite1_criterion: string;
  favorStudent1: string[];
  cafe_reward_invite1_starred_student_position: number;
  cafe_reward_has_no2_cafe: boolean;
  cafe_reward_collect_hour_reward: boolean;
  cafe_reward_invite2_criterion: string;
  favorStudent2: string[];
  cafe_reward_invite2_starred_student_position: number;
  cafe_reward_use_invitation_ticket: boolean;
  cafe_reward_allow_duplicate_invite: boolean;
  cafe_reward_allow_exchange_student: boolean;
  cafe_reward_interaction_shot_delay: number;
  server: string;
  control_method: string;
  screenshot_method: string;
  adbIP: string;
  adbPort: string;
  lesson_times: number[];
  lesson_enableInviteFavorStudent: boolean;
  lesson_favorStudent: string[];
  lesson_relationship_first: boolean;
  lesson_each_region_object_priority: Array<LessonEachRegionObjectPriority[]>;
  purchase_lesson_ticket_times: string;
  explore_normal_task_list: string;
  explore_hard_task_list: string;
  emulatorIsMultiInstance: boolean;
  emulatorMultiInstanceNumber: number;
  multiEmulatorName: string;
  manual_boss: boolean;
  choose_team_method: string;
  side_team_attribute: Array<TeamAttribute[]>;
  preset_team_attribute: Array<TeamAttribute[]>;
  activity_sweep_task_number: number;
  activity_sweep_times: string;
  TacticalChallengeShopRefreshTime: string;
  TacticalChallengeShopList: number[];
  CommonShopRefreshTime: string;
  CommonShopList: number[];
  clear_friend_white_list: any[];
  drill_difficulty_list: number[];
  drill_fight_formation_list: number[];
  drill_enable_sweep: boolean;
  new_event_enable_state: string;
  ap: Ap;
  creditpoints: BountyCoin;
  pyroxene: BountyCoin;
  tactical_challenge_coin: BountyCoin;
  bounty_coin: BountyCoin;
  _pass: Pass;
  assetsVisibility: boolean;
  hotkey_run: string;
}

export interface Pass {
  level: number;
  max_level: number;
  next_level_point: number;
  next_level_point_required: number;
  weekly_point: number;
  max_weekly_point: number;
  time: number;
}

export interface Ap {
  count: number;
  max: number;
  time: number;
}

export interface BountyCoin {
  count: number;
  time: number;
}

export type CreateItemHoldingQuantity = object;

export type LessonEachRegionObjectPriority = "primary" | "normal" | "advanced" | "superior";

export type TeamAttribute = "Unused";
