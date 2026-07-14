import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { HotkeyConfig } from "@/components/HotkeyConfig";
import { useApp } from "@/context/AppContext";
import { getTimestampMs } from "@/shared/GlobalUtilities";
import { reconcileProfileHotkeys } from "@/shared/HotkeyManager";
import StorageUtil from "@/shared/StorageManager";
import { useWebSocketStore } from "@/store/WebsocketStore";

type ShortcutBindingRequest = {
  id: string;
  configId: string;
  accelerator: string;
  enabled: boolean;
};

type ShortcutRejectedBinding = {
  id: string;
  configId: string;
  accelerator: string;
  reason: string;
};

type ShortcutRegistrationReport = {
  registered: Array<{
    id: string;
    configId: string;
    accelerator: string;
  }>;
  rejected: ShortcutRejectedBinding[];
};

type ShortcutTogglePayload = {
  id: string;
  configId: string;
  accelerator: string;
};

type TauriShortcutContextValue = {
  hotkeys: HotkeyConfig[];
  saveHotkeys: (hotkeys: HotkeyConfig[]) => Promise<ShortcutRegistrationReport>;
  setShortcutsSuspended: (suspended: boolean) => void;
};

const TauriShortcutContext = createContext<TauriShortcutContextValue>({
  hotkeys: [],
  saveHotkeys: async () => ({ registered: [], rejected: [] }),
  setShortcutsSuspended: () => {},
});

const STORAGE_KEY = "hotkeys";
const TOGGLE_RUN_EVENT = "baas-shortcut:toggle-run";

/** Renders the tauri shortcut provider component. */
export const TauriShortcutProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const { profiles } = useApp();
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[]>([]);
  const [shortcutsSuspended, setShortcutsSuspended] = useState(false);
  const hydratedRef = useRef(false);

  const applyBindings = useCallback(async (nextHotkeys: HotkeyConfig[]) => {
    if (!__WITH_TAURI__ || __WITH_ANDROID__) return { registered: [], rejected: [] };

    const { invoke } = await import("@/shared/TauriInvoke");
    const bindings: ShortcutBindingRequest[] = nextHotkeys.map((hotkey) => ({
      id: hotkey.id,
      configId: hotkey.configId ?? hotkey.id.replace(/^toggle-run:/, ""),
      accelerator: hotkey.value,
      enabled: hotkey.enabled ?? true,
    }));

    return invoke<ShortcutRegistrationReport>("shortcut_apply_bindings", { bindings });
  }, []);

  useEffect(() => {
    if (!__WITH_TAURI__ || __WITH_ANDROID__ || profiles.length === 0) return;

    const source = hydratedRef.current ? hotkeys : StorageUtil.get<HotkeyConfig[]>(STORAGE_KEY);
    const next = reconcileProfileHotkeys(profiles, source, t("hotkey.switch.start"));
    hydratedRef.current = true;
    setHotkeys(next);
    StorageUtil.set(STORAGE_KEY, next);
  }, [profiles, t]);

  useEffect(() => {
    if (!__WITH_TAURI__ || __WITH_ANDROID__ || !hydratedRef.current) return;
    void applyBindings(shortcutsSuspended ? [] : hotkeys).then((report) => {
      if (report.rejected.length > 0) {
        console.warn("[shortcut] failed to register shortcuts", report.rejected);
      }
    });
  }, [applyBindings, hotkeys, shortcutsSuspended]);

  useEffect(() => {
    if (!__WITH_TAURI__ || __WITH_ANDROID__) return;

    let unlisten: (() => void) | null = null;
    let disposed = false;

    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<ShortcutTogglePayload>(TOGGLE_RUN_EVENT, (event) => {
          const state = useWebSocketStore.getState();
          if (!state.connections.trigger) {
            toast.error("Shortcut trigger failed", {
              description: "BAAS trigger connection is not ready.",
            });
            return;
          }

          const configId = event.payload.configId;
          const running = !!state.statusStore[configId]?.running;
          state.trigger(
            {
              timestamp: getTimestampMs(),
              command: running ? "stop_scheduler" : "start_scheduler",
              config_id: configId,
              payload: {},
            },
            (response) => {
              console.debug("[shortcut] toggle-run acknowledged", response);
            }
          );
        })
      )
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => {
        console.error("[shortcut] failed to listen for global shortcut events", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const saveHotkeys = useCallback(
    async (nextHotkeys: HotkeyConfig[]) => {
      const report = await applyBindings(nextHotkeys);
      if (report.rejected.length > 0) return report;

      setHotkeys(nextHotkeys);
      StorageUtil.set(STORAGE_KEY, nextHotkeys);
      return report;
    },
    [applyBindings]
  );

  const value = useMemo(
    () => ({ hotkeys, saveHotkeys, setShortcutsSuspended }),
    [hotkeys, saveHotkeys]
  );

  return <TauriShortcutContext.Provider value={value}>{children}</TauriShortcutContext.Provider>;
};

/** Coordinates the use tauri shortcuts hook behavior. */
export function useTauriShortcuts() {
  return useContext(TauriShortcutContext);
}
