import { platforms } from "../../baasx/scripts/distribution-platforms.mjs";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { selectPublishedReleases } from "../release-feed.mjs";

export function validateAssets(kind, tag, names) {
  let expected;
  if (kind === "app") {
    const version = tag.replace(/^v/, "");
    const signed = [
      "amd64.deb",
      "arm64.deb",
      "armhf.deb",
      "x86_64.rpm",
      "aarch64.rpm",
      "armv7hl.rpm",
      "android_arm64-v8a.apk",
      "aarch64.app.tar.gz",
      "x64.app.tar.gz",
      "arm64-setup.exe",
      "x64-setup.exe",
      "arm64_fixed_webview2-setup.exe",
      "x64_fixed_webview2-setup.exe",
      "x64_portable.exe",
      "arm64_portable.exe",
      "x64_fixed_webview2_portable.zip",
      "arm64_fixed_webview2_portable.zip",
    ];
    const standalone = ["aarch64.dmg", "x64.dmg"];
    expected = [...signed.flatMap((s) => [s, s + ".sig"]), ...standalone].map(
      (s) => `BAAS.Tauri_${version}_${s}`
    );
  } else if (kind === "baasx") {
    const version = tag.replace(/^baasx-v/, "");
    const numbers = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]+)?$/.exec(version);
    if (!numbers) throw new Error("Invalid BAASX release version");
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
    expected = [
      "",
      "-proxy",
      "-cnb",
      "-fixed-webview2",
      "-fixed-webview2-proxy",
      "-fixed-webview2-cnb",
    ].map((s) => "update" + s + ".json");
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
