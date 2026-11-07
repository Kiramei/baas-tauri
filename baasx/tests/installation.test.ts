import { expect, test } from "bun:test";
import { reduceInstallationProgress, type InstallationProgress } from "../src/installation";

test("carriage-return progress updates one task without growing history", () => {
  let state: InstallationProgress | undefined;
  for (let value = 0; value <= 100; value++) {
    state = reduceInstallationProgress(state, {
      type: "progress",
      stage: "uv",
      taskId: "uv-install",
      message: `download ${value}%`,
      percent: value,
      current: value,
      total: 100,
      unit: "bytes",
      downloadedBytes: value,
      totalBytes: 100,
      currentLine: `download ${value}%`,
      replace: true,
    });
  }
  expect(state?.tasks).toHaveLength(1);
  expect(state?.lines).toEqual([]);
  expect(state?.tasks[0]).toMatchObject({ id: "uv-install", percent: 100, downloadedBytes: 100 });
});

test("independent parallel stages retain progress and commit bounded real lines", () => {
  let state = reduceInstallationProgress(undefined, {
    type: "progress",
    stage: "ocr",
    taskId: "cpp-repository",
    message: "OCR",
    status: "pending",
  });
  state = reduceInstallationProgress(state, {
    type: "progress",
    stage: "python",
    taskId: "uv-python-install",
    message: "Python",
    status: "running",
    percent: 40,
  });
  state = reduceInstallationProgress(state, {
    type: "progress",
    stage: "ocr",
    taskId: "cpp-repository",
    message: "OCR ready",
    status: "complete",
  });
  expect(state.tasks[1].percent).toBe(40);
  expect(state.tasks[0].percent).toBe(100);
  expect(state.lines).toEqual(["Python", "OCR ready"]);
  const before = state;
  for (let index = 0; index < 300; index++)
    state = reduceInstallationProgress(state, {
      type: "progress",
      stage: "dependencies",
      message: `line ${index}`,
    });
  expect(state.lines).toHaveLength(80);
  expect(before.lines).toEqual(["Python", "OCR ready"]);
  expect(state.lines.at(-1)).toBe("line 299");
});

test("failed tasks never receive a fabricated completion percentage", () => {
  const state = reduceInstallationProgress(undefined, {
    type: "progress",
    stage: "python",
    message: "download failed",
    status: "failed",
  });
  expect(state.tasks[0].percent).toBeUndefined();
  expect(state.tasks[0].status).toBe("failed");
});

test("a new workflow plan clears the previous attempt's task metrics", () => {
  let state = reduceInstallationProgress(undefined, {
    type: "progress",
    stage: "python",
    message: "ready",
    status: "complete",
    downloadedBytes: 100,
    totalBytes: 100,
  });
  state = reduceInstallationProgress(state, {
    type: "progress",
    stage: "python",
    message: "pending",
    status: "pending",
  });
  expect(state.tasks[0]).toMatchObject({ status: "pending" });
  expect(state.tasks[0].percent).toBeUndefined();
  expect(state.tasks[0].downloadedBytes).toBeUndefined();
});

test("verified completion leaves no preparation spinner running", () => {
  let state = reduceInstallationProgress(undefined, {
    type: "progress",
    stage: "prepare",
    message: "preparing",
    status: "running",
  });
  state = reduceInstallationProgress(state, {
    type: "progress",
    stage: "launch",
    message: "optional",
    status: "pending",
  });
  const previous = state;
  state = reduceInstallationProgress(state, {
    type: "progress",
    stage: "complete",
    message: "ready",
    status: "complete",
  });
  expect(state.tasks.map((task) => task.status)).toEqual(["complete", "skipped", "complete"]);
  expect(state.tasks[0].percent).toBe(100);
  expect(previous.tasks[0].status).toBe("running");
});

test("BuildKit timing starts at execution, survives repaint frames and freezes at completion", () => {
  let state = reduceInstallationProgress(
    undefined,
    {
      type: "progress",
      stage: "python",
      taskId: "python-install",
      message: "Python",
      status: "pending",
    },
    1000
  );
  expect(state.startedAt).toBeUndefined();
  expect(state.tasks[0].startedAt).toBeUndefined();
  state = reduceInstallationProgress(
    state,
    {
      type: "progress",
      stage: "python",
      taskId: "python-install",
      message: "Installing Python",
      status: "running",
    },
    2000
  );
  const started = state;
  state = reduceInstallationProgress(
    state,
    {
      type: "progress",
      stage: "python",
      taskId: "python-install",
      message: "10%",
      percent: 10,
      replace: true,
    },
    2500
  );
  state = reduceInstallationProgress(
    state,
    {
      type: "progress",
      stage: "python",
      taskId: "python-install",
      message: "50%",
      percent: 50,
      replace: true,
    },
    3000
  );
  expect(state.startedAt).toBe(2000);
  expect(state.tasks[0]).toMatchObject({
    startedAt: 2000,
    currentLine: "50%",
    lines: ["Installing Python"],
  });
  expect(started.tasks[0].currentLine).toBeUndefined();
  state = reduceInstallationProgress(
    state,
    {
      type: "progress",
      stage: "python",
      taskId: "python-install",
      message: "Python installed",
      status: "complete",
    },
    5000
  );
  state = reduceInstallationProgress(
    state,
    {
      type: "progress",
      stage: "python",
      taskId: "python-install",
      message: "Python installed",
      status: "complete",
    },
    6000
  );
  expect(state.tasks[0]).toMatchObject({
    startedAt: 2000,
    finishedAt: 5000,
    lines: ["Installing Python", "Python installed"],
  });
});

test("each parallel build step retains its own six-line tail after it finishes", () => {
  let state: InstallationProgress | undefined;
  for (let index = 0; index < 12; index++) {
    state = reduceInstallationProgress(
      state,
      {
        type: "progress",
        stage: "dependencies",
        taskId: "uv-sync",
        message: `dependency ${index}`,
        status: "running",
      },
      1000 + index
    );
    state = reduceInstallationProgress(
      state,
      {
        type: "progress",
        stage: "backend",
        taskId: "main-repository",
        message: `object ${index}`,
        replace: true,
      },
      2000 + index
    );
  }
  expect(state!.tasks[0].lines).toEqual(
    Array.from({ length: 6 }, (_, index) => `dependency ${index + 6}`)
  );
  expect(state!.tasks[1].lines).toEqual([]);
  state = reduceInstallationProgress(
    state,
    {
      type: "progress",
      stage: "dependencies",
      taskId: "uv-sync",
      message: "dependencies ready",
      status: "complete",
    },
    4000
  );
  expect(state.tasks[0].lines).toEqual([
    "dependency 7",
    "dependency 8",
    "dependency 9",
    "dependency 10",
    "dependency 11",
    "dependencies ready",
  ]);
  expect(state.tasks[1].currentLine).toBe("object 11");
});

test("a retried pending step clears old duration, output and transfer metrics", () => {
  let state = reduceInstallationProgress(
    undefined,
    {
      type: "progress",
      stage: "python",
      message: "old run",
      status: "running",
      percent: 50,
      downloadedBytes: 20,
      totalBytes: 40,
    },
    1000
  );
  state = reduceInstallationProgress(
    state,
    { type: "progress", stage: "python", message: "old failure", status: "failed" },
    2000
  );
  state = reduceInstallationProgress(
    state,
    { type: "progress", stage: "python", message: "retry", status: "pending" },
    3000
  );
  expect(state.tasks[0].lines).toEqual([]);
  expect(state.tasks[0].startedAt).toBeUndefined();
  expect(state.tasks[0].finishedAt).toBeUndefined();
  expect(state.tasks[0].currentLine).toBeUndefined();
  expect(state.tasks[0].downloadedBytes).toBeUndefined();
  state = reduceInstallationProgress(
    state,
    { type: "progress", stage: "python", message: "retry started", status: "running" },
    4000
  );
  expect(state.tasks[0].startedAt).toBe(4000);
  expect(state.tasks[0].finishedAt).toBeUndefined();
});

test("a failed installation terminates unfinished steps and preserves diagnostic tails", () => {
  let state = reduceInstallationProgress(
    undefined,
    { type: "progress", stage: "prepare", message: "prepare config", status: "running" },
    1000
  );
  state = reduceInstallationProgress(
    state,
    { type: "progress", stage: "uv", message: "queued", status: "pending" },
    1500
  );
  state = reduceInstallationProgress(
    state,
    {
      type: "progress",
      stage: "python",
      message: "Python download",
      status: "running",
      percent: 40,
    },
    2000
  );
  expect(state.tasks[0]).toMatchObject({ status: "complete", finishedAt: 2000 });
  const beforeFailure = state;
  state = reduceInstallationProgress(
    state,
    { type: "progress", stage: "failed", message: "network operation failed", status: "failed" },
    5000
  );
  expect(state.tasks.some((task) => task.status === "running" || task.status === "pending")).toBe(
    false
  );
  expect(state.tasks[1]).toMatchObject({ status: "skipped", finishedAt: 5000 });
  expect(state.tasks[2]).toMatchObject({
    status: "failed",
    percent: 40,
    startedAt: 2000,
    finishedAt: 5000,
    lines: ["Python download"],
  });
  expect(state.tasks[3]).toMatchObject({
    currentLine: "network operation failed",
    lines: ["network operation failed"],
  });
  expect(beforeFailure.tasks[2].status).toBe("running");
});

test("a subsequent command in the same build step clears finished transfer metrics", () => {
  let state = reduceInstallationProgress(
    undefined,
    {
      type: "progress",
      stage: "backend",
      taskId: "main-repository",
      message: "fetch",
      status: "running",
      percent: 50,
      current: 5,
      total: 10,
      unit: "objects",
    },
    1000
  );
  state = reduceInstallationProgress(
    state,
    {
      type: "progress",
      stage: "backend",
      taskId: "main-repository",
      message: "fetch done",
      status: "complete",
    },
    2000
  );
  state = reduceInstallationProgress(
    state,
    {
      type: "progress",
      stage: "backend",
      taskId: "main-repository",
      message: "reset",
      status: "running",
    },
    3000
  );
  expect(state.tasks[0]).toMatchObject({
    startedAt: 1000,
    status: "running",
    lines: ["fetch", "fetch done", "reset"],
  });
  expect(state.tasks[0].finishedAt).toBeUndefined();
  expect(state.tasks[0].percent).toBeUndefined();
  expect(state.tasks[0].current).toBeUndefined();
  expect(state.tasks[0].unit).toBeUndefined();
});
