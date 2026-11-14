import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  selectPublishedReleases,
  releaseFeedVersion,
  signedReleasePlatforms,
} from "../../scripts/release-feed.mjs";
import { parseUpdateLog } from "../../scripts/update-log.mjs";
import { setReleaseVersion } from "../../scripts/set-release-version.mjs";
import {
  checkReleaseVersion,
  nativeReleaseVersions,
} from "../../scripts/release-version-files.mjs";
import { parseReleaseVersion } from "../../src/shared/ReleaseVersion.mjs";
import { validateAssets } from "../../scripts/ci/release-contract.mjs";
import { existingRelease, parseAppReleaseTag, publishExistingRelease, uploadedAssets } from "../../scripts/release-publication.mjs";

const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
);
const release = (tag_name: string, draft = false) => ({ tag_name, draft, assets: [] });

function publicationFixture(tag = "0.0.10", options: { published?: boolean; newer?: boolean; mutate?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baas-publish-existing-"));
  temporary.push(root);
  const notes = path.join(root, "notes.md");
  fs.writeFileSync(notes, "Original version notes\n\nWindows, macOS, Linux and Android downloads.\n");
  const suffixes = ["amd64.deb", "arm64.deb", "armhf.deb", "x86_64.rpm", "aarch64.rpm", "armv7hl.rpm", "android_arm64-v8a.apk", "aarch64.app.tar.gz", "x64.app.tar.gz", "arm64-setup.exe", "x64-setup.exe", "arm64_fixed_webview2-setup.exe", "x64_fixed_webview2-setup.exe", "x64_portable.exe", "arm64_portable.exe", "x64_fixed_webview2_portable.zip", "arm64_fixed_webview2_portable.zip"];
  const names = [...suffixes.flatMap(name => [name, name + ".sig"]), "aarch64.dmg", "x64.dmg"];
  const assets = names.map((name, i) => ({ id: i + 1, name: `BAAS.Tauri_${tag.replace(/^v/, "")}_${name}`, state: "uploaded", size: 100 + i, digest: "sha256:" + "a".repeat(64), updated_at: "stable" }));
  const source = { id: 500, tag_name: tag, draft: !options.published, prerelease: tag.includes(".rc"), body: "Original published text", name: "Original title" };
  const writes: Record<string, unknown>[] = [];
  const calls: string[][] = [];
  let lists = 0, assetReads = 0;
  const run = (_command: string, args: string[], processOptions: { stdio: unknown[] }) => {
    calls.push(args);
    const endpoint = args[1];
    let value: unknown;
    if (args.includes("PATCH")) {
      const payload = JSON.parse(fs.readFileSync(args[args.indexOf("--input") + 1], "utf8"));
      writes.push(payload);
      value = { ...source, ...payload };
    } else if (endpoint.endsWith("releases?per_page=100")) {
      lists++;
      expect(args).toContain("--paginate");
      expect(args).toContain("--slurp");
      const selected = options.mutate === "duplicate" ? [source, source] : options.mutate === "missing" ? [] : [source];
      value = [selected, options.newer ? [{ id: 501, tag_name: "1.0.0", draft: false }] : []];
      if (lists === 2 && options.mutate === "published-during-check") value = [[{ ...source, draft: false }]];
    } else if (endpoint.includes("/assets?per_page=100")) {
      assetReads++;
      expect(args).toContain("--paginate");
      expect(args).toContain("--slurp");
      const rows = structuredClone(assets);
      if (options.mutate === "starter") rows[0].state = "starter";
      if (options.mutate === "empty") rows[0].size = 0;
      if (options.mutate === "signature") rows.splice(1, 1);
      if (options.mutate === "asset-id") rows[1].id = rows[0].id;
      if (options.mutate === "asset-name") rows[1].name = rows[0].name;
      if (assetReads === 2 && options.mutate === "changed") rows[0].digest = "sha256:" + "b".repeat(64);
      value = [rows.slice(0, 30), rows.slice(30)];
    } else if (endpoint.endsWith("/500")) value = source;
    else throw new Error("Unexpected API request: " + args.join(" "));
    fs.writeFileSync(processOptions.stdio[1] as number, JSON.stringify(value));
    return Buffer.alloc(0);
  };
  return { assets, source, writes, calls, publish: () => publishExistingRelease({ tag, repository: "owner/repo", notesPath: notes, tempRoot: root, run: run as never }) };
}

test("existing-release publication verifies all paginated signed assets and only patches the verified draft", () => {
  const fixture = publicationFixture();
  expect(uploadedAssets("0.0.10", [fixture.assets.slice(0, 30), fixture.assets.slice(30)])).toHaveLength(36);
  expect(fixture.publish()).toMatchObject({ tag: "0.0.10", id: 500, assets: 36, changed: true, makeLatest: true });
  expect(fixture.writes).toEqual([{ name: "BAAS Tauri App 0.0.10", body: "Original version notes\n\nWindows, macOS, Linux and Android downloads.\n", draft: false, prerelease: false, make_latest: "true" }]);
  expect(fixture.calls.filter(args => args.includes("PATCH"))).toHaveLength(1);
  expect(fixture.calls.some(args => args.some(value => ["POST", "DELETE", "PUT"].includes(value)))).toBe(false);
});

test("publication recovery rejects malformed tags, missing/duplicate releases and incomplete or changing assets without writing", () => {
  for (const tag of ["main", "baasx-v0.0.10", "refs/tags/0.0.10", "0.0.10-rc1", "0.0.10;touch injected", "0.0.10\n"]) expect(() => parseAppReleaseTag(tag)).toThrow();
  expect(() => existingRelease("0.0.10", [])).toThrow();
  for (const mutate of ["missing", "duplicate", "starter", "empty", "signature", "asset-id", "asset-name", "changed", "published-during-check"]) {
    const fixture = publicationFixture("0.0.10", { mutate });
    expect(() => fixture.publish(), mutate).toThrow();
    expect(fixture.writes).toEqual([]);
  }
});

test("publication recovery preserves a published release and never promotes older stable versions or RCs", () => {
  const published = publicationFixture("0.0.10", { published: true });
  expect(published.publish()).toMatchObject({ changed: false, assets: 36 });
  expect(published.writes).toEqual([]);
  expect(published.source.body).toBe("Original published text");
  for (const tag of ["v0.0.10", "0.0.10.post1", "0.0.10.rc1"]) {
    const fixture = publicationFixture(tag, { newer: true });
    expect(fixture.publish()).toMatchObject({ changed: true, makeLatest: false });
    expect(fixture.writes[0].prerelease).toBe(tag.includes(".rc"));
    expect(fixture.writes[0].make_latest).toBe("false");
  }
});

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

test("GitHub prereleases stay on preview even with a final-looking tag", () => {
  const published = release("v0.0.10-0.post.2");
  const flagged = { ...release("0.0.11"), prerelease: true };
  expect(selectPublishedReleases([published, flagged])).toEqual({
    stable: published,
    preview: flagged,
  });
});

test("updater targets use the signed installer for their OS, architecture and bundle format", async () => {
  const targets = {
    "linux-x86_64-deb": "amd64.deb",
    "linux-x86_64-rpm": "x86_64.rpm",
    "linux-aarch64-deb": "arm64.deb",
    "linux-aarch64-rpm": "aarch64.rpm",
    "linux-armv7-deb": "armhf.deb",
    "linux-armv7-rpm": "armv7hl.rpm",
    "android-arm64-v8a": "android_arm64-v8a.apk",
    "darwin-aarch64": "aarch64.app.tar.gz",
    "windows-x86_64": "x64-setup.exe",
    "windows-x86_64-portable": "x64_portable.exe",
    "windows-aarch64-portable": "arm64_portable.exe",
    win64: "x64-setup.exe",
  };
  const base = "BAAS.Tauri_1.2.3.post1_";
  const asset = (name: string) => ({ name, browser_download_url: `https://example.com/${name}` });
  const assets = [
    ...new Set([
      ...Object.values(targets),
      "x64_fixed_webview2-setup.exe",
      "x64_fixed_webview2_portable.zip",
      "arm64_fixed_webview2_portable.zip",
    ]),
  ].flatMap((suffix) => [asset(base + suffix), asset(base + suffix + ".sig")]);
  const version = { tag_name: "v1.2.3.post1", assets: assets.reverse() };
  const fetchSignature = async (url: string) => new Response("signed:" + url + "\n");
  const payload = (suffix: string) => ({
    url: asset(base + suffix).browser_download_url,
    signature: "signed:" + asset(base + suffix + ".sig").browser_download_url,
  });
  expect(await signedReleasePlatforms(version, { fetchSignature })).toEqual(
    Object.fromEntries(Object.entries(targets).map(([target, suffix]) => [target, payload(suffix)]))
  );
  expect(await signedReleasePlatforms(version, { fixedWebView2: true, fetchSignature })).toEqual({
    "windows-x86_64": payload("x64_fixed_webview2-setup.exe"),
    "windows-x86_64-portable": payload("x64_fixed_webview2_portable.zip"),
    "windows-aarch64-portable": payload("arm64_fixed_webview2_portable.zip"),
  });
});

test("partial historical assets are omitted and signature download errors stop publication", async () => {
  const name = "BAAS.Tauri_1.2.3_android_arm64-v8a.apk";
  const release = {
    tag_name: "1.2.3",
    assets: [{ name, browser_download_url: "https://example.com/app.apk" }],
  };
  expect(await signedReleasePlatforms(release)).toEqual({});
  release.assets.push({
    name: name + ".sig",
    browser_download_url: "https://example.com/app.apk.sig",
  });
  await expect(
    signedReleasePlatforms(release, {
      fetchSignature: async () => new Response("error", { status: 502 }),
    })
  ).rejects.toThrow("HTTP 502");
  await expect(
    signedReleasePlatforms(release, { fetchSignature: async () => new Response(" ") })
  ).rejects.toThrow("Empty updater signature");
});

test("unsigned portable payloads are never advertised in either updater feed", async () => {
  const tag_name = "1.2.3";
  const assets = [
    "x64_portable.exe",
    "arm64_portable.exe",
    "x64_fixed_webview2_portable.zip",
    "arm64_fixed_webview2_portable.zip",
  ].map((suffix) => ({
    name: `BAAS.Tauri_${tag_name}_${suffix}`,
    browser_download_url: `https://example.com/${suffix}`,
  }));
  let fetches = 0;
  const fetchSignature = async () => {
    fetches++;
    return new Response("invalid");
  };
  expect(await signedReleasePlatforms({ tag_name, assets }, { fetchSignature })).toEqual({});
  expect(
    await signedReleasePlatforms({ tag_name, assets }, { fixedWebView2: true, fetchSignature })
  ).toEqual({});
  expect(fetches).toBe(0);
});

test("publishing fails when any portable updater signature is missing", () => {
  const portable = [
    "x64_portable.exe",
    "arm64_portable.exe",
    "x64_fixed_webview2_portable.zip",
    "arm64_fixed_webview2_portable.zip",
  ];
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
    ...portable,
  ];
  const names = [...signed.flatMap((name) => [name, `${name}.sig`]), "aarch64.dmg", "x64.dmg"].map(
    (name) => `BAAS.Tauri_1.2.3_${name}`
  );
  expect(() => validateAssets("app", "1.2.3", names)).not.toThrow();
  for (const file of portable) {
    const signature = `BAAS.Tauri_1.2.3_${file}.sig`;
    expect(() =>
      validateAssets(
        "app",
        "1.2.3",
        names.filter((name) => name !== signature)
      )
    ).toThrow(signature);
  }
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

test("app release versions keep the renamed runtime and legacy path dependency in sync", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "Cargo.toml"),
    '[workspace]\nmembers = ["src-tauri", "crates/baasx-runtime", "crates/baas-cli-runtime"]\n'
  );
  for (const name of ["baasx-runtime", "baas-cli-runtime"]) {
    fs.mkdirSync(path.join(root, "crates", name), { recursive: true });
    fs.writeFileSync(
      path.join(root, "crates", name, "Cargo.toml"),
      `[package]\nname = "${name}"\nversion = "0.0.9"\n` +
        (name === "baas-cli-runtime"
          ? '\n[dependencies]\nbaasx-runtime = { version = "0.0.9", path = "../baasx-runtime" }\n'
          : "")
    );
    fs.appendFileSync(
      path.join(root, "Cargo.lock"),
      `\n[[package]]\nname = "${name}"\nversion = "0.0.9"\n`
    );
  }
  fs.mkdirSync(path.join(root, "baasx"));
  fs.writeFileSync(path.join(root, "baasx/package.json"), '{"version":"0.1.4"}\n');
  setReleaseVersion(root, "0.0.10");
  const legacyPath = path.join(root, "crates/baas-cli-runtime/Cargo.toml");
  const legacy = fs.readFileSync(legacyPath, "utf8");
  expect(legacy).toContain('baasx-runtime = { version = "0.0.10", path = "../baasx-runtime" }');
  expect(JSON.parse(fs.readFileSync(path.join(root, "baasx/package.json"), "utf8")).version).toBe(
    "0.1.4"
  );
  expect(checkReleaseVersion(root, "0.0.10").canonical).toBe("0.0.10");
  fs.writeFileSync(
    legacyPath,
    legacy.replace('version = "0.0.10", path', 'version = "0.0.9", path')
  );
  expect(() => checkReleaseVersion(root, "0.0.10")).toThrow("Legacy runtime dependency version");
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
