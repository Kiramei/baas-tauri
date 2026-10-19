import { describe, expect, test } from "bun:test";
import { profileDisplayName, unusedDefaultProfileName } from "../../src/shared/ProfileName";

describe("profile names", () => {
  test("the built-in default is English in every UI language", () => {
    expect(profileDisplayName("新的配置")).toBe("New Profile");
  });

  test("user names are preserved", () => {
    for (const name of ["B服", "My daily tasks", "新的配置 2", ""])
      expect(profileDisplayName(name)).toBe(name);
  });

  test("new defaults avoid names already in use", () => {
    const names = new Set(["New Profile", "New Profile 2", "B服"]);
    expect(unusedDefaultProfileName((name) => names.has(name))).toBe("New Profile 3");
    expect(unusedDefaultProfileName(() => false)).toBe("New Profile");
  });
});
