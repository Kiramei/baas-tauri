import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  defaultServiceCandidates,
  hasExactServiceBasename,
  serviceExecutableName,
  validateServiceExecutable,
} from "../../scripts/stage-cpp-service.mjs";

describe("C++ service packaging contract", () => {
  test("uses the exact platform-native service filename", () => {
    expect(serviceExecutableName("win32")).toBe("BAAS_service.exe");
    expect(serviceExecutableName("linux")).toBe("BAAS_service");
    expect(serviceExecutableName("darwin")).toBe("BAAS_service");
    expect(hasExactServiceBasename("D:/bin/BAAS_service.exe", "win32")).toBe(true);
    expect(hasExactServiceBasename("D:/bin/evilBAAS_service.exe", "win32")).toBe(false);
  });

  test("development candidates are absolute, ordered, and never PATH entries", () => {
    const candidates = defaultServiceCandidates(resolve("D:/workspace/baas-tauri"), "win32");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.includes("baas-cpp-dev"))).toBe(true);
    expect(candidates.every((candidate) => candidate.endsWith("BAAS_service.exe"))).toBe(true);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test("rejects relative overrides before process execution", async () => {
    await expect(validateServiceExecutable("BAAS_service.exe", "win32")).rejects.toThrow(
      "must be absolute"
    );
  });

  test.skipIf(!process.env.BAAS_CPP_SERVICE_PATH)(
    "accepts a real discoverable service identity",
    async () => {
      expect(await validateServiceExecutable(process.env.BAAS_CPP_SERVICE_PATH!)).toBeString();
    }
  );
});
