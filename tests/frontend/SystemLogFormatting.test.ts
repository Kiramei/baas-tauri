import { describe, expect, test } from "bun:test";
import {
  formatSystemLogDetails,
  formatSystemLogEntries,
} from "../../src/shared/SystemLogFormatting";
import type { SystemLogEntry, SystemLogLevel } from "../../src/shared/SystemLogService";

describe("system log export", () => {
  test("retains every original level, source, target, message and structured details", () => {
    const levels: SystemLogLevel[] = ["TRACE", "DEBUG", "INFO", "WARNING", "ERROR"];
    const entries: SystemLogEntry[] = levels.map((level, index) => ({
      source: index % 2 ? "python" : "frontend",
      timestampMs: new Date(2026, 9, 18, 12, 34, 56, 789).getTime(),
      level,
      target: `worker.${index}`,
      message: `message ${index}\ncontinuation`,
      details: { retry: index, status: level },
    }));

    const text = formatSystemLogEntries(entries);
    for (const entry of entries) {
      expect(text).toContain(
        `2026-10-18 12:34:56.789 [${entry.source}] [${entry.level}] [${entry.target}] ${entry.message}`
      );
      expect(text).toContain(JSON.stringify(entry.details, null, 2));
    }
    expect(entries.map((entry) => entry.level)).toEqual(levels);
  });

  test("does not omit falsy detail values and tolerates nonserializable details", () => {
    expect(formatSystemLogDetails(false)).toBe("false");
    expect(formatSystemLogDetails(0)).toBe("0");
    expect(formatSystemLogDetails(undefined)).toBe("");
    expect(formatSystemLogDetails("stack\ntrace")).toBe("stack\ntrace");
    const circular: { nested?: unknown } = {};
    circular.nested = circular;
    expect(formatSystemLogDetails(circular)).toBe("[object Object]");
    expect(formatSystemLogEntries([])).toBe("");
  });
});
