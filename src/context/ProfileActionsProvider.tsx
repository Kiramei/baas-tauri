import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";

export interface ProfileActions {
  create: () => void;
  import: () => Promise<void>;
}

class ProfileActionsStore {
  private binding: { token: symbol; actions: ProfileActions } | null = null;
  private listeners = new Set<() => void>();

  getSnapshot = () => this.binding?.actions ?? null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  attach(actions: ProfileActions) {
    const token = Symbol("profile-actions");
    this.binding = { token, actions };
    this.listeners.forEach((listener) => listener());
    return () => {
      if (this.binding?.token !== token) return;
      this.binding = null;
      this.listeners.forEach((listener) => listener());
    };
  }
}

const ProfileActionsContext = createContext<ProfileActionsStore | undefined>(undefined);

/** The titlebar can invoke the profile editor's existing flows outside AppContext. */
export function ProfileActionsProvider({ children }: { children: ReactNode }) {
  const [actions] = useState(() => new ProfileActionsStore());
  return (
    <ProfileActionsContext.Provider value={actions}>{children}</ProfileActionsContext.Provider>
  );
}

export function useProfileActionsController() {
  const store = useContext(ProfileActionsContext);
  if (!store) throw new Error("Profile actions require a ProfileActionsProvider");
  return store;
}

export function useProfileActions() {
  const store = useProfileActionsController();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
