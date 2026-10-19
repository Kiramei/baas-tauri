export interface SettingsSearchSnapshot {
  query: string;
  focusedSource: string | null;
  activeIndex: number;
  matchCount: number;
  matchedSections: readonly string[];
  resultsQuery: string | null;
  selectionRevision: number;
}

/** Shared only for this window: desktop and compact navigation use the same search. */
export function createSettingsSearchStore() {
  let snapshot: SettingsSearchSnapshot = {
    query: "",
    focusedSource: null,
    activeIndex: 0,
    matchCount: 0,
    matchedSections: [],
    resultsQuery: null,
    selectionRevision: 0,
  };
  const listeners = new Set<() => void>();
  const update = (next: SettingsSearchSnapshot) => {
    if (
      next.query === snapshot.query &&
      next.focusedSource === snapshot.focusedSource &&
      next.activeIndex === snapshot.activeIndex &&
      next.matchCount === snapshot.matchCount &&
      next.resultsQuery === snapshot.resultsQuery &&
      next.matchedSections.join("\0") === snapshot.matchedSections.join("\0") &&
      next.selectionRevision === snapshot.selectionRevision
    )
      return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setQuery: (query: string) => {
      if (query === snapshot.query) return;
      update({
        ...snapshot,
        query,
        activeIndex: 0,
        matchCount: 0,
        matchedSections: [],
        resultsQuery: null,
      });
    },
    setMatches: (query: string, count: number, matchedSections: readonly string[] = []) => {
      // A paint from the previous query must not restore its selection/count.
      if (query !== snapshot.query) return;
      const matchCount = Math.max(0, Math.trunc(count));
      update({
        ...snapshot,
        matchCount,
        matchedSections,
        resultsQuery: query,
        activeIndex: Math.min(snapshot.activeIndex, Math.max(0, matchCount - 1)),
      });
    },
    moveSelection: (direction: number) => {
      if (!snapshot.matchCount || !snapshot.focusedSource) return;
      update({
        ...snapshot,
        activeIndex:
          (((snapshot.activeIndex + direction) % snapshot.matchCount) + snapshot.matchCount) %
          snapshot.matchCount,
        selectionRevision: snapshot.selectionRevision + 1,
      });
    },
    focus: (source: string) => update({ ...snapshot, focusedSource: source }),
    blur: (source: string) => {
      // The other responsive search may have taken focus before this one unmounts.
      if (snapshot.focusedSource === source) update({ ...snapshot, focusedSource: null });
    },
  };
}

export const settingsSearchStore = createSettingsSearchStore();

export function settingsSearchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map((term) => term.toLowerCase())
    ),
  ];
}

export interface SettingsSearchMatch {
  start: number;
  end: number;
}

/** Literal, case-insensitive matches; returned offsets always refer to the original text. */
export function findSettingsSearchMatches(text: string, query: string): SettingsSearchMatch[] {
  const matches: SettingsSearchMatch[] = [];
  for (const term of settingsSearchTerms(query)) {
    const literal = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(literal, "giu");
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text)) !== null) {
      matches.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: SettingsSearchMatch[] = [];
  for (const match of matches) {
    const previous = merged[merged.length - 1];
    if (previous && match.start <= previous.end) previous.end = Math.max(previous.end, match.end);
    else merged.push({ ...match });
  }
  return merged;
}
