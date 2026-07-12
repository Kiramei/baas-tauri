const CLIENT_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Returns a concrete client version instead of transient store placeholders. */
export const resolveClientVersion = (value: unknown, fallback = __APP_VERSION__) => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return CLIENT_VERSION_PATTERN.test(normalized) ? normalized : fallback;
};
