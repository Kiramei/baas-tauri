import type { TranslationKey } from "@/types/i18n";

export const i18nKey = (key: TranslationKey) => key;

const fromRecord = <T extends string>(
  map: Record<T, TranslationKey>,
  value: string | null | undefined,
  fallback: TranslationKey
) => {
  if (!value) return fallback;
  const raw = value.includes(".") ? value.split(".").pop()! : value;
  return map[raw as T] ?? fallback;
};

const eventNameMap: Record<string, TranslationKey> = {
  activity_sweep: "eventName.activitySweep",
  arena: "eventName.arena",
  cafe_reward: "eventName.cafeReward",
  clear_special_task_power: "eventName.clearSpecialTaskPower",
  collect_daily_free_power: "eventName.collectDailyFreePower",
  collect_daily_power: "eventName.collectDailyPower",
  collect_reward: "eventName.collectReward",
  common_shop: "eventName.commonShop",
  create: "eventName.create",
  dailyGameActivity: "eventName.dailyGameActivity",
  friend: "eventName.friend",
  group: "eventName.group",
  hard_task: "eventName.hardTask",
  joint_firing_drill: "eventName.jointFiringDrill",
  lesson: "eventName.lesson",
  mail: "eventName.mail",
  momo_talk: "eventName.momoTalk",
  no1_cafe_invite: "eventName.no1CafeInvite",
  no2_cafe_invite: "eventName.no2CafeInvite",
  normal_task: "eventName.normalTask",
  pass: "eventName.pass",
  restart: "eventName.restart",
  rewarded_task: "eventName.rewardedTask",
  scrimmage: "eventName.scrimmage",
  start_explore_activity_challenge: "eventName.startExploreActivityChallenge",
  start_explore_activity_mission: "eventName.startExploreActivityMission",
  start_explore_activity_story: "eventName.startExploreActivityStory",
  start_fhx: "eventName.startFhx",
  start_group_story: "eventName.startGroupStory",
  start_hard_task: "eventName.startHardTask",
  start_main_story: "eventName.startMainStory",
  start_mini_story: "eventName.startMiniStory",
  start_normal_task: "eventName.startNormalTask",
  tactical_challenge_shop: "eventName.tacticalChallengeShop",
  total_assault: "eventName.totalAssault",
};

const propertyMap: Record<string, TranslationKey> = {
  ap: "property.ap",
  burst: "property.burst",
  coinArena: "property.coin.arena",
  coinCommission: "property.coin.commission",
  credits: "property.credits",
  keystone: "property.keystone",
  keystonePiece: "property.keystone.piece",
  mystic: "property.mystic",
  pass: "property.pass",
  pierce: "property.pierce",
  pyroxene: "property.pyroxene",
  shock: "property.shock",
  Unused: "property.unused",
};

const scheduleLevelMap: Record<string, TranslationKey> = {
  primary: "schedule.primary",
  normal: "schedule.normal",
  advanced: "schedule.advanced",
  superior: "schedule.superior",
};

const teamMethodMap: Record<string, TranslationKey> = {
  order: "team.order",
  preset: "team.preset",
  side: "team.side",
};

const shaMethodMap: Record<string, TranslationKey> = {
  gitee: "shaMethod.gitee",
  gitcode: "shaMethod.gitcode",
  github: "shaMethod.github",
  mirrorc: "shaMethod.mirrorc",
  tencent_c_coding: "shaMethod.tencentCoding",
};

const updateMethodMap: Record<string, TranslationKey> = {
  gitee: "updateMethod.gitee",
  gitcode: "updateMethod.gitcode",
  github: "updateMethod.github",
  mirrorc: "updateMethod.mirrorc",
  tencent_c_coding: "updateMethod.tencent",
};

const mirrorcMessageMap: Record<string, TranslationKey> = {
  "Please confirm that you have entered the correct cdkey": "mirrorc.message.confirmCdkey",
  "CDK valid. Expires at {}": "mirrorc.message.validExpires",
  "CDK expired.": "mirrorc.message.expired",
};

const themeMap: Record<string, TranslationKey> = {
  dark: "common.theme.dark",
  light: "common.theme.light",
  system: "common.theme.system",
};

const featureMap: Record<string, TranslationKey> = {
  arena: "arena",
  arenaDesc: "description.arena",
  artifact: "artifact",
  artifactDesc: "description.artifact",
  cafe: "cafe",
  cafeDesc: "description.cafe",
  dailySweep: "dailySweep",
  dailySweepDesc: "description.dailySweep",
  drill: "drill",
  drillDesc: "description.drill",
  emulator: "emulator",
  emulatorDesc: "description.emulator",
  other: "other",
  otherDesc: "description.other",
  push: "push",
  pushDesc: "description.push",
  schedule: "schedule",
  scheduleDesc: "description.schedule",
  script: "script",
  scriptDesc: "description.script",
  server: "server",
  serverDesc: "description.server",
  shop: "shop",
  shopDesc: "description.shop",
  stage: "stage",
  stageDesc: "description.stage",
  tactical: "tactical",
  tacticalDesc: "description.tactical",
  team: "team",
  teamDesc: "description.team",
  whitelist: "whitelist",
  whitelistDesc: "description.whitelist",
};

const wikiCategoryMap: Record<string, TranslationKey> = {
  all: "wiki.category.all",
  architecture: "wiki.category.architecture",
  configuration: "wiki.category.configuration",
  environment: "wiki.category.environment",
  formation: "wiki.category.formation",
  "getting-started": "wiki.category.getting-started",
  operations: "wiki.category.operations",
  support: "wiki.category.support",
};

export const artifactPhaseKey = (phase: number): TranslationKey =>
  i18nKey(`artifact.phase${phase}` as TranslationKey);

export const eventNameKey = (value: string | null | undefined): TranslationKey =>
  fromRecord(eventNameMap, value, "eventName.unknown");

export const featureTranslationKey = (value: string): TranslationKey =>
  fromRecord(featureMap, value, "nav.configuration");

export const mirrorcMessageKey = (value: string): TranslationKey =>
  fromRecord(mirrorcMessageMap, value, "mirrorc.message.confirmCdkey");

export const propertyKey = (value: string): TranslationKey =>
  fromRecord(propertyMap, value, "property.unused");

export const scheduleLevelKey = (value: string): TranslationKey =>
  fromRecord(scheduleLevelMap, value, "schedule.normal");

export const shaMethodKey = (value: string): TranslationKey =>
  fromRecord(shaMethodMap, value, "shaMethod.github");

export const teamMethodKey = (value: string): TranslationKey =>
  fromRecord(teamMethodMap, value, "team.preset");

export const themeKey = (value: string): TranslationKey =>
  fromRecord(themeMap, value, "common.theme.system");

export const updateMethodKey = (value: string): TranslationKey =>
  fromRecord(updateMethodMap, value, "updateMethod.github");

export const wikiCategoryKey = (value: string): TranslationKey =>
  fromRecord(wikiCategoryMap, value, "wiki.category.all");
