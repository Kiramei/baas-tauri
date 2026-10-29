import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectPublishedReleases, releaseFeedVersion } from "../../scripts/release-feed.mjs";
import { parseUpdateLog } from "../../scripts/update-log.mjs";
import { setReleaseVersion } from "../../scripts/set-release-version.mjs";
import {
  checkReleaseVersion,
  nativeReleaseVersions,
} from "../../scripts/release-version-files.mjs";
import { parseReleaseVersion } from "../../src/shared/ReleaseVersion.mjs";

const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
);
const release = (tag_name: string, draft = false) => ({ tag_name, draft, assets: [] });

test("release feeds sort numeric public versions instead of GitHub creation order", () => {
  const rows = [
    release("0.0.9.rc10"),
    release("0.0.9.post2"),
    release("v0.0.9"),
    release("0.0.9.rc2"),
    release("8.0.0", true),
    release("updater"),
  ];
  expect(selectPublishedReleases(rows).stable?.tag_name).toBe("0.0.9.post2");
  expect(selectPublishedReleases(rows).preview?.tag_name).toBe("0.0.9.post2");
  expect(selectPublishedReleases([...rows, release("0.0.10.rc0")]).preview?.tag_name).toBe(
    "0.0.10.rc0"
  );
  expect(selectPublishedReleases([...rows, release("0.0.10.rc0")]).stable?.tag_name).toBe(
    "0.0.9.post2"
  );
});

test("feed wire versions satisfy native SemVer and do not duplicate Tauri's name alias", () => {
  expect(releaseFeedVersion("0.0.9.post2")).toEqual({
    version: "0.0.10-0.post.2",
    release_version: "0.0.9.post2",
  });
  expect(releaseFeedVersion("v0.0.9.post2")).toEqual({
    version: "0.0.10-0.post.2",
    release_version: "0.0.9.post2",
  });
  expect(releaseFeedVersion("0.0.9.rc0")).toEqual({
    version: "0.0.9-rc.0",
    release_version: "0.0.9.rc0",
  });
  expect(releaseFeedVersion("v0.0.8-rc").version).toBe("0.0.8-rc");
  expect(releaseFeedVersion("v0.0.8-rc1").version).toBe("0.0.8-rc1");
  expect(releaseFeedVersion("0.0.9")).not.toHaveProperty("name");
});

test("new changelog headings and historical headings share canonical lookups", () => {
  const notes = parseUpdateLog("## 0.0.9.post2\nFixed\n## Details\nMore\n---\n## v0.0.8-rc\nOld\n");
  expect(notes.get("0.0.9.post2")).toBe("Fixed\n## Details\nMore");
  expect(notes.get("0.0.8.rc0")).toBe("Old");
  expect(() => parseUpdateLog("## 0.0.9\nA\n---\n## v0.0.9\nB")).toThrow("Duplicate");
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baas-release-version-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"baas-tauri","version":"0.0.9"}\n');
  fs.writeFileSync(path.join(root, "src-tauri/tauri.conf.json"), '{"version":"0.0.9"}\n');
  fs.writeFileSync(
    path.join(root, "src-tauri/tauri.macos.conf.json"),
    '{"bundle":{"macOS":{"minimumSystemVersion":"11.0"}}}\n'
  );
  fs.writeFileSync(
    path.join(root, "src-tauri/Cargo.toml"),
    '[package]\nname = "baas-tauri"\nversion = "0.0.9"\nedition = "2021"\n'
  );
  fs.writeFileSync(
    path.join(root, "Cargo.lock"),
    'version = 4\n\n[[package]]\nname = "baas-tauri"\nversion = "0.0.9"\n'
  );
  return root;
}

test("future release preparation preserves public spelling and synchronizes native manifests", () => {
  const root = fixture();
  expect(setReleaseVersion(root, "0.0.9.post2", { dryRun: true }).semver).toBe("0.0.10-0.post.2");
  expect(checkReleaseVersion(root, "0.0.9").canonical).toBe("0.0.9");
  expect(fs.existsSync(path.join(root, "src-tauri/packages"))).toBe(false);
  setReleaseVersion(root, "0.0.9.post2");
  expect(checkReleaseVersion(root, "0.0.9.post2").semver).toBe("0.0.10-0.post.2");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  expect(pkg.releaseVersion).toBe("0.0.9.post2");
  expect(pkg.version).toBe("0.0.10-0.post.2");
  expect(
    fs.readFileSync(path.join(root, "src-tauri/packages/windows/release-version.nsh"), "utf8")
  ).toContain('BAAS_RELEASE_VERSION "0.0.9.post2"');
  expect(
    fs.readFileSync(path.join(root, "src-tauri/packages/macos/release-version.plist"), "utf8")
  ).toContain("<string>0.0.9</string>");
  const mac = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri/tauri.macos.conf.json"), "utf8")
  );
  expect(mac.bundle.macOS.minimumSystemVersion).toBe("11.0");
  expect(checkReleaseVersion(root, "v0.0.9.post2").canonical).toBe("0.0.9.post2");
  expect(() => checkReleaseVersion(root, "v0.0.9-rc2")).toThrow("optional v prefix");
  expect(() => checkReleaseVersion(root, "0.0.9")).toThrow("does not match");
});

test("native integer versions retain rc0 < rc10 < stable < post0 < post2 < next rc0", () => {
  const versions = [
    "0.0.9.rc0",
    "0.0.9.rc10",
    "0.0.9",
    "0.0.9.post0",
    "0.0.9.post2",
    "0.0.10.rc0",
  ].map((input) => nativeReleaseVersions(parseReleaseVersion(input)!, {}));
  for (const key of ["windows", "mac"] as const) {
    const numeric = (text: string) => text.split(".").map(Number);
    const compare = (a: string, b: string) => {
      const x = numeric(a),
        y = numeric(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
      return 0;
    };
    for (let index = 1; index < versions.length; index++)
      expect(compare(versions[index - 1][key], versions[index][key])).toBeLessThan(0);
  }
  expect(() => nativeReleaseVersions(parseReleaseVersion("0.0.9.rc499")!, {})).toThrow(
    "BAAS_WINDOWS_BUNDLE_VERSION"
  );
});

test("future preparation synchronizes every workspace crate and its lock entry", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "Cargo.toml"),
    '[workspace]\nmembers = ["src-tauri", "crates/baas-updater"]\n'
  );
  fs.mkdirSync(path.join(root, "crates/baas-updater"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "crates/baas-updater/Cargo.toml"),
    '[package]\nname = "baas-updater"\nversion = "0.0.9"\n'
  );
  fs.appendFileSync(
    path.join(root, "Cargo.lock"),
    '\n[[package]]\nname = "baas-updater"\nversion = "0.0.9"\n'
  );
  setReleaseVersion(root, "0.0.10.rc0");
  expect(checkReleaseVersion(root, "v0.0.10.rc0").canonical).toBe("0.0.10.rc0");
  expect(fs.readFileSync(path.join(root, "crates/baas-updater/Cargo.toml"), "utf8")).toContain(
    'version = "0.0.10-rc.0"'
  );
  expect(
    fs.readFileSync(path.join(root, "Cargo.lock"), "utf8").match(/version = "0.0.10-rc.0"/g)
  ).toHaveLength(2);
  fs.writeFileSync(
    path.join(root, "Cargo.lock"),
    fs
      .readFileSync(path.join(root, "Cargo.lock"), "utf8")
      .replace(
        'name = "baas-updater"\nversion = "0.0.10-rc.0"',
        'name = "baas-updater"\nversion = "0.0.9"'
      )
  );
  expect(() => checkReleaseVersion(root, "0.0.10.rc0")).toThrow(
    "Cargo.lock must contain baas-updater"
  );
});

test("large native counters require explicit platform overrides instead of sorting after final", () => {
  const parsed = parseReleaseVersion("0.0.9.rc500")!;
  expect(() => nativeReleaseVersions(parsed, { BAAS_ANDROID_VERSION_CODE: "9700" })).toThrow(
    "BAAS_WINDOWS_BUNDLE_VERSION"
  );
  expect(
    nativeReleaseVersions(parsed, {
      BAAS_ANDROID_VERSION_CODE: "9700",
      BAAS_WINDOWS_BUNDLE_VERSION: "0.0.9.499",
    }).windows
  ).toBe("0.0.9.499");
  const root = fixture();
  setReleaseVersion(root, parsed.canonical, {
    env: { BAAS_ANDROID_VERSION_CODE: "9700", BAAS_WINDOWS_BUNDLE_VERSION: "0.0.9.499" },
  });
  const tauri = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  expect(tauri.bundle.android.versionCode).toBe(9700);
  expect(checkReleaseVersion(root, "v0.0.9.rc500").canonical).toBe(parsed.canonical);
});

test("release checks reject stale native display files after a manual manifest bump", () => {
  const root = fixture();
  setReleaseVersion(root, "0.0.9.post2");
  const header = path.join(root, "src-tauri/packages/windows/release-version.nsh");
  const correctHeader = fs.readFileSync(header, "utf8");
  fs.writeFileSync(header, correctHeader.replace("0.0.9.post2", "0.0.9"));
  expect(() => checkReleaseVersion(root, "0.0.9.post2")).toThrow(
    "Windows release-version.nsh is stale"
  );
  fs.writeFileSync(header, correctHeader);
  const plist = path.join(root, "src-tauri/packages/macos/release-version.plist");
  const correctPlist = fs.readFileSync(plist, "utf8");
  fs.writeFileSync(
    plist,
    correctPlist.replace("<string>0.0.9.post2</string>", "<string>0.0.9</string>")
  );
  expect(() => checkReleaseVersion(root, "0.0.9.post2")).toThrow(
    "macOS release-version.plist is stale"
  );
  fs.writeFileSync(plist, correctPlist.replace("<string>0.0.9</string>", "<string>0.0.8</string>"));
  expect(() => checkReleaseVersion(root, "0.0.9.post2")).toThrow(
    "macOS release-version.plist is stale"
  );
});
