import type { TFunction } from "i18next";

export const SERVER_VALUES = {
  CN_OFFICIAL: "\u5b98\u670d",
  CN_BILIBILI: "B\u670d",
  GLOBAL: "\u56fd\u9645\u670d",
  GLOBAL_TEEN: "\u56fd\u9645\u670d\u9752\u5c11\u5e74",
  KR_ONE: "\u97e9\u56fdONE",
  JP: "\u65e5\u670d",
  JP_PC: "日服PC端",
  GLOBAL_PC: "Steam国际服",
} as const;

export const isPcServer = (server: unknown): boolean =>
  server === SERVER_VALUES.JP_PC || server === SERVER_VALUES.GLOBAL_PC;

/** A browser's operating system does not identify the remote WebUI backend. */
export const supportsPcServers = (
  environment = {
    tauri: typeof __WITH_TAURI__ !== "undefined" && __WITH_TAURI__,
    android: typeof __WITH_ANDROID__ !== "undefined" && __WITH_ANDROID__,
    platform: typeof navigator === "undefined" ? "" : navigator.platform,
  }
): boolean => environment.tauri && !environment.android && /^Win/i.test(environment.platform);

/** Keep imported PC profiles readable without offering unsupported new profiles. */
export const buildServerOptions = (
  t: TFunction,
  { includePc = false, selected }: { includePc?: boolean; selected?: string } = {}
) => [
  { label: t("server.cn.official"), value: SERVER_VALUES.CN_OFFICIAL },
  { label: t("server.cn.bilibili"), value: SERVER_VALUES.CN_BILIBILI },
  { label: t("server.global"), value: SERVER_VALUES.GLOBAL },
  { label: t("server.global.teen"), value: SERVER_VALUES.GLOBAL_TEEN },
  { label: t("server.kr.one"), value: SERVER_VALUES.KR_ONE },
  { label: t("server.jp"), value: SERVER_VALUES.JP },
  ...[
    { label: t("server.jpPc"), value: SERVER_VALUES.JP_PC },
    { label: t("server.globalPc"), value: SERVER_VALUES.GLOBAL_PC },
  ]
    .filter(({ value }) => includePc || value === selected)
    .map((option) => ({ ...option, disabled: !includePc })),
];
