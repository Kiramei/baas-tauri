export class StorageUtil {
  static get(key: string) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error("[StorageUtil:get] error:", e);
      return null;
    }
  }

  static set(key: string, value: any) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error("[StorageUtil:set] error:", e);
    }
  }

  static remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.error("[StorageUtil:remove] error:", e);
    }
  }

  static clear() {
    try {
      localStorage.clear();
    } catch (e) {
      console.error("[StorageUtil:clear] error:", e);
    }
  }
}
