import type { PageKey } from "@/types/app";
import { normalizePageKey } from "./PageKey";

export interface NavigationView {
  page: PageKey;
  profileId?: string;
}

export interface NavigationHistorySnapshot {
  available: boolean;
  canBack: boolean;
  canForward: boolean;
  current: Readonly<NavigationView> | null;
  position: number;
  length: number;
}

type RestoreView = (view: Readonly<NavigationView>) => boolean;
const sameView = (left?: Readonly<NavigationView>, right?: Readonly<NavigationView>) =>
  left?.page === right?.page && left?.profileId === right?.profileId;

const normalizeView = (view: Readonly<NavigationView>): Readonly<NavigationView> => {
  const page = normalizePageKey(view.page);
  if (page === "settings")
    return view.page === page && view.profileId === undefined ? view : Object.freeze({ page });
  return view.page === page ? view : Object.freeze({ ...view, page });
};

/** Navigation is local UI state: restoring it never starts a backend task. */
export class NavigationHistory {
  private entries: Readonly<NavigationView>[] = [];
  private position = -1;
  private profiles = new Set<string>();
  private binding: { token: symbol; restore: RestoreView } | null = null;
  private listeners = new Set<() => void>();
  private snapshot: NavigationHistorySnapshot = {
    available: false,
    canBack: false,
    canForward: false,
    current: null,
    position: -1,
    length: 0,
  };

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  attach(restore: RestoreView): () => void {
    const token = Symbol("navigation-owner");
    this.binding = { token, restore };
    this.publish();
    return () => {
      if (this.binding?.token !== token) return;
      this.binding = null;
      this.publish();
    };
  }

  /** Observe the committed view, including profile changes from the drawer. */
  observe(view: NavigationView | null, profileIds: readonly string[]): void {
    this.profiles = new Set(profileIds);
    this.entries = this.entries.map(normalizeView);
    const currentView = view && normalizeView(view);
    if (currentView && this.isAvailable(currentView)) {
      if (!sameView(this.entries[this.position], currentView)) {
        this.entries = this.entries.slice(0, this.position + 1);
        this.entries.push(Object.freeze({ ...currentView }));
        // Retain a bounded amount of UI history during long desktop sessions.
        if (this.entries.length > 200) this.entries.shift();
        this.position = this.entries.length - 1;
      }
    }
    this.publish();
  }

  back = () => this.move(-1);
  forward = () => this.move(1);

  openSettings = () => {
    if (!this.binding?.restore({ page: "settings" })) return false;
    this.observe({ page: "settings" }, [...this.profiles]);
    return true;
  };

  private find(direction: -1 | 1): number {
    const current = this.entries[this.position];
    for (
      let index = this.position + direction;
      index >= 0 && index < this.entries.length;
      index += direction
    ) {
      const entry = this.entries[index];
      if (this.isAvailable(entry) && !sameView(current, entry)) return index;
    }
    return -1;
  }

  private move(direction: -1 | 1): boolean {
    const binding = this.binding;
    if (!binding) return false;
    this.entries = this.entries.map(normalizeView);
    let target = this.find(direction);
    while (target !== -1) {
      const previous = this.position;
      const entry = this.entries[target];
      // Set the cursor first so the subsequent React commit observes the same
      // entry instead of treating history restoration as a new navigation.
      this.position = target;
      if (binding.restore(entry)) {
        this.publish();
        return true;
      }
      this.position = previous;
      if (entry.page === "settings") {
        this.publish();
        return false;
      }
      // A profile may disappear between rendering the button and handling it.
      if (entry.profileId) this.profiles.delete(entry.profileId);
      target = this.find(direction);
    }
    this.publish();
    return false;
  }

  private publish(): void {
    this.entries = this.entries.map(normalizeView);
    const available = this.binding !== null;
    const next: NavigationHistorySnapshot = {
      available,
      canBack: available && this.find(-1) !== -1,
      canForward: available && this.find(1) !== -1,
      current: this.entries[this.position] ?? null,
      position: this.position,
      length: this.entries.length,
    };
    const previous = this.snapshot;
    if (
      Object.keys(next).every(
        (key) => next[key as keyof typeof next] === previous[key as keyof typeof previous]
      )
    )
      return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  private isAvailable(view: Readonly<NavigationView>): boolean {
    return view.page === "settings" || this.profiles.has(view.profileId ?? "");
  }
}
