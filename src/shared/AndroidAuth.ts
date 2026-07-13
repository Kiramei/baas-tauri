const androidPasswordKey = "baasAndroidAutoPassword";

/** Returns the stable password used by the embedded Android backend. */
export const getAndroidAutoPassword = () => {
  const stored = window.localStorage.getItem(androidPasswordKey);
  if (stored) return stored;
  const next = globalThis.crypto?.randomUUID
    ? `baas-android-${globalThis.crypto.randomUUID()}`
    : `baas-android-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(androidPasswordKey, next);
  return next;
};
