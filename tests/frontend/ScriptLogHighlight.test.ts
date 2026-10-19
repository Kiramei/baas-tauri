import { describe, expect, test } from "bun:test";
import { tokenizeScriptLog } from "../../src/shared/ScriptLogHighlight";

const colored = (message: string) =>
  tokenizeScriptLog(message).filter(({ kind }) => kind !== "plain");

describe("script log highlighting", () => {
  test("protects complete paths, URLs, addresses and dates before number matching", () => {
    const message =
      "ipc_dll = C:\\Program Files\\Vendor (x86)\\renderer_ipc.dll\n" +
      "endpoint: https://example.invalid/api/v2?q=15&ready=True\n" +
      "device: 127.0.0.1:16384\nnext_time: 2026-10-18 04:00:00";
    const tokens = colored(message);
    expect(tokens).toContainEqual({
      kind: "path",
      text: "C:\\Program Files\\Vendor (x86)\\renderer_ipc.dll",
    });
    expect(tokens).toContainEqual({
      kind: "path",
      text: "https://example.invalid/api/v2?q=15&ready=True",
    });
    expect(tokens).toContainEqual({ kind: "literal", text: "127.0.0.1:16384" });
    expect(tokens).toContainEqual({ kind: "literal", text: "2026-10-18 04:00:00" });
    expect(tokens.some(({ kind }) => kind === "number")).toBe(false);
    expect(
      tokenizeScriptLog(message)
        .map(({ text }) => text)
        .join("")
    ).toBe(message);
  });

  test("separates keys, task and feature identities from coordinates and measured values", () => {
    expect(colored("Image feature: main_page_quick-home -> Click @ (1200, 30)")).toEqual([
      { kind: "key", text: "Image feature" },
      { kind: "identifier", text: "main_page_quick-home" },
      { kind: "number", text: "(1200, 30)" },
    ]);
    expect(colored("current_task : [ 1号咖啡厅 ] start")).toEqual([
      { kind: "key", text: "current_task" },
      { kind: "identifier", text: "1号咖啡厅" },
    ]);
    expect(colored("Ocr Credit Points : 300,000,000 | Time : 3ms | ratio: 1/5")).toEqual([
      { kind: "key", text: "Ocr Credit Points" },
      { kind: "number", text: "300,000,000" },
      { kind: "key", text: "Time" },
      { kind: "number", text: "3ms" },
      { kind: "key", text: "ratio" },
      { kind: "number", text: "1/5" },
    ]);
  });

  test("adds restrained emphasis to stage titles without treating arrays or prose as severity", () => {
    expect(colored("--------Device Init Finished--------")).toEqual([
      { kind: "heading", text: "--------Device Init Finished--------" },
    ]);
    expect(colored("[0, 0, 1]").map(({ kind }) => kind)).toEqual(["number", "number", "number"]);
    expect(
      colored("Recognition failure; retrying next frame. INFO WARNING ERROR Uiautomator2")
    ).toEqual([]);
    expect(colored("Package: com.example.gameclient")).toEqual([
      { kind: "key", text: "Package" },
      { kind: "identifier", text: "com.example.gameclient" },
    ]);
    expect(colored("Completed in 3ms.")).toEqual([{ kind: "number", text: "3ms" }]);
    expect(colored("Retry : 1.")).toEqual([
      { kind: "key", text: "Retry" },
      { kind: "number", text: "1" },
    ]);
    expect(colored("Uiautomator2 1.2.3")).toEqual([]);
  });

  test("keeps literals and quoted strings intact without interpreting HTML or escapes", () => {
    const message = "options: [True, False, None, \"<script>alert(1)</script>\", 'a\\'b']";
    const tokens = tokenizeScriptLog(message);
    expect(tokens.map(({ text }) => text).join("")).toBe(message);
    expect(tokens).toContainEqual({ kind: "string", text: '"<script>alert(1)</script>"' });
    expect(tokens).toContainEqual({ kind: "string", text: "'a\\'b'" });
    expect(tokens.filter(({ kind }) => kind === "literal").map(({ text }) => text)).toEqual([
      "True",
      "False",
      "None",
    ]);
  });

  test("preserves all whitespace, Chinese, emoji, multiline dictionaries and malformed input", () => {
    const messages = [
      "\tScheduler : {\r\n  current_task : cafe\r\n  enabled : True\r\n}\r\n",
      "  学生：星野 🌟 <>&\\ \t\n  Click @ (10,20)\n",
      "value: 'unfinished\\\nnext_time: 2026-10-18T04:00:00.123+08:00",
      "'" + '\\"'.repeat(1000),
      "",
    ];
    for (const message of messages) {
      expect(
        tokenizeScriptLog(message)
          .map(({ text }) => text)
          .join("")
      ).toBe(message);
    }
  });

  test("bounds work and generated spans for unexpectedly large live records", () => {
    const message = "unbrokenOrdinaryText".repeat(10_000) + " 😀\n<>&";
    expect(tokenizeScriptLog(message)).toEqual([{ kind: "plain", text: message }]);
    const ordinary = "unbrokenOrdinaryText".repeat(1000);
    expect(tokenizeScriptLog(ordinary)).toEqual([{ kind: "plain", text: ordinary }]);
    const manyValues = "1 ".repeat(10_000);
    const tokens = tokenizeScriptLog(manyValues);
    expect(tokens.length).toBeLessThanOrEqual(514);
    expect(tokens.map(({ text }) => text).join("")).toBe(manyValues);
  });
});
