/**
 * Helpers for normalizing and validating keyboard shortcut combinations.
 */
import type { TFunction } from 'i18next';
import type { HotkeyConfig } from '@/components/HotkeyConfig';

export function getDefaultHotkeys(t: TFunction): HotkeyConfig[] {
  return [
    { id: 'toggle-run',    label: t('hotkey.switch.start'),   value: '' },
    { id: 'clear-logs',    label: t('hotkey.clear.logs'),     value: '' },
    { id: 'help',          label: t('hotkey.help.about'),     value: '' },
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


