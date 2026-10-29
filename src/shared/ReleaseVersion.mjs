/** Public release names are independent of the SemVer required by native packagers. */
const number = "(0|[1-9]\\d*)";
const publicPattern = new RegExp(`^${number}\\.${number}\\.${number}(?:\\.(rc|post)${number})?$`);
const legacyRcPattern = new RegExp(
  `^${number}\\.${number}\\.${number}-rc(?:[.-]?${number})?(?:\\+[0-9A-Za-z.-]+)?$`,
  "i"
);
const nativePostPattern = new RegExp(
  `^${number}\\.${number}\\.${number}-0\\.post\\.${number}(?:\\+[0-9A-Za-z.-]+)?$`
);
const legacyStablePattern = new RegExp(`^${number}\\.${number}\\.${number}\\+[0-9A-Za-z.-]+$`);

function version(major, minor, patch, kind = "stable", serial = 0) {
  const values = [major, minor, patch, serial].map(Number);
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  [major, minor, patch, serial] = values;
  if (kind === "post" && !Number.isSafeInteger(patch + 1)) return null;
  const base = `${major}.${minor}.${patch}`;
  const canonical = kind === "stable" ? base : `${base}.${kind}${serial}`;
  const semver =
    kind === "stable"
      ? base
      : kind === "rc"
        ? `${base}-rc.${serial}`
        : `${major}.${minor}.${patch + 1}-0.post.${serial}`;
  return { canonical, base, major, minor, patch, kind, serial, semver };
}

/** Canonical names are strict; tag callers may strip one leading v before validation. */
export function parseReleaseVersion(value, { allowLegacy = false } = {}) {
  if (typeof value !== "string") return null;
  let input = value;
  if (allowLegacy) input = input.trim().replace(/^v/, "");
  const match = publicPattern.exec(input);
  if (match && match[0] === input)
    return version(match[1], match[2], match[3], match[4], match[5]);
  if (!allowLegacy) return null;
  const post = nativePostPattern.exec(input);
  if (post && Number(post[3]) > 0)
    return version(post[1], post[2], Number(post[3]) - 1, "post", post[4]);
  const rc = legacyRcPattern.exec(input);
  if (rc) return version(rc[1], rc[2], rc[3], "rc", rc[4] ?? 0);
  const stable = legacyStablePattern.exec(input);
  return stable ? version(stable[1], stable[2], stable[3]) : null;
}

export function normalizeReleaseVersion(value, { allowLegacy = true } = {}) {
  return parseReleaseVersion(value, { allowLegacy })?.canonical ?? null;
}

/** Compare numeric base components first, then rc < stable < post and numeric counters. */
export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left, { allowLegacy: true });
  const b = parseReleaseVersion(right, { allowLegacy: true });
  if (!a || !b) throw new TypeError("Cannot compare invalid release versions");
  const rank = { rc: 0, stable: 1, post: 2 };
  for (const [x, y] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
    [rank[a.kind], rank[b.kind]],
    [a.serial, b.serial],
  ]) {
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function releaseVersionFromPackage(metadata) {
  const result =
    metadata && typeof metadata === "object" && "releaseVersion" in metadata
      ? parseReleaseVersion(metadata.releaseVersion)
      : parseReleaseVersion(metadata?.version, { allowLegacy: true });
  if (!result) throw new Error("package.json must contain a valid releaseVersion or version");
  return result;
}

/** Android has a bounded integer namespace; an explicit release code can exceed this default layout. */
export function androidVersionCode(value, override) {
  const parsed = parseReleaseVersion(value, { allowLegacy: true });
  if (!parsed) throw new Error(`Invalid Android release version: ${String(value)}`);
  if (override !== undefined && override !== null && String(override).trim() !== "") {
    const code = Number(override);
    if (!Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000)
      throw new Error("BAAS_ANDROID_VERSION_CODE must be an integer between 1 and 2100000000");
    return code;
  }
  const { major, minor, patch, kind, serial } = parsed;
  if ([major, minor, patch].some((part) => part > 99) || (kind !== "stable" && serial > 498))
    throw new Error(
      "Android's default versionCode layout supports base components 0–99 and rc/post counters 0–498; set BAAS_ANDROID_VERSION_CODE explicitly for this release"
    );
  const phase = kind === "rc" ? serial : kind === "stable" ? 500 : 501 + serial;
  return ((major * 100 + minor) * 100 + patch) * 1000 + phase + 1;
}
