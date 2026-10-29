import fs from "node:fs";
import path from "node:path";
import {
  androidVersionCode,
  parseReleaseVersion,
  releaseVersionFromPackage,
} from "../src/shared/ReleaseVersion.mjs";

const json = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

export function workspaceReleasePackages(root) {
  const workspace = path.join(root, "Cargo.toml");
  const members = fs.existsSync(workspace)
    ? [
        ...(
          fs
            .readFileSync(workspace, "utf8")
            .match(/\[workspace\][\s\S]*?members\s*=\s*\[([^\]]+)\]/)?.[1] ?? ""
        ).matchAll(/"([^"]+)"/g),
      ].map((match) => match[1])
    : ["src-tauri"];
  if (!members.length) throw new Error("No explicit Cargo workspace members found");
  return members.map((member) => {
    if (member.includes("*") || member.includes("..") || path.isAbsolute(member))
      throw new Error(`Expected a local explicit Cargo workspace member: ${member}`);
    const relative = path.join(member, "Cargo.toml");
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    const name = source.match(/\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = source.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!name || !version) throw new Error(`Expected explicit package name/version in ${relative}`);
    return { relative, source, name, version };
  });
}

export function cargoLockVersionPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(\\[\\[package\\]\\]\\s*\\nname = "${escaped}"\\s*\\nversion = ")[^"]+("\\r?\\n)`
  );
}

export function readReleaseState(root) {
  const metadata = json(root, "package.json");
  const release = releaseVersionFromPackage(metadata);
  const tauri = json(root, "src-tauri/tauri.conf.json");
  const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = cargo.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  return { metadata, release, tauri, cargo, cargoVersion };
}

export function checkReleaseVersion(root, tag) {
  const canonical = typeof tag === "string" ? tag.replace(/^v/, "") : tag;
  const requested = parseReleaseVersion(canonical);
  if (!requested)
    throw new Error(
      "New release tags must be x.y.z, x.y.z.rcN or x.y.z.postN, with an optional v prefix"
    );
  const state = readReleaseState(root);
  const packages = workspaceReleasePackages(root);
  if (state.release.canonical !== canonical)
    throw new Error(`Tag ${tag} does not match package release version ${state.release.canonical}`);
  for (const [name, value] of [
    ["package.json", state.metadata.version],
    ["tauri.conf.json", state.tauri.version],
    ["Cargo.toml", state.cargoVersion],
    ...packages.map((member) => [member.relative, member.version]),
  ]) {
    if (value !== requested.semver)
      throw new Error(
        `${name} version must be ${requested.semver} for release ${tag}; found ${value}`
      );
  }
  const lockPath = path.join(root, "Cargo.lock");
  if (fs.existsSync(lockPath)) {
    const lock = fs.readFileSync(lockPath, "utf8");
    for (const member of packages) {
      const match = cargoLockVersionPattern(member.name).exec(lock);
      if (!match || !match[0].includes(`version = "${requested.semver}"`))
        throw new Error(`Cargo.lock must contain ${member.name} ${requested.semver}`);
    }
  }
  if (Object.hasOwn(state.metadata, "releaseVersion")) {
    const header = fs.readFileSync(
      path.join(root, "src-tauri/packages/windows/release-version.nsh"),
      "utf8"
    );
    if (header.match(/^!define BAAS_RELEASE_VERSION "([^"]+)"/m)?.[1] !== requested.canonical)
      throw new Error(
        "Windows release-version.nsh is stale; run the release version preparation tool"
      );
    const plist = fs.readFileSync(
      path.join(root, "src-tauri/packages/macos/release-version.plist"),
      "utf8"
    );
    const plistValue = (key) =>
      plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
    if (
      plistValue("BAASReleaseVersion") !== requested.canonical ||
      plistValue("CFBundleShortVersionString") !== requested.base
    )
      throw new Error(
        "macOS release-version.plist is stale; run the release version preparation tool"
      );
    const macConfig = json(root, "src-tauri/tauri.macos.conf.json");
    if (
      macConfig.bundle?.macOS?.infoPlist !== "packages/macos/release-version.plist" ||
      macConfig.bundle.macOS.bundleVersion !== plistValue("CFBundleVersion")
    )
      throw new Error("macOS bundle configuration does not match the prepared release plist");
  }
  return requested;
}

export function nativeReleaseVersions(release, env = process.env) {
  const phase =
    release.kind === "rc" ? release.serial : release.kind === "stable" ? 500 : 501 + release.serial;
  if (!env.BAAS_WINDOWS_BUNDLE_VERSION && release.kind !== "stable" && release.serial > 498)
    throw new Error(
      "Default Windows rc/post mapping supports counters 0–498; set BAAS_WINDOWS_BUNDLE_VERSION explicitly"
    );
  const windows = env.BAAS_WINDOWS_BUNDLE_VERSION ?? `${release.base}.${phase}`;
  const windowsParts = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(windows);
  if (!windowsParts || windowsParts.slice(1).some((value) => Number(value) > 65535))
    throw new Error("Windows native version components must fit an unsigned 16-bit integer");
  const android = androidVersionCode(release.canonical, env.BAAS_ANDROID_VERSION_CODE);
  let mac = env.BAAS_MAC_BUNDLE_VERSION;
  if (!mac) {
    const ordinal = android + 10000;
    mac = `${Math.floor(ordinal / 10000)}.${Math.floor(ordinal / 100) % 100}.${ordinal % 100}`;
  }
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(mac);
  if (
    !parts ||
    Number(parts[1]) < 1 ||
    Number(parts[1]) > 9999 ||
    Number(parts[2]) > 99 ||
    Number(parts[3]) > 99
  )
    throw new Error(
      "Set BAAS_MAC_BUNDLE_VERSION to a monotonically increasing numeric version within 1–9999.0–99.0–99"
    );
  return { android, windows, mac };
}
