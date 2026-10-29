import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Settings {
  url: string;
  pipe?: string;
  profile?: string;
  model?: string;
  aiBaseUrl?: string;
  packsDirectory?: string;
}

export const DEFAULT_URL = "ws://127.0.0.1:8190";

export function settingsDirectory(env = process.env): string {
  return env.BAAS_CLI_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "baas");
}

export function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
    throw new Error("服务地址需要使用 ws://、wss://、http:// 或 https://");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("服务地址不能包含凭据、查询参数或片段；登录 Key 请使用 BAAS_KEY");
  }
  url.protocol =
    url.protocol === "http:" ? "ws:" : url.protocol === "https:" ? "wss:" : url.protocol;
  return url.toString().replace(/\/+$/, "");
}

export async function loadSettings(directory = settingsDirectory()): Promise<Settings> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { url: DEFAULT_URL };
    throw new Error(
      `无法读取 CLI 配置 ${join(directory, "settings.json")}：${(error as Error).message}`
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("CLI 配置必须是 JSON 对象");
  const data = raw as Record<string, unknown>;
  const settings: Settings = {
    url: normalizeEndpoint(typeof data.url === "string" ? data.url : DEFAULT_URL),
  };
  for (const field of ["pipe", "profile", "model", "aiBaseUrl", "packsDirectory"] as const) {
    if (data[field] !== undefined && typeof data[field] !== "string")
      throw new Error(`CLI 配置 ${field} 必须是字符串`);
    if (typeof data[field] === "string" && data[field]) settings[field] = data[field];
  }
  return settings;
}

/** Persist preferences only. Backend and model credentials are deliberately environment-only. */
export async function saveSettings(
  settings: Settings,
  directory = settingsDirectory()
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "settings.json");
  const temporary = `${file}.${process.pid}.tmp`;
  const preferences = Object.fromEntries(
    ["url", "pipe", "profile", "model", "aiBaseUrl", "packsDirectory"].flatMap((key) => {
      const value = settings[key as keyof Settings];
      return typeof value === "string" && value ? [[key, value]] : [];
    })
  );
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return file;
}
