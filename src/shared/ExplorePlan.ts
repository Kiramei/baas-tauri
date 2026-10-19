/** The exploration API is a comma-separated sequence of chapters or chapter-mission tokens. */
export interface ExplorePlanEntry {
  readonly raw: string;
  readonly chapter: number | null;
  /** all expands the chapter; unsupported legacy mission values remain intact. */
  readonly mission: string | null;
}
export type ExplorePlanMode = "normal" | "hard";

/** Keep raw spelling and whitespace so inspecting a legacy plan never rewrites it. */
export function parseExplorePlan(value: string): ExplorePlanEntry[] {
  if (value === "") return [];
  return value.split(",").map((raw) => {
    const match = /^(\d+)(?:-(\d+|A))?$/.exec(raw.trim());
    const chapter = match ? Number(match[1]) : NaN;
    return match && Number.isSafeInteger(chapter) && chapter > 0
      ? { raw, chapter, mission: match[2] ?? "all" }
      : { raw, chapter: null, mission: null };
  });
}
export function serializeExplorePlan(entries: readonly ExplorePlanEntry[]): string {
  return entries.map(({ raw }) => raw).join(",");
}
export function exploreMissionChoices(chapter: number, mode: ExplorePlanMode): string[] {
  const choices = [
    "all",
    ...Array.from({ length: mode === "normal" ? 5 : 3 }, (_, index) => String(index + 1)),
  ];
  if (mode === "normal" && chapter % 3 === 0) choices.push("A");
  return choices;
}
export function createExplorePlanEntry(
  chapter: number,
  mission: string,
  mode: ExplorePlanMode
): ExplorePlanEntry | null {
  if (
    !Number.isSafeInteger(chapter) ||
    chapter < 1 ||
    !exploreMissionChoices(chapter, mode).includes(mission)
  )
    return null;
  return { raw: mission === "all" ? String(chapter) : `${chapter}-${mission}`, chapter, mission };
}
