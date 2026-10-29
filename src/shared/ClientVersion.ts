import { normalizeReleaseVersion } from "./ReleaseVersion.mjs";

/** Returns a concrete client version instead of transient store placeholders. */
export const resolveClientVersion = (value: unknown, fallback = __APP_VERSION__) => {
  return normalizeReleaseVersion(value) ?? fallback;
};
