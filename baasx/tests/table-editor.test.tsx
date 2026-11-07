import React, { act } from "react";
import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { FieldEditor } from "../src/field-editor";
import type { EditableField } from "../src/field-editor";
import { MouseContext } from "../src/terminal-components";
import { MouseBus } from "../src/terminal";
import { displayWidth, terminalText } from "../src/ui";

async function update<T>(action: () => T): Promise<T> {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  let result!: T;
  try {
    await act(async () => {
      result = action();
      // Let the stream's readable event run, then flush React's commit/effects.
      await Bun.sleep(0);
    });
    return result;
  } finally {
    if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

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
  const app = await update(() =>
    render(
      <MouseContext.Provider value={mouse}>
        <FieldEditor
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
    )
  );
  const settle = () => update(() => {});
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
      await update(() => stdin.write(text));
    },
    async click(text: string, rowContains?: string) {
      const lines = frame.split("\n");
      const y = lines.findIndex(
        (line) => line.includes(text) && (!rowContains || line.includes(rowContains))
      );
      expect(y).toBeGreaterThanOrEqual(0);
      const x = displayWidth(lines[y].slice(0, lines[y].indexOf(text)));
      await update(() => mouse.dispatch({ kind: "press", button: 0, x, y, delta: 0 }));
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

const table: EditableField = {
  label: "区域日程",
  type: "rows",
  layout: "table",
  rowLabels: ["North", "Central", "South"],
  value: [
    { count: 0, levels: ["advanced", "primary"] },
    { count: 1, levels: ["primary", "advanced"] },
    { count: 2, levels: [] },
  ],
  columns: [
    { key: "count", label: "次数", type: "number", integer: true, min: 0, max: 3 },
    {
      key: "levels",
      label: "等级",
      type: "multiselect",
      ordered: true,
      options: [
        { label: "Primary", value: "primary" },
        { label: "Advanced", value: "advanced" },
      ],
    },
  ],
};

test("each region has count controls and incrementing respects numeric boundaries", async () => {
  const ui = await mount(table);
  try {
    expect(ui.frame).toContain("区域");
    expect(ui.frame).toContain("次数");
    for (const region of table.rowLabels!) {
      const line = ui.frame.split("\n").find((line) => line.includes(region));
      expect(line).toContain("[-]");
      expect(line).toContain("[+]");
    }
    await ui.key("-");
    await ui.key("+");
    await ui.key("\x1b[B");
    await ui.key("+");
    await ui.key("\x1b[B");
    await ui.key("+");
    await ui.key("+");
    await ui.key("\x13");
    expect(ui.writes).toEqual([
      [
        { count: 1, levels: ["advanced", "primary"] },
        { count: 2, levels: ["primary", "advanced"] },
        { count: 3, levels: [] },
      ],
    ]);
    expect((table.value as Array<{ count: number }>).map((row) => row.count)).toEqual([0, 1, 2]);
  } finally {
    ui.close();
  }
});

test("mouse edits a later region and child number changes remain in the table draft until saved", async () => {
  const ui = await mount(table);
  try {
    await ui.click("[+]", "South");
    expect(ui.frame).toContain("❯ South");
    await ui.click("[-]", "Central");
    await ui.key("\r");
    await ui.key("2");
    await ui.key("\r");
    expect(ui.writes).toEqual([]);
    expect(ui.frame).toContain("❯ Central");
    await ui.key("\x13");
    expect(ui.writes).toEqual([
      [
        { count: 0, levels: ["advanced", "primary"] },
        { count: 2, levels: ["primary", "advanced"] },
        { count: 3, levels: [] },
      ],
    ]);
  } finally {
    ui.close();
  }
});

test("ordered level cells use the priority editor and save into the corresponding row", async () => {
  const ui = await mount(table);
  try {
    await ui.key("\x1b[C");
    await ui.key("\r");
    expect(ui.frame).toContain("1. Advanced");
    expect(ui.frame).toContain("2. Primary");
    await ui.key("\x1b[C");
    await ui.key("\x13");
    expect(ui.writes).toEqual([]);
    expect(ui.frame).toContain("Primary › Advanced");
    await ui.key("\x13");
    expect(ui.writes).toEqual([
      [
        { count: 0, levels: ["primary", "advanced"] },
        { count: 1, levels: ["primary", "advanced"] },
        { count: 2, levels: [] },
      ],
    ]);
  } finally {
    ui.close();
  }
});

test("cancelling a cell discards its draft while preserving earlier table changes", async () => {
  const ui = await mount(table);
  try {
    await ui.key("+");
    await ui.key("\r");
    await ui.key("3");
    await ui.key("\x1b");
    expect(ui.cancelled).toBe(0);
    await ui.key("\x13");
    expect((ui.writes[0] as Array<{ count: number }>)[0].count).toBe(1);
    await ui.key("\x1b");
    expect(ui.cancelled).toBe(1);
  } finally {
    ui.close();
  }
});

test("read-only tables, read-only columns and inactive tables reject mouse and key edits", async () => {
  for (const protection of ["table", "column", "inactive"]) {
    const ui = await mount(
      {
        ...table,
        readOnly: protection === "table",
        columns: table.columns!.map((column) => ({ ...column, readOnly: protection === "column" })),
      },
      { active: protection !== "inactive" }
    );
    try {
      await ui.click("[+]", "South");
      await ui.key("+");
      await ui.key("\r");
      expect(ui.frame).toContain("North");
      expect(ui.frame).toContain("Central");
      await ui.key("\x13");
      if (protection === "column") expect(ui.writes).toEqual([table.value]);
      else expect(ui.writes).toEqual([]);
    } finally {
      ui.close();
    }
  }
});

test("narrow tables scroll columns and rows while keeping edits assigned to their region", async () => {
  const field = {
    ...table,
    rowLabels: Array.from({ length: 20 }, (_, index) => `Area ${index}`),
    value: Array.from({ length: 20 }, () => ({ count: 0, levels: ["advanced", "primary"] })),
  };
  const ui = await mount(field, { width: 30, height: 8 });
  try {
    await ui.key("\x1b[6~");
    await ui.key("+");
    await ui.key("\x1b[C");
    expect(ui.frame).toContain("等级");
    await ui.key("\r");
    expect(ui.frame).toContain("Area 4");
    await ui.key("\x1b[C");
    await ui.key("\x13");
    for (const line of ui.frame.trimEnd().split("\n"))
      expect(displayWidth(line)).toBeLessThanOrEqual(30);
    expect(ui.frame.trimEnd().split("\n").length).toBeLessThanOrEqual(8);
    await ui.key("\x13");
    const saved = ui.writes[0] as Array<{ count: number; levels: string[] }>;
    expect(saved[4]).toEqual({ count: 1, levels: ["primary", "advanced"] });
    expect(saved[0]).toEqual({ count: 0, levels: ["advanced", "primary"] });
  } finally {
    ui.close();
  }
});

test("table save failures retain the draft and reject edits while saving", async () => {
  let reject: (reason: Error) => void = () => {};
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  let calls = 0;
  const ui = await mount(table, { onSave: () => (++calls === 1 ? pending : Promise.resolve()) });
  try {
    await ui.key("+");
    await ui.key("\x13");
    await ui.key("\x13");
    await ui.click("[+]", "South");
    await ui.key("+");
    expect(ui.writes).toHaveLength(1);
    reject(new Error("Save failed"));
    await ui.settle();
    expect(ui.frame).toContain("Save failed");
    await ui.key("\x13");
    expect(ui.writes).toHaveLength(2);
    expect(ui.writes[1]).toEqual(ui.writes[0]);
  } finally {
    ui.close();
  }
});
