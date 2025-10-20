import type {HotkeyConfig} from '@/components/HotkeyConfig';

/**
 * Abstraction for retrieving the persisted hotkey bindings from a remote service.
 * The concrete implementation can choose any transport layer (REST, RPC, WebSocket, etc.).
 */
export type FetchHotkeys = () => Promise<HotkeyConfig[]>;

/**
 * Abstraction for saving the configured hotkey bindings to a remote service.
 */
export type SaveHotkeys = (hotkeys: HotkeyConfig[]) => Promise<void>;

/**
 * Placeholder implementation that keeps the client responsive while the integration is pending.
 * Replace with a real data fetch that returns the effective hotkey configuration for the profile.
 */
export const fetchHotkeys: FetchHotkeys = async () => {
  return [];
};

/**
 * Placeholder save handler that resolves immediately.
 * Replace with the call required by your backend once the hotkey API contract is finalized.
 */
export const saveHotkeys: SaveHotkeys = async (_hotkeys: HotkeyConfig[]) => {
  return Promise.resolve();
};
