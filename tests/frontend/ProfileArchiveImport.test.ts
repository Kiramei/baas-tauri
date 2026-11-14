import { describe, expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  createProfileNameAllocator,
  destinationProfileNames,
  profileNameAllocatorFor,
  importProfileArchive,
  MAX_PROFILE_ARCHIVE_BYTES,
  prepareProfileArchive,
  type PreparedProfileArchive,
} from "../../src/shared/ProfileArchiveImport";
import {
  groupProfileFolderFiles,
  importProfileFolders,
} from "../../src/shared/ProfileFolderImport";
import { isUserProfileId } from "../../src/shared/ProfileTabs";

const archive = (prefix = "", name = "Raid") =>
  zipSync({
    [`${prefix}config.json`]: strToU8(
      JSON.stringify({ name, server: "官服", extra: { preserved: true } })
    ),
    [`${prefix}event.json`]: strToU8("[]"),
    [`${prefix}plugins.json`]: strToU8('{"schema_version":1,"plugins":{}}'),
    [`${prefix}history/old.json`]: strToU8('{"original":true}'),
  });
const contents = (prepared: PreparedProfileArchive) =>
  Object.fromEntries(
    Object.entries(unzipSync(prepared.bytes)).map(([path, data]) => {
      expect(path.startsWith(prepared.id + "/")).toBe(true);
      return [path.slice(prepared.id.length + 1), data];
    })
  );

describe("fresh profile archive identities", () => {
  test.each(["", "default_config/", "arbitrary-old-folder/", "config/default_config/"])(
    "normalizes %s without exposing its old directory ID",
    (prefix) => {
      const prepared = prepareProfileArchive(archive(prefix));
      expect(isUserProfileId(prepared.id)).toBe(true);
      expect(prepared.id).toMatch(/^profile-[a-f0-9-]+$/);
      expect(prepared.filename).toBe(prepared.id + ".zip");
      const files = contents(prepared);
      expect(JSON.parse(strFromU8(files["config.json"]))).toEqual({
        name: "Raid",
        server: "官服",
        extra: { preserved: true },
      });
      expect(strFromU8(files["event.json"])).toBe("[]");
      expect(strFromU8(files["plugins.json"])).toBe('{"schema_version":1,"plugins":{}}');
      expect(strFromU8(files["history/old.json"])).toBe('{"original":true}');
    }
  );

  test("reimporting identical bytes always creates a distinct root and filename", () => {
    const input = archive("default_config/");
    const first = prepareProfileArchive(input);
    const second = prepareProfileArchive(input);
    expect(first.id).not.toBe(second.id);
    expect(first.filename).not.toBe(second.filename);
    expect(first.name).toBe(second.name);
    expect(isUserProfileId("default_config")).toBe(false);
  });

  test("the backend ACK serial remains authoritative", async () => {
    const result = await importProfileArchive(archive("default_config/"), async (name, bytes) => {
      expect(
        Object.keys(unzipSync(bytes)).every((path) => path.startsWith(name.slice(0, -4) + "/"))
      ).toBe(true);
      return { serial: "backend-generated-id" };
    });
    expect(result.serial).toBe("backend-generated-id");
  });
});

describe("safe display names", () => {
  test("default template names never delete the backend's built-in template", () => {
    const prepared = prepareProfileArchive(archive("default_config/", "新的配置"));
    expect(prepared.name).toBe("New Profile");
    expect(JSON.parse(strFromU8(contents(prepared)["config.json"])).name).toBe("New Profile");
  });

  test("allocates around raw, display-normalized and already numbered names", () => {
    const allocator = createProfileNameAllocator(() => [
      "新的配置",
      "New Profile (2)",
      "Raid",
      "Raid (2)",
      "Raid (3)",
    ]);
    expect(allocator.allocate("新的配置")).toBe("New Profile (3)");
    expect(allocator.allocate("Raid")).toBe("Raid (4)");
    expect(allocator.allocate("Raid (4)")).toBe("Raid (5)");
  });

  test("concurrent entry points on one connection share names before ACK snapshots arrive", () => {
    const connection = {};
    const single = profileNameAllocatorFor(connection, () => ["Raid"]);
    const drop = profileNameAllocatorFor(connection, () => ["Raid"]);
    expect(single.allocate("Raid")).toBe("Raid (2)");
    expect(drop.allocate("Raid")).toBe("Raid (3)");
    expect(profileNameAllocatorFor({}, () => ["Raid"]).allocate("Raid")).toBe("Raid (2)");
  });

  test("incomplete destination snapshots cannot accidentally overwrite unseen same-name profiles", () => {
    const allocator = createProfileNameAllocator(() =>
      destinationProfileNames({ configStore: {}, _receivedSnapshots: {} })
    );
    expect(() => prepareProfileArchive(archive(), allocator)).toThrow("still loading");
    expect(() =>
      prepareProfileArchive(
        archive(),
        createProfileNameAllocator(() => [undefined])
      )
    ).toThrow("still loading");
  });

  test("batch imports keep both same-name profiles despite delayed destination snapshots", async () => {
    const existing = new Map([
      ["default_config", "新的配置"],
      ["existing", "Raid"],
    ]);
    const selected = groupProfileFolderFiles(
      ["default_config", "anything"].map((folder) => ({
        path: `${folder}/config.json`,
        read: async () => strToU8('{"name":"Raid","server":"官服"}'),
      }))
    );
    const ids: string[] = [];
    const report = await importProfileFolders(selected, {
      nameAllocator: createProfileNameAllocator(() => ["新的配置", "Raid"]),
      importArchive: async (filename, bytes) => {
        const files = unzipSync(bytes);
        const id = filename.slice(0, -4);
        const name = JSON.parse(strFromU8(files[`${id}/config.json`])).name;
        // Match the current backend's destructive same-name replacement rule.
        for (const [key, value] of existing) if (value === name) existing.delete(key);
        existing.set(id, name);
        ids.push(id);
        return { serial: `ack-${id}` };
      },
    });
    expect(report.failed).toEqual([]);
    expect(new Set(ids).size).toBe(2);
    expect(existing.get("default_config")).toBe("新的配置");
    expect(existing.get("existing")).toBe("Raid");
    expect([...existing.values()].sort()).toEqual(
      ["Raid", "Raid (2)", "Raid (3)", "新的配置"].sort()
    );
    expect(report.imported.every((item) => item.serial.startsWith("ack-"))).toBe(true);
  });

  test("failed imports release their allocated name without changing existing profiles", async () => {
    const allocator = createProfileNameAllocator(() => ["Raid"]);
    await expect(
      importProfileArchive(
        archive(),
        async () => {
          throw new Error("rejected");
        },
        allocator
      )
    ).rejects.toThrow("rejected");
    const prepared = prepareProfileArchive(archive(), allocator);
    expect(prepared.name).toBe("Raid (2)");
  });

  test("selecting the default_config directory itself is supported", () => {
    const selected = groupProfileFolderFiles(
      [{ path: "config.json", read: async () => strToU8('{"name":"Raid"}') }],
      "default_config"
    );
    expect(selected.profiles.map((profile) => profile.folder)).toEqual(["default_config"]);
    expect(selected.profiles[0].files[0].path).toBe("default_config/config.json");
  });
});

describe("untrusted input archives", () => {
  test.each([
    "../outside",
    "/absolute",
    "C:/setup.toml",
    "default_config/../outside",
    "default_config\\config.json",
    "dir./file",
    "__proto__",
  ])("rejects unsafe member %s", (path) => {
    const files: Record<string, Uint8Array> = Object.create(null);
    files["config.json"] = strToU8('{"name":"Raid"}');
    files[path] = strToU8("outside");
    expect(() => prepareProfileArchive(zipSync(files))).toThrow();
  });

  test("rejects case-colliding names, links and ambiguous multi-profile archives", () => {
    expect(() =>
      prepareProfileArchive(
        zipSync({ "config.json": strToU8('{"name":"Raid"}'), "CONFIG.json": strToU8("{}") })
      )
    ).toThrow("Duplicate");
    expect(() =>
      prepareProfileArchive(
        zipSync({
          "config.json": strToU8('{"name":"Raid"}'),
          link: [strToU8("../outside"), { os: 3, attrs: 0o120777 << 16 }],
        })
      )
    ).toThrow("links");
    expect(() =>
      prepareProfileArchive(
        zipSync({
          "a/config.json": strToU8('{"name":"A"}'),
          "b/config.json": strToU8('{"name":"B"}'),
        })
      )
    ).toThrow("one profile");
  });

  test("rejects corrupt checksums and oversized declarations before importing", () => {
    const crcBroken = archive();
    const view = new DataView(crcBroken.buffer, crcBroken.byteOffset, crcBroken.byteLength);
    const central = Array.from({ length: crcBroken.length - 4 }, (_, index) => index).find(
      (index) => view.getUint32(index, true) === 0x02014b50
    )!;
    view.setUint32(central + 16, view.getUint32(central + 16, true) ^ 1, true);
    expect(() => prepareProfileArchive(crcBroken)).toThrow("Corrupt");
    const oversized = archive();
    const oversizedView = new DataView(
      oversized.buffer,
      oversized.byteOffset,
      oversized.byteLength
    );
    oversizedView.setUint32(central + 24, MAX_PROFILE_ARCHIVE_BYTES + 1, true);
    expect(() => prepareProfileArchive(oversized)).toThrow("too large");
  });
});
