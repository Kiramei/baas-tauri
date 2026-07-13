const chunkGroups: Record<string, string[]> = {
  libsodium: ["libsodium-wrappers-sumo"],
};

const belongsToPackage = (id: string, packageName: string) => {
  const normalized = id.replaceAll("\\", "/");
  return normalized.includes(`/node_modules/${packageName}/`);
};

/** Keeps core caches stable without pulling route-specific UI packages into startup. */
export const manualChunks = (id: string): string | undefined => {
  if (!id.includes("node_modules")) return undefined;

  for (const [chunk, packages] of Object.entries(chunkGroups)) {
    if (packages.some((packageName) => belongsToPackage(id, packageName))) return chunk;
  }

  return undefined;
};
