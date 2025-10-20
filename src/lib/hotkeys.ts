/**
 * Helpers for normalizing and validating keyboard shortcut combinations.
 */
import type { TFunction } from 'i18next';
import type { HotkeyConfig } from '@/components/HotkeyConfig';

export function getDefaultHotkeys(t: TFunction): HotkeyConfig[] {
  return [
    { id: 'toggle-run',    label: t('hotkey.switch.start'), value: 'Ctrl+Enter' },
    { id: 'toggle-scroll', label: t('hotkey.toggle.scroll'), value: 'Ctrl+Shift+S' },
    { id: 'open-settings', label: t('hotkey.open.settings'), value: 'Ctrl+,' },
    { id: 'clear-logs',    label: t('hotkey.clear.logs'), value: '' },
    { id: 'focus-search',  label: t('hotkey.focus.search'), value: 'Ctrl+K' },
    { id: 'help',          label: t('hotkey.help.about'), value: 'F1' },
  ];
}

export function normalizeCombo(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '');
}

export function eventToCombo(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.shiftKey) mods.push('shift');
  if (e.altKey) mods.push('alt');
  if (e.metaKey) mods.push('meta');
  let main = e.key.length === 1 ? e.key.toUpperCase() : e.key.toUpperCase();
  return normalizeCombo([...mods, main].join('+'));
}


