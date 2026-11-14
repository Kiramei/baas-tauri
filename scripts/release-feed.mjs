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
    stable:
      versions.find(({ release, parsed }) => !release.prerelease && parsed.kind !== "rc")
        ?.release ?? null,
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

// Linux installers ask for {os}-{arch}-{bundle}, since DEB and RPM cannot replace one another.
const standardPlatforms = {
  "amd64.deb": ["linux-x86_64-deb"],
  "x86_64.rpm": ["linux-x86_64-rpm"],
  "arm64.deb": ["linux-aarch64-deb"],
  "aarch64.rpm": ["linux-aarch64-rpm"],
  "armhf.deb": ["linux-armv7-deb"],
  "armv7hl.rpm": ["linux-armv7-rpm"],
  "android_arm64-v8a.apk": ["android-arm64-v8a"],
  "x64-setup.exe": ["windows-x86_64", "win64"],
  "arm64-setup.exe": ["windows-aarch64"],
  "x86-setup.exe": ["windows-x86", "windows-i686"],
  "aarch64.app.tar.gz": ["darwin-aarch64"],
  "x64.app.tar.gz": ["darwin-x86_64", "darwin-intel", "darwin"],
};

const fixedWebViewPlatforms = {
  "x64_fixed_webview2-setup.exe": ["windows-x86_64"],
  "arm64_fixed_webview2-setup.exe": ["windows-aarch64"],
  "x86_fixed_webview2-setup.exe": ["windows-x86", "windows-i686"],
};

/** Historical releases may lack an installer or its signature. Advertise only matching pairs. */
export async function signedReleasePlatforms(
  release,
  { fixedWebView2 = false, fetchSignature = fetch } = {}
) {
  const assets = new Map(release.assets.map((asset) => [asset.name, asset.browser_download_url]));
  const prefix = `BAAS.Tauri_${release.tag_name.replace(/^v/, "")}_`;
  const platforms = {};
  const formats = fixedWebView2 ? fixedWebViewPlatforms : standardPlatforms;
  await Promise.all(
    Object.entries(formats).map(async ([suffix, targets]) => {
      const name = prefix + suffix;
      const url = assets.get(name);
      const sigUrl = assets.get(name + ".sig");
      if (!url || !sigUrl) return;
      const response = await fetchSignature(sigUrl);
      if (!response.ok)
        throw new Error(`Could not read updater signature at ${sigUrl}: HTTP ${response.status}`);
      const signature = (await response.text()).trim();
      if (!signature) throw new Error(`Empty updater signature for ${name}`);
      for (const target of targets) platforms[target] = { url, signature };
    })
  );
  return platforms;
}
