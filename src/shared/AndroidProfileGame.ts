import { SERVER_VALUES } from "./serverOptions";

export interface AndroidInstalledGame {
  packageName: string;
  label: string;
  iconPngBase64: string;
}

const GAME_PACKAGES: Record<string, string> = {
  [SERVER_VALUES.CN_OFFICIAL]: "com.RoamingStar.BlueArchive",
  [SERVER_VALUES.CN_BILIBILI]: "com.RoamingStar.BlueArchive.bilibili",
  [SERVER_VALUES.GLOBAL]: "com.nexon.bluearchive",
  [SERVER_VALUES.GLOBAL_TEEN]: "com.nexon.bluearchiveteen",
  [SERVER_VALUES.KR_ONE]: "com.nexon.bluearchiveone",
  [SERVER_VALUES.JP]: "com.YostarJP.BlueArchive",
};

/** The profile server is authoritative; installed order and old global choices are irrelevant. */
export const androidPackageForServer = (server: unknown): string | undefined =>
  typeof server === "string" ? GAME_PACKAGES[server] : undefined;

export const resolveAndroidProfileGame = (
  server: unknown,
  games: readonly AndroidInstalledGame[]
) => {
  const packageName = androidPackageForServer(server);
  if (!packageName) return { state: "unsupported" as const };
  const game = games.find((item) => item.packageName === packageName);
  return game
    ? { state: "ready" as const, packageName, game }
    : { state: "missing" as const, packageName };
};

/** Android shares one game display, so a different live scheduler owns the run slot. */
export const otherRunningAndroidProfiles = (
  statuses: Readonly<Record<string, { running?: boolean } | undefined>>,
  profileId: string | undefined
): string[] =>
  Object.entries(statuses)
    .filter(([id, status]) => id !== profileId && status?.running)
    .map(([id]) => id);

export interface AndroidProfileDisplayBinding {
  profileId: string;
  packageName: string;
  displayId: number;
}

/** A live display alone cannot prove that it belongs to the selected profile. */
export const isAndroidProfileDisplayReady = (
  binding: AndroidProfileDisplayBinding | null,
  profileId: string | undefined,
  packageName: string | undefined,
  status: { active: boolean; displayId?: number | null }
): boolean =>
  Boolean(
    status.active &&
    binding &&
    profileId &&
    packageName &&
    binding.profileId === profileId &&
    binding.packageName === packageName &&
    binding.displayId === status.displayId
  );

/** Session-only ownership: a restored app must prepare before trusting an old display. */
export class AndroidProfileGameSession {
  private binding: AndroidProfileDisplayBinding | null = null;
  private listeners = new Set<() => void>();

  getSnapshot = () => this.binding;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  claim = (binding: AndroidProfileDisplayBinding) => {
    this.binding = binding;
    this.listeners.forEach((listener) => listener());
  };
  clear = () => {
    this.binding = null;
    this.listeners.forEach((listener) => listener());
  };
}

export const androidProfileGameSession = new AndroidProfileGameSession();
