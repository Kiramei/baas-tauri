import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

/** Keeps cached pages in sync even when Activity paused their language listeners. */
export function useAppTranslation() {
  "use no memo";

  const { t: subscribedT, i18n, ready } = useTranslation();
  const subscribe = useCallback(
    (notify: () => void) => {
      i18n.on("languageChanged", notify);
      // Activity reconnects effects without replaying events missed while hidden.
      // Recheck immediately, including when the listener itself stayed stable.
      notify();
      return () => {
        i18n.off("languageChanged", notify);
      };
    },
    [i18n]
  );
  const getLanguage = useCallback(() => i18n.resolvedLanguage || i18n.language || "en", [i18n]);
  const language = useSyncExternalStore(subscribe, getLanguage, getLanguage);
  // A resumed page may still have the old hook translator. Reading a primitive
  // snapshot invalidates compiler/memo caches without remounting page state.
  const t = useMemo(() => i18n.getFixedT(language, "translation"), [i18n, language, subscribedT]);
  return { t, i18n, ready, language };
}
