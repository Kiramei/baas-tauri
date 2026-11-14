import {
  createProfileNameAllocator,
  prepareProfileFiles,
  sendProfileArchive,
  type ProfileNameAllocator,
} from "./ProfileArchiveImport";

export interface ProfileFolderFile {
  /** Relative to the chosen config directory: profile-id/config.json. */
  path: string;
  read: () => Promise<Uint8Array>;
}

export interface ProfileFolderSelection {
  profiles: { folder: string; files: ProfileFolderFile[]; error?: string }[];
}

export interface FolderImportReport {
  imported: { folder: string; serial: string }[];
  failed: { folder: string; error: string }[];
}

export interface FolderImportProgress {
  completed: number;
  total: number;
}

export class ProfileFolderImportError extends Error {
  constructor(public readonly code: "no_profiles" | "unsupported_folder_picker") {
    super(code);
    this.name = "ProfileFolderImportError";
  }
}

const safePart = (part: string) =>
  part.length > 0 &&
  part !== "." &&
  part !== ".." &&
  !/[\\:\0]/.test(part) &&
  part === part.replace(/[ .]+$/, "");

/** Only direct child profile directories qualify; config-root metadata is ignored. */
export function groupProfileFolderFiles(
  files: ProfileFolderFile[],
  selectedFolderName = "config"
): ProfileFolderSelection {
  if (files.some((file) => file.path === "config.json")) {
    const folder =
      safePart(selectedFolderName) && !selectedFolderName.includes("/")
        ? selectedFolderName
        : "config";
    return {
      profiles: [
        { folder, files: files.map((file) => ({ ...file, path: `${folder}/${file.path}` })) },
      ],
    };
  }
  const groups = new Map<string, ProfileFolderFile[]>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length < 2) continue;
    const folder = parts[0];
    const group = groups.get(folder) ?? [];
    group.push(file);
    groups.set(folder, group);
  }
  return {
    profiles: [...groups.entries()]
      .filter(([folder, entries]) => entries.some((file) => file.path === `${folder}/config.json`))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, entries]) => ({ folder, files: entries })),
  };
}

interface NativeEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink?: boolean;
  uri?: string;
}

async function nativeSelection(title: string): Promise<ProfileFolderSelection | null> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { invoke } = await import("./TauriInvoke");
  const android = __WITH_ANDROID__;
  const root = android
    ? await invoke<string | null>("android_pick_profile_folder")
    : await (
        await import("@tauri-apps/plugin-dialog")
      ).open({
        title,
        directory: true,
        multiple: false,
        recursive: true,
      });
  if (typeof root !== "string") return null;
  const join = (await import("@tauri-apps/api/path")).join;
  const list = (path: string): Promise<NativeEntry[]> =>
    android ? invoke("android_list_profile_folder", { uri: path }) : fs.readDir(path);
  const childPath = async (parent: string, entry: NativeEntry) => {
    if (!safePart(entry.name) || entry.name.includes("/"))
      throw new Error("Invalid profile file name");
    if (android) {
      if (!entry.uri) throw new Error("Missing Android document URI");
      return entry.uri;
    }
    return join(parent, entry.name);
  };
  const profiles: ProfileFolderSelection["profiles"] = [];
  const walk = async (
    directory: string,
    relative: string,
    files: ProfileFolderFile[]
  ): Promise<void> => {
    for (const entry of await list(directory)) {
      if (entry.isSymlink) continue;
      const path = await childPath(directory, entry);
      const name = relative + "/" + entry.name;
      if (name.split("/").length > 32) throw new Error("Profile directory nesting is too deep");
      if (entry.isDirectory) await walk(path, name, files);
      else if (entry.isFile) files.push({ path: name, read: () => fs.readFile(path) });
    }
  };
  const children = await list(root);
  if (children.some((entry) => entry.name === "config.json" && entry.isFile && !entry.isSymlink)) {
    let name = "config";
    try {
      name = decodeURIComponent(root).split(/[\\/]/).filter(Boolean).pop() || name;
    } catch {
      /* Display labels are optional for opaque content URIs. */
    }
    const folder = safePart(name) ? name : "config";
    const files: ProfileFolderFile[] = [];
    try {
      await walk(root, folder, files);
      return { profiles: [{ folder, files }] };
    } catch (error) {
      return { profiles: [{ folder, files, error: errorMessage(error) }] };
    }
  }
  for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory || entry.isSymlink) continue;
    const files: ProfileFolderFile[] = [];
    try {
      const directory = await childPath(root, entry);
      const children = await list(directory);
      if (
        !children.some((child) => child.name === "config.json" && child.isFile && !child.isSymlink)
      )
        continue;
      await walk(directory, entry.name, files);
      profiles.push({ folder: entry.name, files });
    } catch (error) {
      profiles.push({ folder: entry.name, files, error: errorMessage(error) });
    }
  }
  return { profiles };
}

function browserSelection(): Promise<ProfileFolderSelection | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    if (!("webkitdirectory" in input)) {
      reject(new ProfileFolderImportError("unsupported_folder_picker"));
      return;
    }
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = "none";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (selection: ProfileFolderSelection | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(selection);
    };
    const onFocus = () => {
      timer = setTimeout(() => {
        if (!input.files?.length) finish(null);
      }, 500);
    };
    input.oncancel = () => finish(null);
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return finish(null);
      finish(
        groupProfileFolderFiles(
          files.map((file) => ({
            path: file.webkitRelativePath.split("/").slice(1).join("/"),
            read: async () => new Uint8Array(await file.arrayBuffer()),
          })),
          files[0]?.webkitRelativePath.split("/")[0]
        )
      );
    };
    window.addEventListener("focus", onFocus);
    document.body.append(input);
    input.click();
  });
}

export function pickProfileFolder(title: string): Promise<ProfileFolderSelection | null> {
  return __WITH_TAURI__ ? nativeSelection(title) : browserSelection();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read/import one archive at a time; successful imports are never resent after a later failure. */
export async function importProfileFolders(
  selection: ProfileFolderSelection,
  options: {
    importArchive: (name: string, bytes: Uint8Array) => Promise<{ serial: string }>;
    onProgress?: (progress: FolderImportProgress) => void;
    nameAllocator?: ProfileNameAllocator;
  }
): Promise<FolderImportReport> {
  if (!selection.profiles.length) throw new ProfileFolderImportError("no_profiles");
  const report: FolderImportReport = { imported: [], failed: [] };
  const allocator = options.nameAllocator ?? createProfileNameAllocator();
  const total = selection.profiles.length;
  let completed = 0;
  options.onProgress?.({ completed, total });
  for (const profile of selection.profiles) {
    try {
      if (profile.error) throw new Error(profile.error);
      const archive: Record<string, Uint8Array> = Object.create(null);
      const names = new Set<string>();
      for (const file of profile.files) {
        const parts = file.path.split("/");
        if (parts[0] !== profile.folder || parts.length < 2 || !parts.every(safePart))
          throw new Error("Invalid profile archive path");
        const relative = parts.slice(1).join("/");
        const canonical = relative.toLowerCase();
        if (names.has(canonical)) throw new Error("Duplicate profile archive path");
        names.add(canonical);
        archive[relative] = await file.read();
      }
      const prepared = prepareProfileFiles(archive, allocator);
      const result = await sendProfileArchive(prepared, options.importArchive, allocator);
      report.imported.push({ folder: profile.folder, serial: result.serial });
    } catch (error) {
      report.failed.push({ folder: profile.folder, error: errorMessage(error) });
    }
    completed += 1;
    options.onProgress?.({ completed, total });
  }
  return report;
}
