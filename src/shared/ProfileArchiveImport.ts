import { Inflate, strFromU8, zipSync } from "fflate";
import { profileDisplayName } from "@/shared/ProfileName";
import { isUserProfileId } from "@/shared/ProfileTabs";

export const MAX_PROFILE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_PROFILE_FILES = 4096;

export interface ProfileNameAllocator {
  allocate(name: string): string;
  release(name: string): void;
}

export function destinationProfileNames(state: {
  configStore: Record<string, { name?: unknown } | null | undefined>;
  _receivedSnapshots: Record<string, boolean>;
}): unknown[] {
  if (!state._receivedSnapshots.config_list) return [undefined];
  return Object.values(state.configStore).map((config) => config?.name);
}

/** Reserve successful imports while their config snapshots are still in flight. */
export function createProfileNameAllocator(
  existingNames: () => Iterable<unknown> = () => []
): ProfileNameAllocator {
  const reserved = new Set<string>();
  return {
    allocate(original) {
      const occupied = new Set<string>();
      for (const value of existingNames()) {
        if (typeof value !== "string")
          throw new Error("Destination profile names are still loading");
        occupied.add(value.trim());
        occupied.add(profileDisplayName(value.trim()));
      }
      for (const name of reserved) {
        if (occupied.has(name)) reserved.delete(name);
        else occupied.add(name);
      }
      const requested = profileDisplayName(original.trim());
      let name = requested;
      if (occupied.has(name)) {
        const suffix = requested.match(/^(.*) \((\d+)\)$/);
        const base = suffix && Number(suffix[2]) >= 2 ? suffix[1] : requested;
        for (let number = 2; occupied.has(name); number++) name = `${base} (${number})`;
      }
      reserved.add(name);
      return name;
    },
    release(name) {
      reserved.delete(name);
    },
  };
}

const destinationAllocators = new WeakMap<object, ProfileNameAllocator>();

/** Concurrent import entry points on the same destination must share reservations. */
export function profileNameAllocatorFor(
  destination: object | undefined,
  names: () => Iterable<unknown>
): ProfileNameAllocator {
  if (!destination) return createProfileNameAllocator(names);
  let allocator = destinationAllocators.get(destination);
  if (!allocator) {
    allocator = createProfileNameAllocator(names);
    destinationAllocators.set(destination, allocator);
  }
  return allocator;
}

function safePath(path: string): void {
  const parts = path.replace(/\/$/, "").split("/");
  if (
    !parts.length ||
    parts.length > 32 ||
    new TextEncoder().encode(path).length > 512 ||
    path === "__proto__" ||
    /[\\:\0]/.test(path) ||
    parts.some((part) => !part || part === "." || part === ".." || /[ .]$/.test(part))
  ) {
    throw new Error("Invalid profile archive path");
  }
}

interface ZipMember {
  name: string;
  crc: number;
  size: number;
  directory: boolean;
  compressed: number;
  compression: number;
  dataStart: number;
}

/** Inspect central metadata before fflate can collapse duplicate names or inflate oversized files. */
function inspectZip(bytes: Uint8Array): ZipMember[] {
  if (bytes.length < 22 || bytes.length > MAX_PROFILE_ARCHIVE_BYTES)
    throw new Error("Invalid or oversized profile archive");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  const minimum = Math.max(0, bytes.length - 65557);
  for (; end >= minimum; end--) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    )
      break;
  }
  if (end < minimum) throw new Error("Invalid ZIP directory");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const directoryStart = offset;
  const directoryEnd = offset + view.getUint32(end + 12, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    count !== view.getUint16(end + 8, true) ||
    !count ||
    count > MAX_PROFILE_FILES ||
    directoryEnd !== end
  ) {
    throw new Error("Unsupported profile ZIP directory");
  }
  const names = new Set<string>();
  const members: ZipMember[] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("Invalid ZIP member");
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const next =
      offset +
      46 +
      nameLength +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    if (next > directoryEnd || flags & 1 || (compression !== 0 && compression !== 8))
      throw new Error("Unsupported profile ZIP member");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = strFromU8(nameBytes, !(flags & 0x800));
    safePath(name);
    const canonical = name.replace(/\/$/, "").toLowerCase();
    if (names.has(canonical)) throw new Error("Duplicate profile archive path");
    names.add(canonical);
    const attributes = view.getUint32(offset + 38, true);
    const fileType = (attributes >>> 16) & 0o170000;
    if (attributes & 0x400 || (fileType && fileType !== 0o100000 && fileType !== 0o040000))
      throw new Error("Profile archive links and special files are not supported");
    total += size;
    if (total > MAX_PROFILE_ARCHIVE_BYTES) throw new Error("Profile archive is too large");
    const local = view.getUint32(offset + 42, true);
    if (
      local + 30 > offset ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== compression
    )
      throw new Error("Invalid ZIP local header");
    const localNameLength = view.getUint16(local + 26, true);
    const dataStart = local + 30 + localNameLength + view.getUint16(local + 28, true);
    if (
      dataStart + compressed > directoryStart ||
      localNameLength !== nameLength ||
      nameBytes.some((byte, position) => bytes[local + 30 + position] !== byte)
    )
      throw new Error("Invalid ZIP file layout");
    members.push({
      name,
      size,
      crc: view.getUint32(offset + 16, true),
      directory: name.endsWith("/") || fileType === 0o040000,
      compressed,
      compression,
      dataStart,
    });
    offset = next;
  }
  if (offset !== directoryEnd) throw new Error("Invalid ZIP directory length");
  return members;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  for (let bit = 0; bit < 8; bit++) index = (index >>> 1) ^ (index & 1 ? 0xedb88320 : 0);
  return index >>> 0;
});
const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
};

function archiveFiles(input: ArrayBuffer | Uint8Array): Record<string, Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const members = inspectZip(bytes);
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const member of members) {
    if (member.directory) continue;
    const data = new Uint8Array(member.size);
    let written = 0;
    if (member.compression === 0) {
      if (member.compressed !== member.size) throw new Error("Corrupt profile archive size");
      data.set(bytes.subarray(member.dataStart, member.dataStart + member.size));
      written = member.size;
    } else {
      const inflater = new Inflate((chunk) => {
        if (written + chunk.length > member.size) throw new Error("Corrupt profile archive size");
        data.set(chunk, written);
        written += chunk.length;
      });
      // Bounded compressed pushes also bound a forged stream's temporary output.
      for (let position = 0; position < member.compressed; position += 1024) {
        const end = Math.min(position + 1024, member.compressed);
        inflater.push(
          bytes.subarray(member.dataStart + position, member.dataStart + end),
          end === member.compressed
        );
      }
    }
    if (written !== member.size || crc32(data) !== member.crc)
      throw new Error("Corrupt profile archive data");
    files[member.name] = data;
  }
  return files;
}

function freshId(): string {
  if (globalThis.crypto?.randomUUID) return `profile-${globalThis.crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return `profile-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export interface PreparedProfileArchive {
  id: string;
  filename: string;
  name: string;
  bytes: Uint8Array;
}

export function prepareProfileFiles(
  files: Record<string, Uint8Array>,
  allocator = createProfileNameAllocator()
): PreparedProfileArchive {
  const paths = Object.keys(files);
  const canonical = new Set<string>();
  let total = 0;
  for (const path of paths) {
    safePath(path);
    if (canonical.has(path.toLowerCase())) throw new Error("Duplicate profile archive path");
    canonical.add(path.toLowerCase());
    total += files[path].length;
  }
  if (paths.length > MAX_PROFILE_FILES || total > MAX_PROFILE_ARCHIVE_BYTES)
    throw new Error("Profile archive is too large");
  const roots = paths
    .filter((path) => path === "config.json" || path.endsWith("/config.json"))
    .sort((left, right) => left.split("/").length - right.split("/").length);
  if (
    !roots.length ||
    (roots.length > 1 && roots[0].split("/").length === roots[1].split("/").length)
  )
    throw new Error("Archive must contain one profile config.json");
  const configPath = roots[0];
  const prefix = configPath.slice(0, -"config.json".length);
  const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files[configPath]));
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    typeof config.name !== "string" ||
    !config.name.trim()
  )
    throw new Error("Profile config.json must contain a name");
  const id = freshId();
  const name = allocator.allocate(config.name);
  try {
    const archive: Record<string, Uint8Array> = Object.create(null);
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const destination = `${id}/${path.slice(prefix.length)}`;
      safePath(destination);
      archive[destination] =
        path === configPath && name !== config.name
          ? new TextEncoder().encode(JSON.stringify({ ...config, name }, null, 2))
          : files[path];
    }
    return { id, filename: `${id}.zip`, name, bytes: zipSync(archive) };
  } catch (error) {
    allocator.release(name);
    throw error;
  }
}

export function prepareProfileArchive(
  bytes: ArrayBuffer | Uint8Array,
  allocator = createProfileNameAllocator()
): PreparedProfileArchive {
  return prepareProfileFiles(archiveFiles(bytes), allocator);
}

export async function sendProfileArchive<T extends { serial: string }>(
  prepared: PreparedProfileArchive,
  send: (name: string, bytes: Uint8Array) => Promise<T>,
  allocator: ProfileNameAllocator
): Promise<T> {
  try {
    const result = await send(prepared.filename, prepared.bytes);
    if (!isUserProfileId(result?.serial)) throw new Error("Missing imported profile ID");
    return result;
  } catch (error) {
    allocator.release(prepared.name);
    throw error;
  }
}

export async function importProfileArchive<T extends { serial: string }>(
  bytes: ArrayBuffer | Uint8Array,
  send: (name: string, bytes: Uint8Array) => Promise<T>,
  allocator = createProfileNameAllocator()
): Promise<T> {
  return sendProfileArchive(prepareProfileArchive(bytes, allocator), send, allocator);
}
