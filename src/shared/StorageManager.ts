import { Store } from "@tauri-apps/plugin-store";
import { TFunction } from "i18next";

type DownloadData = string | Blob | ArrayBuffer | Uint8Array;
type UploadData = Uint8Array;

function getExtension(filename: string): string {
  const match = filename.match(/\.([^.]+)$/);
  return match?.[1]?.toLowerCase() ?? "";
}

function getFileFilter(filename: string) {
  const ext = getExtension(filename);
  if (!ext) return undefined;
  const nameMap: Record<string, string> = {
    txt: "Text File",
    log: "Log File",
    json: "JSON File",
    png: "PNG Image",
    jpg: "JPEG Image",
    jpeg: "JPEG Image",
    webp: "WebP Image",
    zip: "Zip Archive",
  };
  return [
    {
      name: nameMap[ext] ?? `${ext.toUpperCase()} File`,
      extensions: [ext],
    },
  ];
}

async function toUint8Array(data: DownloadData): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return new TextEncoder().encode(data);
}

function toBlob(data: DownloadData): Blob {
  if (data instanceof Blob) {
    return data;
  }
  return new Blob([data], {
    type: typeof data === "string" ? "text/plain;charset=utf-8" : "application/octet-stream",
  });
}

export function dataURLToBlob(dataURL: string): Blob {
  const commaIndex = dataURL.indexOf(",");
  if (commaIndex < 0) {
    throw new Error("Invalid data URL");
  }
  const meta = dataURL.slice(0, commaIndex);
  const body = dataURL.slice(commaIndex + 1);
  const mime = meta.match(/^data:(.*?)(;base64)?$/)?.[1] || "application/octet-stream";
  const isBase64 = meta.includes(";base64");
  const binary = isBase64 ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

class StorageUtilWebUI {
  static async init() {
    // For the browser has actually done the LocalStorage initialization,
    // we don't implement the init function and leave it blank.
  }

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

  static async download(
    filename: string,
    data: DownloadData | null | undefined,
    _translator: TFunction
  ) {
    if (data == null) {
      console.log("No data provided");
      return;
    }
    const blob = toBlob(data);
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  static async upload(_translator: TFunction, accept = ".zip"): Promise<UploadData | null> {
    return await new Promise((resolve, reject) => {
      const input = document.createElement("input");
      let settled = false;
      const finish = (value: UploadData | null) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("focus", onFocus);
        resolve(value);
      };
      const onFocus = () => {
        setTimeout(() => {
          if (!input.files?.length) finish(null);
        }, 500);
      };
      input.type = "file";
      input.accept = accept;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          finish(null);
          return;
        }
        try {
          finish(new Uint8Array(await file.arrayBuffer()));
        } catch (error) {
          reject(error);
        }
      };
      (input as HTMLInputElement & { oncancel?: () => void }).oncancel = () => finish(null);
      window.addEventListener("focus", onFocus, { once: true });
      input.click();
    });
  }

  static async retrievePath(_description: string, _filters: any) {
    // As the browser ban the visit of local file path,
    // we don't implement the webui interface for file path retrieval.
  }
}

class StorageUtilTauri {
  private static store: Store | null = null;
  private static cache: Record<string, any> = {};
  private static initialized = false;

  static async init() {
    if (this.initialized) return;
    const storageState = await this.resolveStorageState();
    this.store = await Store.load(storageState.storePath);
    const entries = await this.store.entries();
    this.cache = Object.fromEntries(entries);
    if (storageState.portable && this.cache.base_dir !== ".") {
      this.cache.base_dir = ".";
      await this.store.set("base_dir", ".");
      await this.store.save();
    }
    this.initialized = true;
  }

  private static async resolveStorageState(): Promise<{ storePath: string; portable: boolean }> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<{ storePath: string; portable: boolean }>("updater_get_storage_state");
    } catch (error) {
      console.warn("[StorageUtil:init] storage state fallback:", error);
      return { storePath: ".app_storage.json", portable: false };
    }
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

  static async download(
    filename: string,
    data: DownloadData | null | undefined,
    translator: TFunction
  ) {
    if (data == null) {
      console.log("No data provided");
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const target = await save({
      title: translator("export.log.folderSelect"),
      defaultPath: filename,
      filters: getFileFilter(filename),
    });
    if (!target) return;
    const bytes = await toUint8Array(data);
    await writeFile(target, bytes);
  }

  static async upload(translator: TFunction, accept = ".zip"): Promise<UploadData | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const extensions = accept
      .split(",")
      .map((item) => item.trim().replace(/^\./, ""))
      .filter(Boolean);
    const file = await open({
      title: translator("profile.importArchive"),
      multiple: false,
      filters: extensions.length
        ? [
            {
              name: "Zip Archive",
              extensions,
            },
          ]
        : undefined,
    });

    if (typeof file !== "string") {
      return null;
    }
    return await readFile(file);
  }

  static async retrievePath(description: string, filters: any) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const file = await open({
      title: description,
      multiple: false,
      filters: filters,
    });

    if (typeof file === "string") {
      return file;
    }
    return "";
  }
}

const StorageUtil = __WITH_TAURI__ ? StorageUtilTauri : StorageUtilWebUI;

export default StorageUtil;
