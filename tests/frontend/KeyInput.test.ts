import { describe, expect, test } from "bun:test";
import { validateKeyInput } from "../../src/shared/KeyInput";

describe("login and Key reset input", () => {
  test("blank input cannot initialize, authenticate or reset a Key", () => {
    for (const key of ["", " ", "\t\n", "\u3000"]) {
      expect(validateKeyInput(key)).toBe("required");
      expect(validateKeyInput(key, key)).toBe("required");
    }
  });

  test("confirmation is required for setup and reset, but not login", () => {
    const example = "example-validation-key";
    expect(validateKeyInput(example)).toBeNull();
    expect(validateKeyInput(example, "")).toBe("mismatch");
    expect(validateKeyInput(example, `${example}-different`)).toBe("mismatch");
    expect(validateKeyInput(example, example)).toBeNull();
  });

  test("confirmation detects whitespace and case differences without changing the input", () => {
    const example = "Example-Key";
    expect(validateKeyInput(example, example.toLowerCase())).toBe("mismatch");
    expect(validateKeyInput(` ${example}`, example)).toBe("mismatch");
    expect(validateKeyInput(` ${example} `, ` ${example} `)).toBeNull();
  });

  test("international Keys remain valid", () => {
    const example = "示例-Key-🔑";
    expect(validateKeyInput(example, example)).toBeNull();
  });
});
