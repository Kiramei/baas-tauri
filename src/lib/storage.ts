import { Store } from "@tauri-apps/plugin-store";

export class StorageUtil {
  private static store: Store | null = null;
  private static cache: Record<string, any> = {};
  private static initialized = false;

  static async init() {
    if (this.initialized) return;
    this.store = await Store.load(".app_storage.json");
    const entries = await this.store.entries();
    this.cache = Object.fromEntries(entries);
    this.initialized = true;
  }

  static get<T = any>(key: string): T | null {
    if (!this.initialized) {
      console.warn("[StorageUtil:get] called before init");
      return null;
    }
    return this.cache[key] ?? null;
  }

  static set(key: string, value: any) {
    if (!this.initialized) {
      console.warn("[StorageUtil:set] called before init");
      return;
    }
    this.cache[key] = value;
    this.store!.set(key, value).then(() => this.store!.save());
  }

  static remove(key: string) {
    if (!this.initialized) return;
    delete this.cache[key];
    this.store!.delete(key).then(() => this.store!.save());
  }
}
