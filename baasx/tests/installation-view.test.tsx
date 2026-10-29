import React from "react";
import { test, expect } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { InstallationPanel } from "../src/installation-view";
import { reduceInstallationProgress } from "../src/installation";
import { MouseBus } from "../src/terminal";
import { MouseContext } from "../src/terminal-components";
import { displayWidth, terminalText } from "../src/ui";

test("BuildKit groups keep each active step progress and tail in place, and completed steps reopen on click", async () => {
  const now = Date.now();
  let progress = reduceInstallationProgress(
    undefined,
    { type: "progress", stage: "prepare", message: "environment checked", status: "complete" },
    now - 2000
  );
  progress = reduceInstallationProgress(
    progress,
    {
      type: "progress",
      stage: "backend",
      taskId: "main-repository",
      message: "Receiving backend",
      status: "running",
      percent: 47,
      currentLine: "backend-current",
      replace: true,
    },
    now - 1500
  );
  progress = reduceInstallationProgress(
    progress,
    {
      type: "progress",
      stage: "ocr",
      taskId: "cpp-repository",
      message: "Fetching OCR",
      status: "running",
      percent: 12,
      currentLine: "ocr-current",
      replace: true,
    },
    now - 1000
  );
  let frame = "";
  const stdout = Object.assign(
    new Writable({
      write(chunk, _, done) {
        const text = terminalText(String(chunk));
        if (text.trim()) frame = text;
        done();
      },
    }),
    { columns: 90, rows: 25, isTTY: true }
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const mouse = new MouseBus();
  const view = () => (
    <MouseContext.Provider value={mouse}>
      <InstallationPanel progress={progress} language="zh" columns={90} height={22} tick={0} />
    </MouseContext.Provider>
  );
  const app = render(view(), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    patchConsole: false,
    maxFps: 1000,
  });
  try {
    await Bun.sleep(40);
    expect(frame).toContain("[1/3] 检查环境");
    expect(frame).not.toContain("environment checked");
    expect(frame).toMatch(
      /同步后端[\s\S]*47%[\s\S]*backend-current[\s\S]*下载 OCR 组件[\s\S]*12%[\s\S]*ocr-current/
    );
    const count = frame.split("\n").length;
    progress = reduceInstallationProgress(progress, {
      type: "progress",
      stage: "backend",
      taskId: "main-repository",
      message: "backend-new",
      percent: 63,
      currentLine: "backend-new",
      replace: true,
    });
    app.rerender(view());
    await Bun.sleep(40);
    expect(frame).toContain("63%");
    expect(frame).not.toContain("47%");
    expect(frame).not.toContain("backend-current");
    expect(frame.split("\n")).toHaveLength(count);
    const lines = frame.split("\n"),
      y = lines.findIndex((line) => line.includes("检查环境"));
    mouse.dispatch({
      x: displayWidth(lines[y].slice(0, lines[y].indexOf("检查环境"))),
      y,
      kind: "press",
      button: 0,
      delta: 0,
    });
    await Bun.sleep(40);
    expect(frame).toContain("environment checked");
    progress = reduceInstallationProgress(progress, {
      type: "progress",
      stage: "backend",
      taskId: "main-repository",
      message: "backend failed: mirror unavailable",
      status: "failed",
    });
    app.rerender(view());
    await Bun.sleep(40);
    expect(frame).toContain("backend failed: mirror unavailable");
    expect(frame).toContain("失败");
  } finally {
    app.unmount();
    app.cleanup();
    stdin.destroy();
    stdout.destroy();
  }
});
