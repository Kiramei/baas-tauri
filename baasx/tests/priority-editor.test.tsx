import React from "react";
import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { PriorityEditor } from "../src/priority-editor";
import type { EditableField } from "../src/field-editor";
import { MouseContext } from "../src/terminal-components";
import { MouseBus } from "../src/terminal";
import { displayWidth, terminalText } from "../src/ui";

async function mount(
  field: EditableField,
  options: {
    width?: number;
    height?: number;
    active?: boolean;
    onSave?: (value: unknown) => Promise<void>;
  } = {}
) {
  const writes: unknown[] = [];
  const mouse = new MouseBus();
  mouse.setMaxListeners(200);
  const width = options.width ?? 88,
    height = options.height ?? 20;
  let frame = "",
    cancelled = 0;
  const stdout = Object.assign(
    new Writable({
      write(chunk, _, done) {
        const text = terminalText(String(chunk));
        if (text.trim()) frame = text;
        done();
      },
    }),
    { columns: width, rows: height, isTTY: true }
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const app = render(
    <MouseContext.Provider value={mouse}>
      <PriorityEditor
        field={field}
        language="zh"
        width={width}
        height={height}
        active={options.active}
        onSave={async (value) => {
          writes.push(value);
          await options.onSave?.(value);
        }}
        onCancel={() => cancelled++}
      />
    </MouseContext.Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      patchConsole: false,
      maxFps: 1000,
    }
  );
  const settle = () => Bun.sleep(40);
  await settle();
  return {
    writes,
    settle,
    get frame() {
      return frame;
    },
    get cancelled() {
      return cancelled;
    },
    async key(text: string) {
      stdin.write(text);
      await settle();
    },
    async click(text: string, rowContains?: string) {
      const lines = frame.split("\n");
      const y = lines.findIndex(
        (line) => line.includes(text) && (!rowContains || line.includes(rowContains))
      );
      expect(y).toBeGreaterThanOrEqual(0);
      const x = displayWidth(lines[y].slice(0, lines[y].indexOf(text)));
      mouse.dispatch({ kind: "press", button: 0, x, y, delta: 0 });
      await settle();
    },
    close() {
      app.unmount();
      app.cleanup();
      stdin.destroy();
      stdout.destroy();
      expect(mouse.listenerCount("mouse")).toBe(0);
    },
  };
}

const ordered: EditableField = {
  label: "优先级",
  type: "multiselect",
  ordered: true,
  value: ["beta", "alpha", 7],
  options: [
    { label: "Alpha", value: "alpha" },
    { label: "Beta", value: "beta" },
    { label: "Seven", value: 7 },
    { label: "Gamma", value: "gamma" },
    { label: "Disabled", value: "disabled", disabled: true },
  ],
};

test("priority rows show saved order, follow keyboard moves and preserve typed IDs", async () => {
  const ui = await mount(ordered);
  try {
    expect(ui.frame.indexOf("1. Beta")).toBeLessThan(ui.frame.indexOf("2. Alpha"));
    expect(ui.frame).toContain("3. Seven");
    await ui.key("\x1b[C");
    expect(ui.frame).toContain("❯ 2. Beta");
    await ui.key(">");
    expect(ui.frame).toContain("❯ 3. Beta");
    await ui.key("\x1b[C");
    await ui.key("<");
    expect(ui.frame).toContain("❯ 2. Beta");
    await ui.key("\x13");
    expect(ui.writes).toEqual([["alpha", "beta", 7]]);
  } finally {
    ui.close();
  }
});

test("mouse selection does not deselect and visible controls move, add and remove", async () => {
  const ui = await mount(ordered);
  try {
    await ui.click("Alpha");
    expect(ui.frame).toContain("❯ 2. Alpha");
    await ui.click("↑ 上移");
    expect(ui.frame).toContain("❯ 1. Alpha");
    await ui.click("↓ 下移");
    await ui.click("[+]", "Gamma");
    expect(ui.frame).toContain("❯ 4. Gamma");
    await ui.click("[−]", "Beta");
    await ui.click("保存");
    expect(ui.writes).toEqual([["alpha", 7, "gamma"]]);
  } finally {
    ui.close();
  }
});

test("unknown selected IDs survive moving, filtering and saving", async () => {
  const ui = await mount({ ...ordered, value: [false, "beta", "old-name"] });
  try {
    expect(ui.frame).toContain("1. false");
    expect(ui.frame).toContain("3. old-name");
    await ui.key("\x1b[C");
    await ui.key("/");
    await ui.key("old-name");
    await ui.key("\r");
    expect(ui.frame).toContain("3. old-name");
    await ui.key("\x1b[D");
    expect(ui.frame).toContain("❯ 2. old-name");
    await ui.key("\x13");
    expect(ui.writes).toEqual([["beta", "old-name", false]]);
  } finally {
    ui.close();
  }
});

test("search reaches a long catalog in a narrow viewport without losing priority", async () => {
  const ui = await mount(
    {
      ...ordered,
      value: [999],
      options: Array.from({ length: 200 }, (_, value) => ({ label: `Student ${value}`, value })),
    },
    { width: 36, height: 9 }
  );
  try {
    expect(ui.frame).toContain("1. 999");
    await ui.key("/");
    await ui.key("Student 198");
    await ui.key("\r");
    await ui.key(" ");
    expect(ui.frame).toContain("2. Student 198");
    await ui.key("\x1b[D");
    expect(ui.frame).toContain("1. Student 198");
    await ui.key("\x1b");
    expect(ui.cancelled).toBe(0);
    await ui.key("\x1b[6~");
    await ui.key("\x13");
    expect(ui.writes).toEqual([[198, 999]]);
    for (const line of ui.frame.trimEnd().split("\n"))
      expect(displayWidth(line)).toBeLessThanOrEqual(36);
    expect(ui.frame.trimEnd().split("\n").length).toBeLessThanOrEqual(9);
    await ui.key("\x1b");
    expect(ui.cancelled).toBe(1);
  } finally {
    ui.close();
  }
});

test("disabled options and disallowed add/remove actions cannot change values", async () => {
  const ui = await mount({ ...ordered, allowAdd: false, allowRemove: false });
  try {
    await ui.key(" ");
    await ui.click("[−]", "Beta");
    await ui.click("[+]", "Gamma");
    await ui.click("[+]", "Disabled");
    await ui.key("\x13");
    expect(ui.writes).toEqual([["beta", "alpha", 7]]);
  } finally {
    ui.close();
  }
});

test("saved obsolete options can be reordered and removed but cannot be added again", async () => {
  const ui = await mount({ ...ordered, value: ["disabled", "beta"] });
  try {
    await ui.key("\x1b[C");
    expect(ui.frame).toContain("❯ 2. Disabled");
    await ui.key("\x13");
    await ui.click("[−]", "Disabled");
    await ui.click("[+]", "Disabled");
    await ui.key("\x13");
    expect(ui.writes).toEqual([["beta", "disabled"], ["beta"]]);
  } finally {
    ui.close();
  }
});

test("read-only and inactive editors reject keyboard and mouse mutations", async () => {
  for (const inactive of [true, false]) {
    const ui = await mount({ ...ordered, readOnly: !inactive }, { active: !inactive });
    try {
      await ui.key("\x1b[C");
      await ui.key(" ");
      await ui.click("↓ 下移");
      await ui.click("[+]", "Gamma");
      await ui.click("保存");
      await ui.key("\x13");
      expect(ui.frame).toContain("1. Beta");
      expect(ui.frame).toContain("○ Gamma");
      expect(ui.writes).toEqual([]);
    } finally {
      ui.close();
    }
  }
});

test("pending saves lock the draft and failures retain it for retry", async () => {
  let reject: (reason: Error) => void = () => {};
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  let calls = 0;
  const ui = await mount(ordered, { onSave: () => (++calls === 1 ? pending : Promise.resolve()) });
  try {
    await ui.key("\x1b[C");
    await ui.key("\x13");
    await ui.key("\x13");
    await ui.key("\x1b[C");
    await ui.click("[+]", "Gamma");
    await ui.key("\x1b");
    await ui.click("返回");
    expect(ui.cancelled).toBe(0);
    expect(ui.writes).toEqual([["alpha", "beta", 7]]);
    reject(new Error("Save failed"));
    await ui.settle();
    expect(ui.frame).toContain("Save failed");
    expect(ui.frame).toContain("❯ 2. Beta");
    await ui.key("\x13");
    expect(ui.writes).toEqual([
      ["alpha", "beta", 7],
      ["alpha", "beta", 7],
    ]);
  } finally {
    ui.close();
  }
});
