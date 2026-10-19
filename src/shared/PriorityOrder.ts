/** Moves one entry without normalizing backend labels, duplicates or legacy values. */
export function movePriorityEntry<T>(items: readonly T[], from: number, to: number): T[] {
  const result = [...items];
  if (!Number.isInteger(from) || !Number.isInteger(to)) return result;
  if (from < 0 || from >= result.length || to < 0 || to >= result.length || from === to)
    return result;
  const [entry] = result.splice(from, 1);
  result.splice(to, 0, entry);
  return result;
}

/** An explicit checkbox edit only affects that node; unrecognized existing nodes survive. */
export function selectPriorityEntry(
  items: readonly string[],
  item: string,
  selected: boolean
): string[] {
  if (!selected) return items.filter((entry) => entry !== item);
  return items.includes(item) ? [...items] : [...items, item];
}

/** Insertion follows the centers of the other rows, including differently wrapped labels. */
export function priorityDropIndex(pointerY: number, otherRowCenters: readonly number[]): number {
  return otherRowCenters.filter((center) => pointerY > center).length;
}
