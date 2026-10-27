import type { TranslationKey } from "@/types/i18n";

export type ConfigurationSection =
  | "cafe"
  | "schedule"
  | "shop"
  | "artifact"
  | "arena"
  | "dailySweep"
  | "tactical"
  | "finalRestrictionRls"
  | "drill"
  | "whitelist"
  | "server"
  | "script"
  | "emulator"
  | "stage"
  | "team"
  | "push"
  | "other";

export type ConfigurationPlatform = "desktop" | "android" | "webui";

export interface ConfigurationSearchTab {
  readonly value: string;
  readonly title: TranslationKey;
  readonly keywords: readonly TranslationKey[];
}

export interface ConfigurationSectionDefinition {
  readonly id: ConfigurationSection;
  readonly group: "feature" | "general";
  readonly title: TranslationKey;
  readonly description: TranslationKey;
  readonly keywords: readonly TranslationKey[];
  readonly tabs?: readonly ConfigurationSearchTab[];
}

const CAFE_BASIC_HELP: readonly TranslationKey[] = [
  "configurationHelp.cafeCollectReward",
  "configurationHelp.cafeUseInvitation",
  "configurationHelp.cafeExchangeStudent",
  "configurationHelp.cafeDuplicateInvite",
  "configurationHelp.cafeSecondCafe",
  "description.cafe.patRounds",
  "configurationHelp.cafePatStyle",
];
const CAFE_INVITATION_HELP: readonly TranslationKey[] = [
  "configurationHelp.cafeInviteMode",
  "configurationHelp.cafeStarredPosition",
  "configurationHelp.cafeStudents",
];
const ARTIFACT_GLOBAL_HELP: readonly TranslationKey[] = [
  "configurationHelp.artifactUseTicket",
  "configurationHelp.artifactCreateTimes",
  "configurationHelp.artifactPhases",
];
const ARTIFACT_PRIORITY_HELP: readonly TranslationKey[] = [
  "configurationHelp.artifactMaterialRule",
  "friendlyPriority.reorderHint",
  "friendlyPriority.selectNodes",
  "friendlyPriority.searchNodes",
  "friendlyPriority.keyboardHint",
  "friendlyPriority.emptyPriority",
];
const DAILY_SWEEP_PLAN_HELP: readonly TranslationKey[] = [
  "configurationHelp.normalSweepPlan",
  "configurationHelp.hardSweepPlan",
  "sweepPlan.chapter",
  "sweepPlan.mission",
  "sweepPlan.count",
  "sweepPlan.countMode",
  "sweepPlan.fixedCount",
  "sweepPlan.maximum",
  "sweepPlan.add",
  "sweepPlan.empty",
  "sweepPlan.maxUnsupported",
];
const DAILY_SWEEP_COUNT_HELP: readonly TranslationKey[] = [
  "configurationHelp.sweepTicketsTitle",
  "configurationHelp.sweepPurchaseRewarded",
  "configurationHelp.sweepPurchaseLesson",
  "configurationHelp.sweepPurchaseScrimmage",
  "configurationCounts.mode",
  "configurationCounts.skip",
  "configurationCounts.fixed",
  "configurationCounts.all",
  "configurationCounts.amount",
  "configurationCounts.share",
  "configurationCounts.allActivity",
  "configurationCounts.countHint",
  "configurationCounts.activityHint",
  "configurationCounts.activityEntry",
  "configurationCounts.bountyOverpass",
  "configurationCounts.bountyRailroad",
  "configurationCounts.bountyClassroom",
  "configurationCounts.scrimmageTrinity",
  "configurationCounts.scrimmageGehenna",
  "configurationCounts.scrimmageMillennium",
  "configurationCounts.specialDefense",
  "configurationCounts.specialRetrieval",
  "configurationCounts.maximumPurchases",
];
const EXPLORE_PLAN_HELP: readonly TranslationKey[] = [
  "configurationHelp.manualBoss",
  "friendlyPriority.chapter",
  "friendlyPriority.chapterLabel",
  "friendlyPriority.mission",
  "friendlyPriority.missionLabel",
  "friendlyPriority.missionA",
  "friendlyPriority.wholeChapter",
  "friendlyPriority.addChapter",
  "friendlyPriority.emptyExplore",
];
const EVENT_HELP: readonly TranslationKey[] = [
  "property.burst",
  "property.pierce",
  "property.mystic",
  "property.shock",
];

/** Searchable configuration panels, in the same order as the profile's navigation. */
export const CONFIGURATION_SECTIONS: readonly ConfigurationSectionDefinition[] = [
  {
    id: "cafe",
    group: "feature",
    title: "cafe",
    description: "description.cafe",
    tabs: [
      {
        value: "basic",
        title: "cafe.basicSettings",
        keywords: [
          "cafe.collectReward",
          "cafe.useInvitation",
          "cafe.exchangeStudent",
          "cafe.duplicateInvite",
          "cafe.hasNo2Cafe",
          "cafe.patRounds",
          "cafe.patStyle",
          "cafe.patStyleDragGift",
          ...CAFE_BASIC_HELP,
        ],
      },
      {
        value: "cafe1",
        title: "cafe.cafe1Settings",
        keywords: [
          "cafe.invite1Mode",
          "cafe.lowestAffection",
          "cafe.highestAffection",
          "cafe.starred",
          "cafe.starredPosition",
          "cafe.byName",
          "cafe.cafe1Students",
          ...CAFE_INVITATION_HELP,
        ],
      },
      {
        value: "cafe2",
        title: "cafe.cafe2Settings",
        keywords: [
          "cafe.invite2Mode",
          "cafe.lowestAffection",
          "cafe.highestAffection",
          "cafe.starred",
          "cafe.starredPosition",
          "cafe.byName",
          "cafe.cafe2Students",
          ...CAFE_INVITATION_HELP,
        ],
      },
    ],
    keywords: [
      "cafe.collectReward",
      "cafe.useInvitation",
      "cafe.exchangeStudent",
      "cafe.duplicateInvite",
      "cafe.hasNo2Cafe",
      "cafe.patRounds",
      "cafe.patStyle",
      "cafe.patStyleDragGift",
      "cafe.invite1Mode",
      "cafe.lowestAffection",
      "cafe.highestAffection",
      "cafe.starred",
      "cafe.starredPosition",
      "cafe.byName",
      "cafe.cafe1Students",
    ],
  },
  {
    id: "schedule",
    group: "feature",
    title: "schedule",
    description: "description.schedule",
    keywords: [
      "lesson.enableFavorStudent",
      "lesson.relationshipFirst",
      "lesson.favorStudent",
      "lesson.region",
      "lesson.times",
      "schedule.primary",
      "schedule.normal",
      "schedule.advanced",
      "schedule.superior",
      "configurationHelp.lessonFavorEnabled",
      "configurationHelp.lessonRelationshipFirst",
      "configurationHelp.lessonFavorOrder",
      "configurationHelp.lessonRegionTable",
      "configurationHelp.lessonRegionTableHint",
    ],
  },
  {
    id: "shop",
    group: "feature",
    title: "shop",
    description: "description.shop",
    tabs: [
      {
        value: "common",
        title: "commonShop.title",
        keywords: [
          "commonShop.refreshTimes",
          "description.commonShop.refresh",
          "property.credits",
          "property.pyroxene",
        ],
      },
      {
        value: "tactical",
        title: "tacticalShop.title",
        keywords: [
          "commonShop.refreshTimes",
          "description.commonShop.refresh",
          "property.coin.arena",
        ],
      },
    ],
    keywords: [
      "commonShop.title",
      "tacticalShop.title",
      "commonShop.refreshTimes",
      "description.commonShop.refresh",
      "property.credits",
      "property.pyroxene",
      "property.coin.arena",
      "property.coin.commission",
    ],
  },
  {
    id: "artifact",
    group: "feature",
    title: "artifact",
    description: "description.artifact",
    tabs: [
      {
        value: "global",
        title: "artifact.global",
        keywords: [
          "description.artifact.useTicket",
          "artifact.createTime",
          "artifact.phaseCount",
          ...ARTIFACT_GLOBAL_HELP,
        ],
      },
      {
        value: "phase1",
        title: "artifact.phase1",
        keywords: [
          "artifact.materialSelect",
          "artifact.priority",
          "artifact.default",
          ...ARTIFACT_PRIORITY_HELP,
        ],
      },
      {
        value: "phase2",
        title: "artifact.phase2",
        keywords: [
          "artifact.materialSelect",
          "artifact.priority",
          "artifact.phase2.recommend",
          "artifact.selectStudent",
          "artifact.white",
          "artifact.blue",
          "artifact.gold",
          "artifact.purple",
          "artifact.whiteBlue",
          "artifact.goldPurple",
          "artifact.all",
          ...ARTIFACT_PRIORITY_HELP,
          "configurationHelp.artifactRecommendedPriority",
        ],
      },
      {
        value: "phase3",
        title: "artifact.phase3",
        keywords: [
          "artifact.materialSelect",
          "artifact.priority",
          "artifact.gold",
          "artifact.purple",
          "artifact.goldPurple",
          ...ARTIFACT_PRIORITY_HELP,
        ],
      },
    ],
    keywords: [
      "description.artifact.useTicket",
      "artifact.createTime",
      "artifact.phaseCount",
      "artifact.materialSelect",
      "artifact.priority",
      "artifact.phase1",
      "artifact.phase2",
      "artifact.phase3",
      "artifact.phase2.recommend",
      "artifact.selectStudent",
      "artifact.white",
      "artifact.blue",
      "artifact.gold",
      "artifact.purple",
    ],
  },
  {
    id: "arena",
    group: "feature",
    title: "arena",
    description: "description.arena",
    keywords: [
      "arena.higherLevel",
      "arena.maxRefreshTimes",
      "arena.opponentNo",
      "configurationHelp.arenaLevel",
      "configurationHelp.arenaRefresh",
      "configurationHelp.arenaOpponent",
    ],
  },
  {
    id: "dailySweep",
    group: "feature",
    title: "dailySweep",
    description: "description.dailySweep",
    tabs: [
      {
        value: "daily",
        title: "stage.dailyTab",
        keywords: ["stage.normalLabel", "stage.hardLabel", ...DAILY_SWEEP_PLAN_HELP],
      },
      {
        value: "sweep",
        title: "stage.sweepTab",
        keywords: [
          "sweep.rewarded",
          "sweep.rewardedRegion",
          "sweep.scrimmage",
          "sweep.activityNumber",
          "sweep.activityTimes",
          "sweep.special",
          "sweep.purchaseRewarded",
          "sweep.purchaseLesson",
          "sweep.purchaseScrimmage",
          ...DAILY_SWEEP_COUNT_HELP,
        ],
      },
    ],
    keywords: [
      "stage.normalLabel",
      "stage.hardLabel",
      "sweep.rewarded",
      "sweep.rewardedRegion",
      "sweep.scrimmage",
      "sweep.activityNumber",
      "sweep.activityTimes",
      "sweep.special",
      "sweep.purchaseRewarded",
      "sweep.purchaseLesson",
      "sweep.purchaseScrimmage",
    ],
  },
  {
    id: "tactical",
    group: "feature",
    title: "tactical",
    description: "description.tactical",
    keywords: ["tactical.hardLevel", "configurationHelp.tacticalDifficulty"],
  },
  {
    id: "finalRestrictionRls",
    group: "feature",
    title: "finalRestrictionRls",
    description: "description.finalRestrictionRls",
    keywords: [
      "finalRestrictionRls.formationMethod",
      "finalRestrictionRls.copyClearFormation",
      "finalRestrictionRls.useCurrentFormation",
      "finalRestrictionRls.maxRefreshCount",
      "finalRestrictionRls.maxUnavailableStudentCount",
      "configurationHelp.finalMethod",
      "configurationHelp.finalUnavailable",
      "configurationHelp.finalRefresh",
    ],
  },
  {
    id: "drill",
    group: "feature",
    title: "drill",
    description: "description.drill",
    keywords: [
      "drill.useAllAfterSweep",
      "drill.outPartyNo",
      "drill.difficulty",
      "configurationHelp.drillSweep",
      "configurationHelp.drillFormation",
      "configurationHelp.drillDifficulty",
    ],
  },
  {
    id: "whitelist",
    group: "feature",
    title: "whitelist",
    description: "description.whitelist",
    keywords: [
      "friend.filters",
      "friend.levelLimit",
      "friend.lastLoginDays",
      "friend.lastTotalAssaultRankLimit",
      "friend.whitelist",
      "friend.placeholder",
      "configurationHelp.friendLevel",
      "configurationHelp.friendLogin",
      "configurationHelp.friendRank",
      "configurationHelp.friendCode",
      "configurationHelp.friendWhitelist",
    ],
  },
  {
    id: "server",
    group: "general",
    title: "server",
    description: "description.server",
    keywords: [
      "server.server",
      "server.adbIP",
      "server.adbPort",
      "server.cn.bilibili",
      "server.cn.official",
      "server.global",
      "server.global.teen",
      "server.jp",
      "server.kr.one",
      "adb.detectBtn",
      "configurationHelp.server",
      "configurationHelp.adbAddress",
      "configurationHelp.adbPort",
    ],
  },
  {
    id: "script",
    group: "general",
    title: "script",
    description: "description.script",
    keywords: [
      "script.screenshotInterval",
      "script.screenshotMethod",
      "script.controlMethod",
      "script.autostart",
      "script.then",
      "script.doNothing",
      "script.exitBaas",
      "script.exitEmu",
      "script.exitBoth",
      "script.shutdown",
      "configurationHelp.scriptAutostart",
      "configurationHelp.scriptThen",
      "configurationHelp.screenshotInterval",
      "configurationHelp.screenshotMethod",
      "configurationHelp.controlMethod",
    ],
  },
  {
    id: "emulator",
    group: "general",
    title: "emulator",
    description: "description.emulator",
    keywords: [
      "emulator.openOnLaunch",
      "emulator.multiInstance",
      "emulator.waitTime",
      "emulator.address",
      "emulator.multiType",
      "emulator.instanceCount",
      "emulator.types.bluestacksCn",
      "emulator.types.bluestacksGlobal",
      "emulator.types.leidian",
      "emulator.types.mumu",
      "emulator.types.mumuGlobal",
      "emulator.types.wsa",
      "emulator.types.xiaoyaoNat",
      "emulator.types.yeshen",
      "configurationHelp.emulatorLaunch",
      "configurationHelp.emulatorWait",
      "configurationHelp.emulatorMulti",
      "configurationHelp.emulatorPath",
      "configurationHelp.emulatorInstance",
    ],
  },
  {
    id: "stage",
    group: "general",
    title: "stage",
    description: "description.stage",
    tabs: [
      {
        value: "explore",
        title: "stage.exploreTab",
        keywords: [
          "stage.manualBoss",
          "stage.story.main",
          "stage.story.group",
          "stage.story.mini",
          "stage.normalTask",
          "stage.hardTask",
          ...EXPLORE_PLAN_HELP,
        ],
      },
      {
        value: "event",
        title: "stage.eventTab",
        keywords: [
          "stage.currentEvent",
          "stage.story",
          "stage.mission",
          "stage.challenge",
          "stage.attrTable",
          ...EVENT_HELP,
        ],
      },
    ],
    keywords: [
      "stage.exploreTab",
      "stage.eventTab",
      "stage.manualBoss",
      "stage.story.main",
      "stage.story.group",
      "stage.story.mini",
      "stage.normalTask",
      "stage.hardTask",
      "stage.currentEvent",
      "stage.story",
      "stage.mission",
      "stage.challenge",
      "stage.attrTable",
    ],
  },
  {
    id: "team",
    group: "general",
    title: "team",
    description: "description.team",
    keywords: [
      "team.chooseMethod",
      "team.order",
      "team.preset",
      "team.side",
      "configurationHelp.teamMethod",
      "configurationHelp.teamPreset",
      "configurationHelp.teamSide",
    ],
  },
  {
    id: "push",
    group: "general",
    title: "push",
    description: "description.push",
    keywords: [
      "push.afterError",
      "push.afterCompletion",
      "push.json",
      "push.serverchan",
      "configurationHelp.pushError",
      "configurationHelp.pushCompletion",
      "configurationHelp.pushJson",
      "configurationHelp.pushServerchan",
    ],
  },
  {
    id: "other",
    group: "general",
    title: "other",
    description: "description.other",
    keywords: ["other.fhx", "description.other.fhx"],
  },
];

// Android runs on this device through android_local; it has no emulator setup or method selector.
const ANDROID_HIDDEN_SCRIPT_KEYWORDS = new Set<TranslationKey>([
  "script.screenshotMethod",
  "script.controlMethod",
  "configurationHelp.screenshotMethod",
  "configurationHelp.controlMethod",
]);
const ANDROID_CONFIGURATION_SECTIONS = CONFIGURATION_SECTIONS.filter(
  (section) => section.id !== "emulator"
).map((section) =>
  section.id === "script"
    ? {
        ...section,
        keywords: section.keywords.filter((key) => !ANDROID_HIDDEN_SCRIPT_KEYWORDS.has(key)),
      }
    : section
);

const WEBUI_HIDDEN_SCRIPT_KEYWORDS = new Set<TranslationKey>([
  "script.then",
  "script.doNothing",
  "script.exitBaas",
  "script.exitEmu",
  "script.exitBoth",
  "script.shutdown",
  "configurationHelp.scriptThen",
]);
const WEBUI_CONFIGURATION_SECTIONS = CONFIGURATION_SECTIONS.filter(
  (section) => section.id !== "emulator"
).map((section) =>
  section.id === "script"
    ? {
        ...section,
        keywords: section.keywords.filter((key) => !WEBUI_HIDDEN_SCRIPT_KEYWORDS.has(key)),
      }
    : section
);

/** The platform catalog is shared by navigation, search and the mounted editor list. */
export function getConfigurationSections(
  platform: ConfigurationPlatform = "desktop"
): readonly ConfigurationSectionDefinition[] {
  if (platform === "android") return ANDROID_CONFIGURATION_SECTIONS;
  if (platform === "webui") return WEBUI_CONFIGURATION_SECTIONS;
  return CONFIGURATION_SECTIONS;
}

/** Unknown, removed or platform-unavailable selections open the first supported panel. */
export function resolveConfigurationSection(
  value: unknown,
  platform: ConfigurationPlatform = "desktop"
): ConfigurationSectionDefinition {
  const sections = getConfigurationSections(platform);
  return sections.find((section) => section.id === value) ?? sections[0];
}

/** Match every query term against the current language's panel and control names. */
export function filterConfigurationSections(
  query: string,
  translate: (key: TranslationKey) => string,
  platform: ConfigurationPlatform = "desktop"
): ConfigurationSectionDefinition[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return getConfigurationSections(platform).filter((section) => {
    const text = [
      section.title,
      section.description,
      ...section.keywords,
      ...(section.tabs?.flatMap((tab) => [tab.title, ...tab.keywords]) ?? []),
    ]
      .map((key) => translate(key))
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** Resolve only the view tab; unavailable conditional tabs must be ignored by the caller. */
export function resolveConfigurationSearchTab(
  sectionId: ConfigurationSection | string,
  query: string,
  translate: (key: TranslationKey) => string,
  platform: ConfigurationPlatform = "desktop"
): string | null {
  const section = getConfigurationSections(platform).find(({ id }) => id === sectionId);
  const normalized = query.trim().toLocaleLowerCase();
  if (!section?.tabs || !normalized) return null;
  const title = translate(section.title).toLocaleLowerCase();
  const description = translate(section.description).toLocaleLowerCase();
  // Searching a panel name or its overview must preserve the user's tab selection.
  if (normalized === description) return null;
  const terms = normalized.split(/\s+/).filter(Boolean);
  const specificTerms = terms.filter((term) => !title.includes(term));
  if (specificTerms.length === 0) return null;

  let match: { value: string; score: number } | null = null;
  for (const tab of section.tabs) {
    const tabTitle = translate(tab.title).toLocaleLowerCase();
    const controls = tab.keywords.map((key) => translate(key).toLocaleLowerCase());
    const text = [tabTitle, ...controls].join(" ");
    const combined = `${title} ${description} ${text}`;
    if (!terms.every((term) => combined.includes(term))) continue;
    if (!specificTerms.some((term) => text.includes(term))) continue;
    // An explicit tab name wins over a shared control label, e.g. Cafe 2 invitations.
    const score =
      (tabTitle === normalized ? 40 : 0) +
      (controls.includes(normalized) ? 20 : 0) +
      specificTerms.reduce(
        (sum, term) => sum + (tabTitle.includes(term) ? 2 : 0) + (text.includes(term) ? 1 : 0),
        0
      );
    if (!match || score > match.score) match = { value: tab.value, score };
  }
  return match?.value ?? null;
}
