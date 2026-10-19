/** Expand old short arrays only when a user selects a later slot; never serialize array holes. */
export function toggleShopSlot(selection: readonly number[], index: number): number[] {
  const next = [...selection];
  if (!Number.isSafeInteger(index) || index < 0) return next;
  while (next.length <= index) next.push(0);
  next[index] = Number(next[index] !== 1);
  return next;
}
