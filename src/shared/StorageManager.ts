import { Store } from "@tauri-apps/plugin-store";
import { TFunction } from "i18next";

type DownloadData = string | Blob | ArrayBuffer | Uint8Array;
type UploadData = Uint8Array;

/** Returns the get extension result. */
function getExtension(filename: string): string {
  const match = filename.match(/\.([^.]+)$/);
  return match?.[1]?.toLowerCase() ?? "";
}

/** Returns the get file filter result. */
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

/** Handles the to uint8 array workflow. */
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

/** Handles the to blob workflow. */
function toBlob(data: DownloadData): Blob {
  if (data instanceof Blob) {
    return data;
  }
  return new Blob([data], {
    type: typeof data === "string" ? "text/plain;charset=utf-8" : "application/octet-stream",
  });
}

/** Handles the data urlto blob workflow. */
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
  /** Performs the init operation. */
  static async init() {
    // For the browser has actually done the LocalStorage initialization,
    // we don't implement the init function and leave it blank.
  }

  /** Returns the get result. */
  static get(key: string) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error("[StorageUtil:get] error:", e);
      return null;
    }
  }

  /** Performs the set operation. */
  static set(key: string, value: any) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error("[StorageUtil:set] error:", e);
    }
  }

  /** Performs the remove operation. */
  static remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.error("[StorageUtil:remove] error:", e);
    }
  }

  /** Handles the download workflow. */
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

  /** Handles the upload workflow. */
  static async upload(_translator: TFunction, accept = ".zip"): Promise<UploadData | null> {
    return await new Promise((resolve, reject) => {
      const input = document.createElement("input");
      let settled = false;
      /** Handles the finish workflow. */
      const finish = (value: UploadData | null) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("focus", onFocus);
        resolve(value);
      };
      /** Handles the on focus interaction. */
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

  /** Handles the retrieve path workflow. */
  static async retrievePath(_description: string, _filters: any) {
    // As the browser ban the visit of local file path,
    // we don't implement the webui interface for file path retrieval.
  }
}

class StorageUtilTauri {
  private static store: Store | null = null;
  private static cache: Record<string, any> = {};
  private static initialized = false;

  /** Performs the init operation. */
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

  /** Returns the resolve storage state result. */
  private static async resolveStorageState(): Promise<{ storePath: string; portable: boolean }> {
    try {
      const { invoke } = await import("@/shared/TauriInvoke");
      return await invoke<{ storePath: string; portable: boolean }>("updater_get_storage_state");
    } catch (error) {
      console.warn("[StorageUtil:init] storage state fallback:", error);
      return { storePath: ".app_storage.json", portable: false };
    }
  }

  /** Returns the get result. */
  static get<T = any>(key: string): T | null {
    if (!this.initialized) {
      console.warn("[StorageUtil:get] called before init");
      return null;
    }
    return this.cache[key] ?? null;
  }

  /** Performs the set operation. */
  static set(key: string, value: any) {
    if (!this.initialized) {
      console.warn("[StorageUtil:set] called before init");
      return;
    }
    this.cache[key] = value;
    this.store!.set(key, value).then(() => this.store!.save());
  }

  /** Performs the remove operation. */
  static remove(key: string) {
    if (!this.initialized) return;
    delete this.cache[key];
    this.store!.delete(key).then(() => this.store!.save());
  }

  /** Handles the download workflow. */
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

  /** Handles the upload workflow. */
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

  /** Handles the retrieve path workflow. */
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
