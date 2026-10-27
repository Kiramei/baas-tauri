import type { TranslationKey } from "@/types/i18n";
import { APPLICATION_SHORTCUTS } from "@/shared/ApplicationShortcuts";
import { i18nKey } from "@/shared/I18nKeys";

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "settings.sections.general",
    keywords: [
      "language",
      "settings.ui.lowPerformanceMode",
      "settings.ui.enableSystemNotifications",
      "workflow.minimizeToTray",
    ],
  },
  {
    id: "appearance",
    label: "settings.sections.appearance",
    keywords: [
      "common.theme",
      "settings.ui.themeColor",
      "settings.ui.backgroundImage",
      "ui.zoom",
      "settings.ui.assets",
      "settings.ui.enableBAComet",
    ],
  },
  {
    id: "shortcuts",
    label: i18nKey("settings.sections.shortcuts"),
    keywords: [
      ...APPLICATION_SHORTCUTS.flatMap((shortcut) => [shortcut.label, shortcut.description]),
      "settings.shortcuts.application",
      "settings.shortcuts.global",
      "settings.shortcuts.profileRun",
      "settings.shortcuts.native",
      "edit.cut",
      "contextMenu.copy",
      "contextMenu.paste",
      "edit.selectAll",
      "common.delete",
      "common.cancel",
    ],
  },
  {
    id: "runtime",
    label: "settings.sections.runtime",
    keywords: ["transport.label", "settings.ui.player", "settings.ui.enableSafeStream"],
  },
  {
    id: "updates",
    label: "settings.sections.updates",
    keywords: [
      "about.backendCommit",
      "about.clientVersion",
      "update.settingsTitle",
      "update.method",
      "update.channel",
      "update.mirrorCdk",
      "update.shaConnectivityTest",
      "settings.ui.idleAutoUpdate",
    ],
  },
  {
    id: "logs",
    label: "settings.sections.logs",
    keywords: ["log.scroll.detail", "settings.systemLogs.title", "settings.systemLogs.description"],
  },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];
type SettingsSectionList = readonly {
  readonly id: SettingsSection;
  readonly label: TranslationKey;
  readonly keywords: readonly TranslationKey[];
}[];

export const ANDROID_SETTINGS_SECTIONS = SETTINGS_SECTIONS.filter(
  (section) => section.id !== "shortcuts"
);

const WEBUI_HIDDEN_KEYWORDS = new Set<TranslationKey>([
  "settings.ui.enableSystemNotifications",
  "workflow.minimizeToTray",
  "settings.shortcuts.global",
  "settings.shortcuts.profileRun",
  "transport.label",
  "about.clientVersion",
  "settings.ui.idleAutoUpdate",
]);

/** Browser settings retain backend diagnostics and local keyboard/appearance controls. */
export const WEBUI_SETTINGS_SECTIONS: SettingsSectionList = SETTINGS_SECTIONS.map((section) => ({
  ...section,
  keywords: [
    ...section.keywords.filter((key) => !WEBUI_HIDDEN_KEYWORDS.has(key)),
    ...(section.id === "general"
      ? (["auth.loginSettingsTitle", "auth.resetKey", "auth.passwordLabel"] as const)
      : []),
  ],
}));

/** Old or malformed persisted preferences safely fall back to the first section. */
export function resolveSettingsSection(
  value: unknown,
  sections: SettingsSectionList = SETTINGS_SECTIONS
) {
  return sections.find((section) => section.id === value) ?? sections[0] ?? SETTINGS_SECTIONS[0];
}

/** Search translated section names and the controls they contain. */
export function filterSettingsSections(
  query: string,
  translate: (key: TranslationKey) => string,
  sections: SettingsSectionList = SETTINGS_SECTIONS
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sections.filter((section) => {
    const text = [section.label, ...section.keywords]
      .map((key) => translate(key as TranslationKey))
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
