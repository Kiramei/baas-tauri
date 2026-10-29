import { compareReleaseVersions, parseReleaseVersion } from "../src/shared/ReleaseVersion.mjs";

/** GitHub lists by creation time, which is not the public version ordering. */
export function selectPublishedReleases(releases) {
  const versions = releases
    .flatMap((release) => {
      const parsed = parseReleaseVersion(release?.tag_name, { allowLegacy: true });
      return release?.draft || !parsed ? [] : [{ release, parsed }];
    })
    .sort((a, b) => {
      const comparison = compareReleaseVersions(b.parsed.canonical, a.parsed.canonical);
      if (comparison) return comparison;
      return (
        Number(b.release.tag_name === b.parsed.canonical) -
        Number(a.release.tag_name === a.parsed.canonical)
      );
    });
  return {
    stable: versions.find(({ parsed }) => parsed.kind !== "rc")?.release ?? null,
    // A preview installation must also be able to graduate to final/post releases.
    preview: versions[0]?.release ?? null,
  };
}

export function releaseFeedVersion(tag) {
  const parsed = parseReleaseVersion(tag, { allowLegacy: true });
  if (!parsed) throw new Error(`Unsupported release tag: ${tag}`);
  const old = String(tag).replace(/^v/, "");
  // Historical installers used their old SemVer spelling; retain that wire value.
  const legacy = !parseReleaseVersion(tag) && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(old);
  // Tauri treats `name` as an alias for `version`; emitting both is a duplicate-field error.
  return { version: legacy ? old : parsed.semver, release_version: parsed.canonical };
}

export async function listPublishedReleases(github, options) {
  const releases = [];
  for (let page = 1; ; page++) {
    const { data } = await github.rest.repos.listReleases({ ...options, per_page: 100, page });
    releases.push(...data);
    if (data.length < 100) return releases;
  }
}
