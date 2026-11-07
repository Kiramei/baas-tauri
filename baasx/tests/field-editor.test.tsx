import React from "react";
import { test, expect } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { FieldEditor, type EditableField } from "../src/field-editor";
import { terminalText } from "../src/ui";
async function mount(field: EditableField) {
  const writes: unknown[] = [];
  let frame = "";
  const stdout = Object.assign(
    new Writable({
      write(chunk, _, done) {
        const text = terminalText(String(chunk));
        if (text.trim()) frame = text;
        done();
      },
    }),
    { columns: 90, rows: 30, isTTY: true }
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const app = render(
    <FieldEditor
      field={field}
      language="zh"
      width={88}
      height={20}
      onSave={(value) => {
        writes.push(value);
      }}
      onCancel={() => {}}
    />,
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
    get frame() {
      return frame;
    },
    async key(text: string) {
      stdin.write(text);
      await settle();
    },
    close() {
      app.unmount();
      app.cleanup();
      stdin.destroy();
      stdout.destroy();
    },
  };
}
test("select shows a display label and saves its independent typed wire value", async () => {
  const ui = await mount({
    label: "截图方法",
    type: "select",
    value: "adb",
    options: [
      { label: "ADB 截图", value: "adb" },
      { label: "快速截图", value: "fast" },
    ],
  });
  try {
    expect(ui.frame).toContain("快速截图");
    await ui.key("\x1b[B");
    await ui.key("\r");
    expect(ui.writes).toEqual(["fast"]);
  } finally {
    ui.close();
  }
});
test("number input excludes letters and enforces range before saving", async () => {
  const ui = await mount({
    label: "次数",
    type: "number",
    value: 10,
    min: 0,
    max: 20,
    integer: true,
  });
  try {
    await ui.key("abc");
    await ui.key("99");
    await ui.key("\r");
    expect(ui.writes).toEqual([]);
    expect(ui.frame).toContain("数值超出范围");
    await ui.key("\x01");
    await ui.key("12");
    await ui.key("\r");
    expect(ui.writes).toEqual([12]);
  } finally {
    ui.close();
  }
});
test("left and right control a switch without entering JSON", async () => {
  const ui = await mount({ label: "启用", type: "switch", value: true });
  try {
    await ui.key("\x1b[D");
    await ui.key("\r");
    await ui.key("\x1b[C");
    await ui.key("\r");
    expect(ui.writes).toEqual([false, true]);
  } finally {
    ui.close();
  }
});
test("multi selection and ordered task lists retain real IDs and editable order", async () => {
  const ui = await mount({
    label: "前置任务",
    type: "list",
    ordered: true,
    value: ["mail"],
    options: [
      { label: "邮件", value: "mail" },
      { label: "咖啡厅", value: "cafe" },
    ],
  });
  try {
    await ui.key("\x1b[B");
    await ui.key(" ");
    await ui.key("<");
    await ui.key("\x13");
    expect(ui.writes).toEqual([["cafe", "mail"]]);
  } finally {
    ui.close();
  }
});
test("row editor adds and edits a typed column then saves the full table", async () => {
  const ui = await mount({
    label: "计划",
    type: "rows",
    value: [],
    defaultRow: { count: 1 },
    columns: [{ key: "count", label: "次数", type: "number", integer: true, min: 0 }],
  });
  try {
    await ui.key("+");
    await ui.key("\r");
    await ui.key("3");
    await ui.key("\r");
    await ui.key("\x1b");
    await ui.key("\x13");
    expect(ui.writes).toEqual([[{ count: 3 }]]);
  } finally {
    ui.close();
  }
});
test("secret fields mask replacement text and submit plain text without JSON quoting", async () => {
  const ui = await mount({ label: "密钥", type: "text", sensitive: true, value: "[REDACTED]" });
  try {
    await ui.key("new-private-secret");
    expect(ui.frame).not.toContain("new-private-secret");
    await ui.key("\r");
    expect(ui.writes).toEqual(["new-private-secret"]);
  } finally {
    ui.close();
  }
});
