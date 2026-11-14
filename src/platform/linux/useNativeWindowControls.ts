import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@/shared/TauriInvoke";

interface NativeWindowControlsLayout {
  available: boolean;
  startWidth: number;
  endWidth: number;
  height: number;
}

/** GTK renders Linux caption buttons; HTML reserves their measured space. */
export function useNativeWindowControls(): NativeWindowControlsLayout {
  const linuxDesktop =
    __WITH_TAURI__ && !__WITH_ANDROID__ && navigator.platform.startsWith("Linux");
  const [layout, setLayout] = useState<NativeWindowControlsLayout>({
    available: linuxDesktop,
    startWidth: 0,
    endWidth: 0,
    height: 44,
  });
  const [nativeReady, setNativeReady] = useState(false);

  useEffect(() => {
    if (!linuxDesktop) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let revision = 0;
    const reportError = (error: unknown) => console.warn("[window] native controls failed", error);
    const updateLayout = (next: NativeWindowControlsLayout) => {
      if (disposed) return;
      setLayout(next);
      setNativeReady(next.available);
    };

    void (async () => {
      const stop = await listen<NativeWindowControlsLayout>(
        "native-window-controls-changed",
        ({ payload }) => {
          revision += 1;
          updateLayout(payload);
        }
      );
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      const queriedRevision = revision;
      const initial = await invoke<NativeWindowControlsLayout>("native_window_controls_state");
      if (disposed) return;
      if (queriedRevision === revision) updateLayout(initial);
    })().catch((error: unknown) => {
      reportError(error);
      if (!disposed) {
        setLayout({ available: false, startWidth: 0, endWidth: 0, height: 44 });
        setNativeReady(false);
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [linuxDesktop]);

  useEffect(() => {
    if (!linuxDesktop || !nativeReady) return;
    let blocked: boolean | undefined;
    const reportError = (error: unknown) => console.warn("[window] native controls failed", error);
    const updateBlocked = () => {
      const next = Boolean(document.querySelector("[aria-modal='true'], [data-modal-backdrop]"));
      if (next === blocked) return;
      blocked = next;
      void invoke("native_window_controls_set_blocked", { blocked: next }).catch(reportError);
    };
    const observer = new MutationObserver(updateBlocked);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal"],
    });
    updateBlocked();

    return () => {
      observer.disconnect();
      if (blocked) {
        void invoke("native_window_controls_set_blocked", { blocked: false }).catch(reportError);
      }
    };
  }, [linuxDesktop, nativeReady]);

  return layout;
}
