import { afterEach, expect, test } from "bun:test";
import {
  createProfileNotice,
  mergeProfileLogs,
  profileNotices,
  useProfileNoticeStore,
} from "../../src/shared/ProfileNotice";
import type { LogItem } from "../../src/types/app";

afterEach(() => useProfileNoticeStore.setState({ logs: {} }));

test("Android home notices keep severity, detail and originating profile", () => {
  const own = createProfileNotice(true, "one");
  own.error("Could not start", { description: "OCR resource is unavailable" });
  own.success("Display ready");
  createProfileNotice(true, "two").warning("Other profile");
  const entries = profileNotices(useProfileNoticeStore.getState().logs, "one");
  expect(entries.map(({ level, message }) => ({ level, message }))).toEqual([
    { level: "ERROR", message: "Could not start\nOCR resource is unavailable" },
    { level: "INFO", message: "Display ready" },
  ]);
  expect(Number.isNaN(Date.parse(entries[0].time))).toBe(false);
  expect(profileNotices(useProfileNoticeStore.getState().logs, "two")).toHaveLength(1);
  expect(profileNotices(useProfileNoticeStore.getState().logs, "missing")).toHaveLength(0);
});

test("server history replacement cannot erase local failures from the view or export buffer", () => {
  const log = (time: string, message: string): LogItem => ({ time, message, level: "INFO" });
  const local = [log("2026-01-01T00:00:01.000Z", "Permission failed")];
  const snapshot = [
    log("2026-01-01T08:00:00+08:00", "Backend ready"),
    log("2026-01-01T00:00:02Z", "Task started"),
  ];
  const combined = mergeProfileLogs(snapshot, local);
  expect(combined.map((entry) => entry.message)).toEqual([
    "Backend ready",
    "Permission failed",
    "Task started",
  ]);
  expect(mergeProfileLogs([], local)).toBe(local);
  expect(mergeProfileLogs(snapshot, [])).toBe(snapshot);
  expect(snapshot).toHaveLength(2);
  expect(local).toHaveLength(1);
});

test("local notice storage is bounded independently per profile", () => {
  const notice = createProfileNotice(true, "one");
  for (let i = 0; i < 205; i++) notice.info(String(i));
  const logs = profileNotices(useProfileNoticeStore.getState().logs, "one");
  expect(logs).toHaveLength(200);
  expect(logs[0].message).toBe("5");
  expect(logs[199].message).toBe("204");
});
