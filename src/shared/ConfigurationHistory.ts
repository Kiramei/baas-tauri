import type { ConfigurationSection } from "./ConfigurationSections";

export type ConfigurationValues = Record<string, unknown>;
export type ConfigurationSerializer<T> = (draft: T) => ConfigurationValues | null;
export type ConfigurationDraftUpdate<T> = T | ((previous: T) => T);

export interface ConfigurationHistorySnapshot {
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

interface DraftEntry {
  draft: unknown;
  source: unknown;
  persisted: ConfigurationValues | null;
  sent: { values: ConfigurationValues; patch: ConfigurationValues }[];
  serialize: ConfigurationSerializer<unknown>;
}

interface Change {
  section: ConfigurationSection;
  before: unknown;
  after: unknown;
  beforeValues: ConfigurationValues | null;
  afterValues?: ConfigurationValues | null;
  keys: readonly string[];
}

interface ProfileHistory {
  entries: Map<ConfigurationSection, DraftEntry>;
  past: Change[];
  future: Change[];
  pending: Change | null;
  timer: unknown;
  listeners: Set<() => void>;
  snapshot: ConfigurationHistorySnapshot;
}

const EMPTY_SNAPSHOT: ConfigurationHistorySnapshot = {
  revision: 0,
  canUndo: false,
  canRedo: false,
};

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function changedKeys(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return ["$"];
  const left = before as ConfigurationValues;
  const right = after as ConfigurationValues;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => !equal(left[key], right[key]))
    .sort();
}

export function serializeConfigurationDraft<T>(draft: T): ConfigurationValues | null {
  return draft !== null && typeof draft === "object" && !Array.isArray(draft)
    ? { ...(draft as ConfigurationValues) }
    : null;
}

/** Per-window, per-profile history. Only explicit edits and history actions can persist data. */
export class ConfigurationHistory {
  private readonly profiles = new Map<string, ProfileHistory>();
  private readonly persist: (profileId: string, patch: ConfigurationValues) => void;
  private readonly delayMs: number;
  private readonly limit: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  constructor(options: {
    persist: (profileId: string, patch: ConfigurationValues) => void;
    delayMs?: number;
    limit?: number;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (timer: unknown) => void;
  }) {
    this.persist = options.persist;
    this.delayMs = options.delayMs ?? 300;
    this.limit = options.limit ?? 100;
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel =
      options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  private profile(profileId: string): ProfileHistory {
    let profile = this.profiles.get(profileId);
    if (!profile) {
      profile = {
        entries: new Map(),
        past: [],
        future: [],
        pending: null,
        timer: null,
        listeners: new Set(),
        snapshot: EMPTY_SNAPSHOT,
      };
      this.profiles.set(profileId, profile);
    }
    return profile;
  }

  private publish(profile: ProfileHistory) {
    profile.snapshot = {
      revision: profile.snapshot.revision + 1,
      canUndo: profile.pending !== null || profile.past.length > 0,
      canRedo: profile.future.length > 0,
    };
    for (const listener of profile.listeners) listener();
  }

  private stopTimer(profile: ProfileHistory) {
    if (profile.timer !== null) this.cancel(profile.timer);
    profile.timer = null;
  }

  private serialized(entry: DraftEntry): ConfigurationValues | null {
    try {
      return entry.serialize(entry.draft);
    } catch {
      // Invalid or temporarily incomplete input must never become a backend patch.
      return null;
    }
  }

  private persistValues(profileId: string, entry: DraftEntry, next: ConfigurationValues | null) {
    if (next === null) return;
    const patch = Object.fromEntries(
      Object.entries(next).filter(([key, value]) => !equal(value, entry.persisted?.[key]))
    );
    if (Object.keys(patch).length === 0) return;
    this.persist(profileId, patch);
    entry.persisted = { ...next };
    entry.sent.push({ values: entry.persisted, patch });
    if (entry.sent.length > this.limit) entry.sent.shift();
  }

  private persistEntry(profileId: string, entry: DraftEntry) {
    this.persistValues(profileId, entry, this.serialized(entry));
  }

  /** Registering an editor never sends its initial values to the backend. */
  ensure<T>(
    profileId: string,
    section: ConfigurationSection,
    initial: T,
    serialize: ConfigurationSerializer<T> = serializeConfigurationDraft
  ): void {
    if (!profileId) return;
    const profile = this.profile(profileId);
    const existing = profile.entries.get(section);
    if (existing) {
      existing.serialize = serialize as ConfigurationSerializer<unknown>;
      return;
    }
    const entry: DraftEntry = {
      draft: initial,
      source: initial,
      persisted: null,
      sent: [],
      serialize: serialize as ConfigurationSerializer<unknown>,
    };
    entry.persisted = this.serialized(entry);
    profile.entries.set(section, entry);
  }

  getDraft<T>(profileId: string, section: ConfigurationSection, fallback: T): T {
    const entry = this.profiles.get(profileId)?.entries.get(section);
    return entry ? (entry.draft as T) : fallback;
  }

  /** Adopt external updates only when this editor has no uncommitted local value. */
  syncSource<T>(profileId: string, section: ConfigurationSection, initial: T): void {
    const profile = this.profiles.get(profileId);
    const entry = profile?.entries.get(section);
    if (!profile || !entry || equal(entry.source, initial)) return;
    const previousSource = entry.source;
    entry.source = initial;
    let incoming: ConfigurationValues | null;
    try {
      incoming = entry.serialize(initial);
    } catch {
      return;
    }
    let previousValues: ConfigurationValues | null = null;
    try {
      previousValues = entry.serialize(previousSource);
    } catch {
      // A formerly invalid draft has no trustworthy serialized source snapshot.
    }
    const fields = changedKeys(previousValues, incoming);
    // ACKs can arrive as independently merged sparse patches, in either field order.
    const ownFields =
      previousValues !== null &&
      incoming !== null &&
      fields.length > 0 &&
      fields.every(
        (key) =>
          equal(incoming?.[key], entry.persisted?.[key]) ||
          entry.sent.some(
            ({ patch }) => Object.hasOwn(patch, key) && equal(patch[key], incoming?.[key])
          )
      );
    // Delayed ACKs for earlier edits must not replace a newer local draft or erase history.
    const acknowledged = entry.sent.some(({ values }) => equal(incoming, values));
    entry.sent = entry.sent.flatMap(({ values, patch }) => {
      const remaining = Object.fromEntries(
        Object.entries(patch).filter(([key, value]) => !equal(value, incoming?.[key]))
      );
      return Object.keys(remaining).length ? [{ values, patch: remaining }] : [];
    });
    // Own ACKs retain UI representations such as a numeric string or edited text.
    if (acknowledged || ownFields || equal(incoming, entry.persisted)) return;
    if (profile.pending?.section === section || !equal(this.serialized(entry), entry.persisted))
      return;
    entry.draft = initial;
    entry.persisted = incoming;
    // A remote replacement makes snapshots for this panel stale; other panels keep history.
    profile.past = profile.past.filter((change) => change.section !== section);
    profile.future = profile.future.filter((change) => change.section !== section);
    this.publish(profile);
  }

  update<T>(profileId: string, section: ConfigurationSection, update: ConfigurationDraftUpdate<T>) {
    const profile = this.profiles.get(profileId);
    const entry = profile?.entries.get(section);
    if (!profile || !entry) return;
    const previous = entry.draft as T;
    const next = typeof update === "function" ? (update as (draft: T) => T)(previous) : update;
    if (equal(next, previous)) return;
    const keys = changedKeys(previous, next);
    if (
      profile.pending &&
      (profile.pending.section !== section || !equal(profile.pending.keys, keys))
    )
      this.flush(profileId);
    const before = profile.pending?.before ?? previous;
    const beforeValues = profile.pending?.beforeValues ?? entry.persisted;
    entry.draft = next;
    profile.future = [];
    this.stopTimer(profile);
    profile.pending = equal(before, next)
      ? null
      : { section, before, after: next, beforeValues, keys };
    if (profile.pending) {
      profile.timer = this.schedule(() => this.flush(profileId, section), this.delayMs);
    }
    this.publish(profile);
  }

  flush(profileId: string, section?: ConfigurationSection): void {
    const profile = this.profiles.get(profileId);
    const change = profile?.pending;
    if (!profile || !change || (section && change.section !== section)) return;
    this.stopTimer(profile);
    profile.pending = null;
    const entry = profile.entries.get(change.section)!;
    profile.past.push(change);
    if (profile.past.length > this.limit) profile.past.shift();
    this.persistEntry(profileId, entry);
    change.afterValues = entry.persisted;
    this.publish(profile);
  }

  undo(profileId: string): ConfigurationSection | undefined {
    const profile = this.profiles.get(profileId);
    const change = profile?.pending ?? profile?.past.pop();
    if (!profile || !change) return;
    this.stopTimer(profile);
    profile.pending = null;
    const entry = profile.entries.get(change.section)!;
    entry.draft = change.before;
    profile.future.push(change);
    this.persistValues(profileId, entry, change.beforeValues);
    this.publish(profile);
    return change.section;
  }

  redo(profileId: string): ConfigurationSection | undefined {
    this.flush(profileId);
    const profile = this.profiles.get(profileId);
    const change = profile?.future.pop();
    if (!profile || !change) return;
    const entry = profile.entries.get(change.section)!;
    entry.draft = change.after;
    profile.past.push(change);
    if (change.afterValues === undefined) this.persistEntry(profileId, entry);
    else this.persistValues(profileId, entry, change.afterValues);
    this.publish(profile);
    return change.section;
  }

  getSnapshot(profileId: string): ConfigurationHistorySnapshot {
    return this.profiles.get(profileId)?.snapshot ?? EMPTY_SNAPSHOT;
  }

  subscribe(profileId: string, listener: () => void): () => void {
    if (!profileId) return () => {};
    const profile = this.profile(profileId);
    profile.listeners.add(listener);
    return () => profile.listeners.delete(listener);
  }
}
