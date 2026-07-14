import type { TFunction } from "i18next";

export const SERVER_VALUES = {
  CN_OFFICIAL: "\u5b98\u670d",
  CN_BILIBILI: "B\u670d",
  GLOBAL: "\u56fd\u9645\u670d",
  GLOBAL_TEEN: "\u56fd\u9645\u670d\u9752\u5c11\u5e74",
  KR_ONE: "\u97e9\u56fdONE",
  JP: "\u65e5\u670d",
} as const;

export const buildServerOptions = (t: TFunction) => [
  { label: t("server.cn.official"), value: SERVER_VALUES.CN_OFFICIAL },
  { label: t("server.cn.bilibili"), value: SERVER_VALUES.CN_BILIBILI },
  { label: t("server.global"), value: SERVER_VALUES.GLOBAL },
  { label: t("server.global.teen"), value: SERVER_VALUES.GLOBAL_TEEN },
  { label: t("server.kr.one"), value: SERVER_VALUES.KR_ONE },
  { label: t("server.jp"), value: SERVER_VALUES.JP },
];
