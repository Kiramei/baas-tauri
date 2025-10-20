import {useCallback, useEffect, useMemo, useState} from 'react';
import type {TFunction} from 'i18next';
import type {HotkeyConfig} from '@/components/HotkeyConfig';
import {eventToCombo, getDefaultHotkeys, normalizeCombo} from '@/lib/hotkeys';
import {fetchHotkeys, saveHotkeys} from '@/services/hotkeyService';

export type HotkeyId =
  | 'toggle-run' | 'toggle-scroll' | 'open-settings'
  | 'clear-logs' | 'focus-search'  | 'help';

export type HotkeyHandlers = Partial<Record<HotkeyId, () => void>>;

/**
 * Lazily loads the remote hotkey configuration once the consuming component is ready.
 * Falls back to the default key map if the remote endpoint is unavailable.
 */
export function useRemoteHotkeys(t: TFunction, enabled: boolean) {
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const remote = await fetchHotkeys();
      setHotkeys(remote && remote.length ? remote : getDefaultHotkeys(t));
    } catch (e: any) {
      setError(e?.message || 'failed to fetch hotkeys');
      setHotkeys(getDefaultHotkeys(t));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);

  const save = useCallback(async (list: HotkeyConfig[]) => {
    await saveHotkeys(list);
  }, []);

  return {hotkeys, setHotkeys, loading, error, reload, save};
}

/**
 * Registers keydown listeners based on the provided hotkey configuration and handler map.
 * Only normalized combos that have a matching handler are registered.
 */
export function useBindHotkeyHandlers(hotkeys: HotkeyConfig[] | null, handlers: HotkeyHandlers) {
  const comboMap = useMemo(() => {
    const map = new Map<string, () => void>();
    if (!hotkeys) return map;
    for (const hk of hotkeys) {
      if (!hk.value) continue;
      const fn = handlers[hk.id as keyof HotkeyHandlers];
      if (!fn) continue;
      map.set(normalizeCombo(hk.value), fn);
    }
    return map;
  }, [hotkeys, handlers]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const fn = comboMap.get(eventToCombo(e));
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [comboMap]);
}
