import { describe, expect, test } from "bun:test";
import {
  androidVersionCode,
  compareReleaseVersions,
  normalizeReleaseVersion,
  parseReleaseVersion,
  releaseVersionFromPackage,
} from "../../src/shared/ReleaseVersion.mjs";
import { resolveClientVersion } from "../../src/shared/ClientVersion";

describe("public release versions and native package versions", () => {
  test("new release names use only the numeric base and dotted rc/post suffixes", () => {
    for (const name of ["0.0.9", "0.0.8.rc1", "0.0.9.post2", "1.5.2.rc0", "1.5.2.post0"])
      expect(parseReleaseVersion(name)?.canonical).toBe(name);
    for (const name of [
      "v0.0.9",
      "0.0.9-rc1",
      "0.0.9+build.1",
      "0.00.9",
      "0.0.9.rc01",
      " 0.0.9",
      "0.0.9.post-1",
      "0.0.9.1",
      "0.0.9beta",
    ])
      expect(parseReleaseVersion(name), name).toBeNull();
  });

  test("base components and suffix counters are numbers rather than strings", () => {
    const ordered = [
      "0.0.9.rc2",
      "0.0.9.rc10",
      "0.0.9",
      "0.0.9.post2",
      "0.0.9.post10",
      "0.0.9.post999",
      "0.0.10.rc0",
      "0.0.10",
      "1.5.2.rc10",
      "1.5.2",
      "1.5.2.post2",
    ];
    expect([...ordered].reverse().sort(compareReleaseVersions)).toEqual(ordered);
    expect(compareReleaseVersions("2.10.3", "2.2.30.post999")).toBe(1);
    expect(compareReleaseVersions("10.0.0.rc0", "2.999.999.post999")).toBe(1);
  });

  test("the native post bridge stays above its formal base and below the next rc", () => {
    const pairs = [
      ["0.0.9", "0.0.9"],
      ["0.0.8.rc1", "0.0.8-rc.1"],
      ["0.0.9.post2", "0.0.10-0.post.2"],
      ["1.5.2.post999", "1.5.3-0.post.999"],
    ];
    for (const [canonical, native] of pairs) {
      expect(parseReleaseVersion(canonical)?.semver).toBe(native);
      expect(normalizeReleaseVersion(native)).toBe(canonical);
      expect(compareReleaseVersions(canonical, native)).toBe(0);
    }
    expect(compareReleaseVersions("0.0.10-0.post.999", "0.0.10-rc.0")).toBe(-1);
  });

  test("historical tags are readable without accepting them as new release names", () => {
    for (const [tag, canonical] of [
      ["v0.0.8-rc", "0.0.8.rc0"],
      ["v0.0.8-rc1", "0.0.8.rc1"],
      ["v0.0.8-rc.10", "0.0.8.rc10"],
      ["v0.0.9", "0.0.9"],
      ["v0.0.9+build.1", "0.0.9"],
    ]) {
      expect(normalizeReleaseVersion(tag)).toBe(canonical);
      expect(parseReleaseVersion(tag)).toBeNull();
    }
  });

  test("current UI versions remain unchanged and internal mappings never leak into labels", () => {
    expect(resolveClientVersion("0.0.9", "fallback")).toBe("0.0.9");
    expect(resolveClientVersion("1.5.2-rc.10", "fallback")).toBe("1.5.2.rc10");
    expect(resolveClientVersion("0.0.10-0.post.2", "fallback")).toBe("0.0.9.post2");
    expect(resolveClientVersion("checking", "0.0.9")).toBe("0.0.9");
  });

  test("public package metadata takes precedence over native SemVer", () => {
    expect(releaseVersionFromPackage({ version: "0.0.9" }).canonical).toBe("0.0.9");
    expect(
      releaseVersionFromPackage({ version: "0.0.10-0.post.2", releaseVersion: "0.0.9.post2" })
        .canonical
    ).toBe("0.0.9.post2");
    expect(releaseVersionFromPackage({ version: "0.0.10-0.post.2" }).canonical).toBe("0.0.9.post2");
    expect(() => releaseVersionFromPackage({ version: "invalid" })).toThrow();
    expect(() => compareReleaseVersions("invalid", "0.0.9")).toThrow();
  });

  test("Android's default codes increase across rc, formal, post and the next base", () => {
    const versions = [
      "0.0.0.rc0",
      "0.0.9.rc2",
      "0.0.9.rc10",
      "0.0.9",
      "0.0.9.post0",
      "0.0.9.post2",
      "0.0.9.post10",
      "0.0.10.rc0",
    ];
    const codes = versions.map((value) => androidVersionCode(value));
    expect(codes[0]).toBe(1);
    expect([...codes].sort((a, b) => a - b)).toEqual(codes);
    expect(new Set(codes).size).toBe(versions.length);
    expect(androidVersionCode("0.0.9.post2")).toBeGreaterThan(9);
  });

  test("Android platform limits do not restrict release parsing and have an explicit escape hatch", () => {
    expect(parseReleaseVersion("0.0.9.post999")?.serial).toBe(999);
    expect(() => androidVersionCode("0.0.9.post999")).toThrow("BAAS_ANDROID_VERSION_CODE");
    expect(() => androidVersionCode("0.0.100")).toThrow("BAAS_ANDROID_VERSION_CODE");
    expect(androidVersionCode("0.0.9.post999", "123456")).toBe(123456);
    for (const override of ["0", "-1", "2.5", "2100000001", "not-a-number"])
      expect(() => androidVersionCode("0.0.9", override)).toThrow();
  });
});
