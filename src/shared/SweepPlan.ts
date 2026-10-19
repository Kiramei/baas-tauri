export type SweepPlanMode = "normal" | "hard";
export type SweepPlanError = "format" | "chapter" | "mission" | "count" | "maxUnsupported";
export interface SweepPlanOptions {
  mode?: SweepPlanMode;
  server?: string;
  maxChapter?: number;
}
export interface SweepPlanStage {
  kind: "stage";
  chapter: number;
  mission: number;
  count: number | "max";
}
export interface SweepPlanInvalid {
  kind: "invalid";
  raw: string;
  error: SweepPlanError;
}
export type SweepPlanItem = SweepPlanStage | SweepPlanInvalid;

export function normalizeSweepPlanValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
  return value == null ? "" : String(value);
}

export function sweepPlanAllowsMax(mode: SweepPlanMode, server: string): boolean {
  return mode !== "hard" || !/^(?:CN|B服|官服)$/i.test(server.trim());
}

/** Unknown entries remain explicit rows, so opening an older plan can never erase data. */
export function parseSweepPlan(value: unknown, options: SweepPlanOptions = {}): SweepPlanItem[] {
  const source = normalizeSweepPlanValue(value);
  if (!source.trim()) return [];
  const missionLimit = options.mode === "hard" ? 3 : 5;
  const maxChapter = options.maxChapter;
  return source.split(",").map((entry): SweepPlanItem => {
    const raw = entry.trim();
    const match = /^(\d+)\s*-\s*(\d+)\s*-\s*([^-]*)$/.exec(raw);
    if (!match) return { kind: "invalid", raw, error: "format" };
    const chapter = Number(match[1]);
    const mission = Number(match[2]);
    const count = match[3].trim().toLowerCase();
    if (
      !Number.isSafeInteger(chapter) ||
      chapter < 1 ||
      (typeof maxChapter === "number" &&
        Number.isSafeInteger(maxChapter) &&
        maxChapter > 0 &&
        chapter > maxChapter)
    )
      return { kind: "invalid", raw, error: "chapter" };
    if (!Number.isSafeInteger(mission) || mission < 1 || mission > missionLimit)
      return { kind: "invalid", raw, error: "mission" };
    if (count === "max") {
      if (!sweepPlanAllowsMax(options.mode ?? "normal", options.server ?? ""))
        return { kind: "invalid", raw, error: "maxUnsupported" };
      return { kind: "stage", chapter, mission, count: "max" };
    }
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)))
      return { kind: "invalid", raw, error: "count" };
    return { kind: "stage", chapter, mission, count: Number(count) };
  });
}

export function serializeSweepPlan(items: readonly SweepPlanItem[]): string {
  return items
    .map((item) =>
      item.kind === "invalid" ? item.raw : [item.chapter, item.mission, item.count].join("-")
    )
    .join(", ");
}

export function isSweepPlanValid(value: unknown, options: SweepPlanOptions = {}): boolean {
  return parseSweepPlan(value, options).every((item) => item.kind === "stage");
}

/** Append every student drop stage once, retaining existing counts, order, and unknown tokens. */
export function appendSweepStages(
  value: string,
  stages: readonly string[],
  defaultCount = 3
): string {
  const items = parseSweepPlan(value);
  const existing = new Set<string>();
  for (const item of items) {
    if (item.kind === "stage") existing.add(item.chapter + "-" + item.mission);
    else {
      const match = /^(\d+)\s*-\s*(\d+)\s*-/.exec(item.raw);
      if (match) existing.add(Number(match[1]) + "-" + Number(match[2]));
    }
  }
  const count = Number.isSafeInteger(defaultCount) && defaultCount >= 0 ? defaultCount : 3;
  for (const stage of stages) {
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(stage.trim());
    if (!match) continue;
    const chapter = Number(match[1]);
    const mission = Number(match[2]);
    if (
      !Number.isSafeInteger(chapter) ||
      chapter < 1 ||
      !Number.isInteger(mission) ||
      mission < 1 ||
      mission > 5
    )
      continue;
    const id = chapter + "-" + mission;
    if (existing.has(id)) continue;
    existing.add(id);
    items.push({ kind: "stage", chapter, mission, count });
  }
  return serializeSweepPlan(items);
}
