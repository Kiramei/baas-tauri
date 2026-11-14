import { URL } from "node:url";

/** Check package metadata without treating registry errors as a missing version. */
async function inspectRegistryVersion({ registry, info, token, request = globalThis.fetch }) {
  if (
    ![info?.name, info?.version, info?.integrity].every(
      (value) => typeof value === "string" && value.length > 0
    )
  ) {
    throw new Error("Package information must include a name, version and integrity");
  }
  // GitHub Packages supports the package metadata endpoint but returns 405 for
  // npm's optional /<version> endpoint.
  const metadataUrl = new URL(encodeURIComponent(info.name), registry);
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await request(metadataUrl, { headers });
  if (response.status === 404) return { status: "missing", tags: {} };
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
  const tags = metadata["dist-tags"] ?? {};
  if (!Object.prototype.hasOwnProperty.call(versions, info.version))
    return { status: "missing", tags };
  if (versions[info.version]?.dist?.integrity !== info.integrity) {
    throw new Error(`${info.name}@${info.version} already exists with different contents`);
  }
  return { status: "matching", tags };
}

export async function checkRegistryVersion(options) {
  return (await inspectRegistryVersion(options)).status;
}

// Registry version metadata is standard SemVer, independently of the desktop public version scheme.
function compareIdentifiers(left, right) {
  if (left === right) return 0;
  const numeric = /^\d+$/;
  if (numeric.test(left) && numeric.test(right)) return BigInt(left) < BigInt(right) ? -1 : 1;
  if (numeric.test(left) !== numeric.test(right)) return numeric.test(left) ? -1 : 1;
  return left < right ? -1 : 1;
}

function compareVersions(left, right) {
  const parse = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(version);
    if (!match) throw new Error("Cannot safely order registry versions");
    return [match.slice(1, 4), match[4]?.split(".") ?? []];
  };
  const [a, ap] = parse(left),
    [b, bp] = parse(right);
  for (let i = 0; i < 3; i++) {
    const difference = compareIdentifiers(a[i], b[i]);
    if (difference) return difference;
  }
  if (!ap.length || !bp.length) return Number(!ap.length) - Number(!bp.length);
  for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
    const difference = compareIdentifiers(ap[i], bp[i]);
    if (difference) return difference;
  }
  return ap.length - bp.length;
}

/** Publish the exact missing version; backfills never move the latest or next pointer backwards. */
export async function ensureRegistryPackage({ publish, tag = "latest", ...options }) {
  const { status, tags } = await inspectRegistryVersion(options);
  if (status === "matching") return status;
  const previous = tags[tag];
  const publishTag =
    previous && compareVersions(previous, options.info.version) > 0 ? "historical" : tag;
  await publish(publishTag);
  return "published";
}
