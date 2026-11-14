import { compareReleaseVersions, parseReleaseVersion } from "../src/shared/ReleaseVersion.mjs";
import { archiveSignatureAsset, historicalClientRelease, readArchiveSignatureMetadata } from "./archive-signatures.mjs";

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

// Linux updates select the running bundle format, including AppImage on DEB/RPM hosts.
const standardPlatforms = {
  "amd64.deb": ["linux-x86_64-deb"],
  "x86_64.rpm": ["linux-x86_64-rpm"],
  "arm64.deb": ["linux-aarch64-deb"],
  "aarch64.rpm": ["linux-aarch64-rpm"],
  "x86_64.AppImage": ["linux-x86_64-appimage"],
  "aarch64.AppImage": ["linux-aarch64-appimage"],
  "android_arm64-v8a.apk": ["android-arm64-v8a"],
  "x64-setup.exe": ["windows-x86_64", "win64"],
  "arm64-setup.exe": ["windows-aarch64"],
  "x64_portable.exe": ["windows-x86_64-portable"],
  "arm64_portable.exe": ["windows-aarch64-portable"],
  "x86-setup.exe": ["windows-x86", "windows-i686"],
  "aarch64.app.tar.gz": ["darwin-aarch64"],
  "x64.app.tar.gz": ["darwin-x86_64", "darwin-intel", "darwin"],
};

/** Historical releases may lack an installer or its signature. Advertise only matching pairs. */
export async function signedReleasePlatforms(
  release,
  { fetchSignature = fetch } = {}
) {
  const assets = new Map(release.assets.map((asset) => [asset.name, asset.browser_download_url]));
  const prefix = `BAAS.Tauri_${release.tag_name.replace(/^v/, "")}_`;
  const platforms = {};
  await Promise.all(
    Object.entries(standardPlatforms).map(async ([suffix, targets]) => {
      const name = prefix + suffix;
      const url = assets.get(name);
      const sigUrl = assets.get(name + ".sig");
      if (!url) return;
      let signature;
      const metadataName = archiveSignatureAsset(suffix);
      const metadataUrl = metadataName && assets.get(metadataName);
      if (metadataUrl) {
        const response = await fetchSignature(metadataUrl);
        if (!response.ok) throw new Error(`Could not read archive signature metadata at ${metadataUrl}: HTTP ${response.status}`);
        signature = readArchiveSignatureMetadata(await response.json(), { tag: release.tag_name, filename: name });
      } else {
        if (metadataName && !historicalClientRelease(release.tag_name))
          throw new Error(`Missing persistent archive signature metadata: ${metadataName}`);
        if (!sigUrl) return;
        const response = await fetchSignature(sigUrl);
        if (!response.ok)
          throw new Error(`Could not read updater signature at ${sigUrl}: HTTP ${response.status}`);
        signature = (await response.text()).trim();
      }
      if (!signature) throw new Error(`Empty updater signature for ${name}`);
      for (const target of targets) platforms[target] = { url, signature };
    })
  );
  return platforms;
}

/** Every download source retains exactly the same architecture, format and signature. */
export function releaseFeedVariants(data) {
  const mapUrls = transform => ({
    ...data,
    platforms: Object.fromEntries(Object.entries(data.platforms).map(([target, payload]) => [
      target, { ...payload, url: transform(payload.url) },
    ])),
  });
  return {
    github: data,
    proxy: mapUrls(url => "https://gh-proxy.org/" + url),
    cnb: mapUrls(url => url.replace(
      "https://github.com/Kiramei/baas-tauri/",
      "https://cnb.cool/kiramei/baas-tauri/-/"
    )),
  };
}
