import React, { act } from "react";
import { test, expect } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { FieldEditor, type EditableField } from "../src/field-editor";
import { terminalText } from "../src/ui";
import { MouseBus, terminalSession } from "../src/terminal";
async function mount(field: EditableField, options: { terminal?: boolean } = {}) {
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
  const session = options.terminal
    ? terminalSession(
        stdin as unknown as NodeJS.ReadStream,
        stdout as unknown as NodeJS.WriteStream,
        new MouseBus()
      )
    : undefined;
  const input = session?.input ?? stdin;
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
      stdin: input as unknown as NodeJS.ReadStream,
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
    async burst(...chunks: string[]) {
      const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previous = environment.IS_REACT_ACT_ENVIRONMENT;
      environment.IS_REACT_ACT_ENVIRONMENT = true;
      try {
        await act(async () => {
          for (const chunk of chunks) {
            stdin.write(chunk);
            input.emit("readable");
          }
          await Bun.sleep(0);
        });
      } finally {
        if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
        else environment.IS_REACT_ACT_ENVIRONMENT = previous;
      }
      await settle();
    },
    async waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 2_000;
      while (!predicate()) {
        if (Date.now() >= deadline)
          throw new Error(`Editor did not reach the expected state:\n${frame}`);
        await Bun.sleep(10);
      }
    },
    close() {
      app.unmount();
      app.cleanup();
      session?.close();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

const rapidFields: Array<{ field: EditableField; keys: string[]; value: unknown }> = [
  { field: { label: "Number", type: "number", value: 1 }, keys: ["2", "3", "\r"], value: 23 },
  {
    field: { label: "Text", type: "text", value: "old" },
    keys: ["老师👩‍💻é", "\r"],
    value: "老师👩‍💻é",
  },
  { field: { label: "Switch", type: "switch", value: false }, keys: [" ", "\r"], value: true },
  {
    field: {
      label: "Select",
      type: "select",
      value: 1,
      options: [
        { label: "Number", value: 1 },
        { label: "String", value: "1" },
      ],
    },
    keys: ["\x1b[B", "\r"],
    value: "1",
  },
  {
    field: {
      label: "Multiple",
      type: "multiselect",
      value: [1],
      options: [
        { label: "Number", value: 1 },
        { label: "String", value: "1" },
      ],
    },
    keys: ["\x1b[B", " ", "\x13"],
    value: [1, "1"],
  },
];
test.each(
  rapidFields.flatMap((sample) => [false, true].map((coalesced) => ({ ...sample, coalesced })))
)("framed field input saves its current value: %j", async ({ field, keys, value, coalesced }) => {
  const ui = await mount(field, { terminal: true });
  try {
    await ui.burst(...(coalesced ? [keys.join("")] : keys));
    expect(ui.writes).toEqual([value]);
  } finally {
    ui.close();
  }
});

test("a framed save locks another save in the same batch", async () => {
  const ui = await mount({ label: "Number", type: "number", value: 1 }, { terminal: true });
  try {
    await ui.burst("2\r\x13");
    expect(ui.writes).toEqual([2]);
  } finally {
    ui.close();
  }
});

test("an oversized bracketed paste preserves the entire original field draft", async () => {
  const ui = await mount({ label: "Text", type: "text", value: "original" }, { terminal: true });
  try {
    await ui.burst("\x1b[200~" + "x".repeat(8193));
    await ui.burst("trailing\r\x13\x1b[201~");
    expect(ui.writes).toEqual([]);
    expect(ui.frame).toContain("❯ original");
    await ui.burst("\r");
    expect(ui.writes).toEqual(["original"]);
  } finally {
    ui.close();
  }
});

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
    await ui.waitFor(() => ui.frame.includes("❯ 99"));
    await ui.key("\r");
    expect(ui.writes).toEqual([]);
    await ui.waitFor(() => ui.frame.includes("数值超出范围"));
    await ui.key("\x01");
    await ui.waitFor(() => !ui.frame.includes("数值超出范围") && !ui.frame.includes("❯ 99"));
    await ui.key("12");
    await ui.waitFor(() => ui.frame.includes("❯ 12"));
    await ui.key("\r");
    await ui.waitFor(() => ui.writes.length > 0);
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
