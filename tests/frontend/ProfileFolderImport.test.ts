import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { unzipSync, strFromU8 } from "fflate";
import {
  groupProfileFolderFiles,
  importProfileFolders,
  pickProfileFolder,
  ProfileFolderImportError,
  type ProfileFolderFile,
} from "../../src/shared/ProfileFolderImport";

const unpack = (bytes: Uint8Array) =>
  Object.fromEntries(
    Object.entries(unzipSync(bytes)).map(([path, data]) => [
      path.split("/").slice(1).join("/"),
      data,
    ])
  );

const file = (path: string, value: string): ProfileFolderFile => ({
  path,
  read: async () => new TextEncoder().encode(value),
});

const config = (folder: string, name = folder) =>
  file(`${folder}/config.json`, JSON.stringify({ name }));

test("folder selection imports immediate profiles with the archive layout accepted by the backend", async () => {
  const selected = groupProfileFolderFiles([
    file("gui.json", "{}"),
    file("logs/runtime.txt", "unrelated"),
    config("profile-b", "日服"),
    file("profile-b/event.json", '{"tasks":[]}'),
    file("profile-b/plugins.json", '{"schema_version":1,"plugins":{}}'),
    file("profile-b/history/old.json", "old"),
    config("profile-a", "国际服"),
  ]);
  expect(selected.profiles.map((p) => p.folder)).toEqual(["profile-a", "profile-b"]);
  const progress: unknown[] = [];
  const archives: string[] = [];
  const report = await importProfileFolders(selected, {
    onProgress: (value) => progress.push(value),
    importArchive: async (name, bytes) => {
      archives.push(name);
      const files = unpack(bytes);
      expect(JSON.parse(strFromU8(files["config.json"])).name).toBe(
        archives.length === 1 ? "国际服" : "日服"
      );
      expect(Object.keys(files).every((path) => !path.startsWith("profile-"))).toBe(true);
      if (archives.length === 2) {
        expect(strFromU8(files["event.json"])).toBe('{"tasks":[]}');
        expect(strFromU8(files["history/old.json"])).toBe("old");
        expect(JSON.parse(strFromU8(files["plugins.json"])).schema_version).toBe(1);
      }
      return { serial: name + "-new-id" };
    },
  });
  expect(archives).toHaveLength(2);
  expect(archives.every((name) => /^profile-[a-f0-9-]+\.zip$/.test(name))).toBe(true);
  expect(archives[0]).not.toBe(archives[1]);
  expect(report.failed).toEqual([]);
  expect(report.imported).toHaveLength(2);
  expect(progress).toEqual([
    { completed: 0, total: 2 },
    { completed: 1, total: 2 },
    { completed: 2, total: 2 },
  ]);
});

test("partial failure continues in order without reading or importing a successful profile twice", async () => {
  let inFlight = false;
  const calls: string[] = [];
  const selected = groupProfileFolderFiles([config("a"), config("b"), config("c")]);
  const report = await importProfileFolders(selected, {
    importArchive: async (_name, bytes) => {
      const name = JSON.parse(strFromU8(unpack(bytes)["config.json"])).name + ".zip";
      expect(inFlight).toBe(false);
      inFlight = true;
      calls.push(name);
      await Bun.sleep(1);
      inFlight = false;
      if (name === "b.zip") throw new Error("backend rejected import");
      return { serial: name };
    },
  });
  expect(calls).toEqual(["a.zip", "b.zip", "c.zip"]);
  expect(report.imported.map((p) => p.folder)).toEqual(["a", "c"]);
  expect(report.failed).toEqual([{ folder: "b", error: "backend rejected import" }]);
});

test("invalid paths, duplicate portable names and malformed JSON are isolated before upload", async () => {
  const selected = groupProfileFolderFiles([
    config("traversal"),
    file("traversal/../outside", "bad"),
    config("duplicate"),
    file("duplicate/CONFIG.json", "bad"),
    file("malformed/config.json", "[]"),
    config("good"),
  ]);
  const calls: string[] = [];
  const report = await importProfileFolders(selected, {
    importArchive: async (_name, bytes) => {
      const name = JSON.parse(strFromU8(unpack(bytes)["config.json"])).name + ".zip";
      calls.push(name);
      return { serial: name };
    },
  });
  expect(calls).toEqual(["good.zip"]);
  expect(report.failed.map((p) => p.folder)).toEqual(["duplicate", "malformed", "traversal"]);
});

test("an unrelated selected folder reports no_profiles without sending a command", async () => {
  const selected = groupProfileFolderFiles([
    file("notes.txt", "text"),
    file("nested/deeper/config.json", "{}"),
  ]);
  expect(selected.profiles).toHaveLength(0);
  let calls = 0;
  try {
    await importProfileFolders(selected, {
      importArchive: async () => {
        calls++;
        return { serial: "unused" };
      },
    });
    throw new Error("expected no_profiles");
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileFolderImportError);
    expect((error as ProfileFolderImportError).code).toBe("no_profiles");
  }
  expect(calls).toBe(0);
});

describe("native directory selection", () => {
  const keys = ["window", "__WITH_TAURI__", "__WITH_ANDROID__"] as const;
  const original = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { crypto: globalThis.crypto, addEventListener: () => {} },
    });
    Object.defineProperty(globalThis, "__WITH_TAURI__", { configurable: true, value: true });
    Object.defineProperty(globalThis, "__WITH_ANDROID__", { configurable: true, value: false });
  });
  afterEach(() => {
    clearMocks();
    keys.forEach((key, index) => {
      const descriptor = original[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  });

  const directory = (name: string) => ({ name, isDirectory: true, isFile: false });
  const regular = (name: string) => ({ name, isDirectory: false, isFile: true });

  test("desktop walks only qualifying child profiles and skips symlinks", async () => {
    const listed: string[] = [];
    const read: string[] = [];
    const tree: Record<string, unknown[]> = {
      "/config": [
        directory("profile"),
        directory("unrelated"),
        { ...directory("link"), isSymlink: true },
      ],
      "/config/profile": [
        regular("config.json"),
        regular("event.json"),
        directory("extra"),
        { ...directory("link"), isSymlink: true },
      ],
      "/config/profile/extra": [regular("data.json")],
      "/config/unrelated": [directory("deep")],
    };
    mockIPC((command, args) => {
      if (command === "plugin:dialog|open") {
        expect(args).toEqual({
          options: { title: "Import", directory: true, multiple: false, recursive: true },
        });
        return "/config";
      }
      if (command === "plugin:path|join") return (args as { paths: string[] }).paths.join("/");
      const path = (args as { path: string }).path;
      if (command === "plugin:fs|read_dir") {
        listed.push(path);
        if (!tree[path]) throw new Error("Unexpected directory traversal");
        return tree[path];
      }
      if (command === "plugin:fs|read_file") {
        read.push(path);
        return new TextEncoder().encode(path.endsWith("config.json") ? '{"name":"Test"}' : "{}");
      }
      throw new Error(`Unexpected command ${command}`);
    });
    const selected = await pickProfileFolder("Import");
    expect(selected?.profiles.map((profile) => profile.folder)).toEqual(["profile"]);
    expect(read).toEqual([]);
    expect(listed).not.toContain("/config/unrelated/deep");
    expect(listed.some((path) => path.includes("link"))).toBe(false);
    const report = await importProfileFolders(selected!, {
      importArchive: async (_name, bytes) => {
        expect(Object.keys(unpack(bytes))).toEqual([
          "config.json",
          "event.json",
          "extra/data.json",
        ]);
        return { serial: "new" };
      },
    });
    expect(report.imported).toEqual([{ folder: "profile", serial: "new" }]);
    expect(read).toHaveLength(3);
  });

  test("Android enumerates and reads granted document URIs without filesystem path conversion", async () => {
    Object.defineProperty(globalThis, "__WITH_ANDROID__", { configurable: true, value: true });
    const root = "content://provider/tree/config/document/config";
    const child = root + "%2Fprofile";
    const document = root + "%2Fprofile%2Fconfig.json";
    const reads: string[] = [];
    mockIPC((command, args) => {
      if (command === "android_pick_profile_folder") return root;
      if (command === "android_list_profile_folder") {
        const uri = (args as { uri: string }).uri;
        if (uri === root) return [{ ...directory("profile"), uri: child }];
        if (uri === child) return [{ ...regular("config.json"), uri: document }];
        throw new Error("Unexpected document URI");
      }
      if (command === "plugin:fs|read_file") {
        reads.push((args as { path: string }).path);
        return new TextEncoder().encode('{"name":"Android"}');
      }
      throw new Error(`Unexpected command ${command}`);
    });
    const selected = await pickProfileFolder("Import");
    await importProfileFolders(selected!, {
      importArchive: async () => ({ serial: "android-new" }),
    });
    expect(reads).toEqual([document]);
  });

  test("cancelled native pickers return null without enumerating a directory", async () => {
    const commands: string[] = [];
    mockIPC((command) => {
      commands.push(command);
      return null;
    });
    expect(await pickProfileFolder("Import")).toBeNull();
    Object.defineProperty(globalThis, "__WITH_ANDROID__", { configurable: true, value: true });
    expect(await pickProfileFolder("Import")).toBeNull();
    expect(commands).toEqual(["plugin:dialog|open", "android_pick_profile_folder"]);
  });
});
