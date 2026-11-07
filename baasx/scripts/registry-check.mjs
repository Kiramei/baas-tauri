import { URL } from "node:url";

/** Check package metadata without treating registry errors as a missing version. */
export async function checkRegistryVersion({ registry, info, token, request = globalThis.fetch }) {
  if (![info?.name, info?.version, info?.integrity].every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("Package information must include a name, version and integrity");
  }
  // GitHub Packages supports the package metadata endpoint but returns 405 for
  // npm's optional /<version> endpoint.
  const metadataUrl = new URL(encodeURIComponent(info.name), registry);
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await request(metadataUrl, { headers });
  if (response.status === 404) return "missing";
  if (!response.ok) {
    throw new Error(
      `Cannot inspect ${info.name}@${info.version} on ${registry}: HTTP ${response.status}`
    );
  }
  const metadata = await response.json();
  const versions = metadata?.versions;
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    throw new Error(`Invalid registry metadata for ${info.name} on ${registry}`);
  }
  if (!Object.prototype.hasOwnProperty.call(versions, info.version)) return "missing";
  if (versions[info.version]?.dist?.integrity !== info.integrity) {
    throw new Error(`${info.name}@${info.version} already exists with different contents`);
  }
  return "matching";
}

/** Publish only when metadata confirms that this version is absent. */
export async function ensureRegistryPackage({ publish, ...options }) {
  if ((await checkRegistryVersion(options)) === "matching") return "matching";
  await publish();
  return "published";
}
