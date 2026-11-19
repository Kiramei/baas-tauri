import { platforms } from "../../baasx/scripts/distribution-platforms.mjs";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { selectPublishedReleases } from "../release-feed.mjs";
import { historicalClientRelease } from "../archive-signatures.mjs";

export function validateAssets(kind, tag, names) {
  let expected;
  if (kind === "app") {
    const version = tag.replace(/^v/, "");
    // Keep already published release snapshots verifiable without rebuilding or rewriting them.
    const historical = historicalClientRelease(tag);
    if (!historical && names.some(name => /\.(?:zip|tgz|tar\.gz)\.sig$/i.test(name)))
      throw new Error("Archive signatures belong in persistent updater metadata, not public .sig assets");
    const retired = names.filter(name => name.startsWith(`BAAS.Tauri_${version}_`) &&
      (name.includes("_fixed_webview2") || /_(?:armhf\.deb|armv7hl\.rpm)(?:\.sig)?$/.test(name)));
    if (!historical && retired.length) throw new Error("Retired client release assets: " + retired.join(", "));
    const signed = [
      "amd64.deb",
      "arm64.deb",
      "x86_64.rpm",
      "aarch64.rpm",
      ...(historical ? ["armhf.deb", "armv7hl.rpm"] : ["x86_64.AppImage", "aarch64.AppImage"]),
      "android_arm64-v8a.apk",
      ...(historical ? ["aarch64.app.tar.gz", "x64.app.tar.gz"] : []),
      "arm64-setup.exe",
      "x64-setup.exe",
      "x64_portable.exe",
      "arm64_portable.exe",
      ...(historical ? ["arm64_fixed_webview2-setup.exe", "x64_fixed_webview2-setup.exe",
        "x64_fixed_webview2_portable.zip", "arm64_fixed_webview2_portable.zip"] : []),
    ];
    const standalone = ["aarch64.dmg", "x64.dmg", ...(historical ? [] : ["aarch64.app.tar.gz", "x64.app.tar.gz"])];
    expected = [...signed.flatMap((s) => [s, s + ".sig"]), ...standalone].map(
      (s) => `BAAS.Tauri_${version}_${s}`
    );
    if (!historical) expected.push("updater-signatures-aarch64.json", "updater-signatures-x64.json");
  } else if (kind === "baasx") {
    const version = /^baasx-v?([0-9][0-9A-Za-z.+-]*)$/.exec(tag)?.[1];
    const numbers = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]+)?$/.exec(version ?? "");
    if (!numbers) throw new Error("Invalid BAASX release tag");
    const [major, minor, patch] = numbers.slice(1, 4).map(Number);
    const legacy = major === 0 && (minor < 1 || (minor === 1 && patch <= 4));
    const published = legacy
      ? platforms.filter((p) => ["Linux-X64", "macOS-ARM64", "Windows-X64"].includes(p.asset))
      : platforms;
    expected = published
      .flatMap((platform) =>
        [".tar.gz", platform.packageExtension].map((ext) => `baasx-${version}-${platform.asset}${ext}`)
      );
    expected.push("SHA256SUMS");
    if (names.some((name) => name.endsWith(".sig")))
      throw new Error("BAASX distributions must not contain signature assets");
  } else if (kind === "updater") {
    expected = ["", "-proxy", "-cnb"].map((s) => "update" + s + ".json");
  } else {
    throw new Error("Unknown release asset contract");
  }
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length) throw new Error("Missing release assets: " + missing.join(", "));
}

export function mayPromote(tag, releases) {
  const candidates = [
    ...releases.filter((r) => r.tag_name !== tag),
    { tag_name: tag, draft: false },
  ];
  return selectPublishedReleases(candidates).stable?.tag_name === tag;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, kind, tag] = process.argv.slice(2);
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (command === "verify")
    validateAssets(
      kind,
      tag,
      input.assets.map((a) => a.name)
    );
  else if (command === "promote") console.log(mayPromote(kind, input.flat()));
  else throw new Error("Expected verify or promote");
}
