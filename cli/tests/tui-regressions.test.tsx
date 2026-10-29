import React from "react";
import { afterEach, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { Box, Text, render } from "ink";
import { FieldEditor } from "../src/field-editor";
import { HitBox, MouseContext, ScrollText } from "../src/terminal-components";
import { MouseBus, MouseDecoder, type MouseEvent } from "../src/terminal";
import { displayWidth, terminalText } from "../src/ui";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

async function mount(children: React.ReactNode, columns = 70, rows = 30) {
  let frame = "";
  const mouse = new MouseBus();
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        const text = terminalText(String(chunk));
        if (text.trim()) frame = text;
        done();
      },
    }),
    { columns, rows, isTTY: true }
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const wrap = (children: React.ReactNode) => (
    <MouseContext.Provider value={mouse}>{children}</MouseContext.Provider>
  );
  const app = render(wrap(children), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
    maxFps: 1000,
  });
  cleanups.push(() => {
    app.unmount();
    app.cleanup();
    stdin.destroy();
    stdout.destroy();
  });
  await Bun.sleep(40);
  return {
    mouse,
    get frame() {
      return frame;
    },
    async key(value: string) {
      stdin.write(value);
      await Bun.sleep(40);
    },
    async click(label: string) {
      const lines = frame.split("\n");
      const y = lines.findIndex((line) => line.includes(label));
      expect(y).toBeGreaterThanOrEqual(0);
      const x = displayWidth(lines[y].slice(0, lines[y].indexOf(label)));
      mouse.dispatch({ x, y, button: 0, kind: "press", delta: 0 });
      await Bun.sleep(40);
    },
    async resize(children: React.ReactNode, columns: number) {
      frame = "";
      stdout.columns = columns;
      stdout.emit("resize");
      app.rerender(wrap(children));
      await Bun.sleep(40);
    },
  };
}

test("a six-row field editor keeps the text tail, hint and save controls on separate rows", async () => {
  const writes: unknown[] = [];
  const ui = await mount(
    <FieldEditor
      field={{ label: "目标目录", type: "text", value: "" }}
      language="zh"
      width={24}
      height={6}
      onSave={(value) => {
        writes.push(value);
      }}
      onCancel={() => {}}
    />,
    24,
    6
  );
  const value = "prefix界👩‍💻012345678901234567890123456789LAST";
  await ui.key(value);
  const lines = ui.frame.trimEnd().split("\n");
  const input = lines.find((line) => line.includes("❯"));
  expect(input).toContain("LAST");
  expect(input).not.toContain("直接输入文本");
  expect(lines.some((line) => line.includes("直接输入文本"))).toBe(true);
  expect(lines.some((line) => line.includes("保存") && line.includes("返回"))).toBe(true);
  expect(lines.length).toBeLessThanOrEqual(6);
  for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(24);
  await ui.key("\r");
  expect(writes).toEqual([value]);
});

test("approval text remains readable after widening a scrolled narrow viewport", async () => {
  const value = "abcdefghijklmnopqrstuvwxyz0123456789";
  const ui = await mount(<ScrollText value={value} width={5} height={2} />);
  await ui.key("\x1b[6~");
  await ui.key("\x1b[6~");
  expect(ui.frame).toContain("uvwxy");
  expect(ui.frame).not.toContain("abcde");
  await ui.resize(<ScrollText value={value} width={50} height={2} />, 50);
  expect(ui.frame).toContain(value);
});

test("clicking back inside a table row retains its edited draft until the whole table is saved", async () => {
  const writes: unknown[] = [];
  let cancelled = 0;
  const ui = await mount(
    <FieldEditor
      field={{
        label: "计划",
        type: "rows",
        value: [],
        defaultRow: { count: 1 },
        columns: [{ key: "count", label: "次数", type: "number", integer: true, min: 0 }],
      }}
      language="zh"
      width={60}
      height={20}
      onSave={(value) => {
        writes.push(value);
      }}
      onCancel={() => {
        cancelled++;
      }}
    />
  );
  await ui.key("+");
  await ui.key("\r");
  await ui.key("3");
  await ui.key("\r");
  expect(ui.frame).toContain("次数");
  await ui.click("返回");
  expect(cancelled).toBe(0);
  expect(ui.frame).not.toContain("次数");
  await ui.key("\x13");
  expect(writes).toEqual([[{ count: 3 }]]);
});

test.each([
  { active: false, readOnly: false },
  { active: true, readOnly: true },
])(
  "inactive or read-only fields cannot save through mouse or keyboard: %j",
  async ({ active, readOnly }) => {
    const writes: unknown[] = [];
    const ui = await mount(
      <FieldEditor
        field={{ label: "文本", type: "text", value: "original", readOnly }}
        active={active}
        language="zh"
        width={60}
        height={20}
        onSave={(value) => {
          writes.push(value);
        }}
        onCancel={() => {}}
      />
    );
    await ui.key("replacement");
    await ui.click("保存");
    await ui.key("\r");
    await ui.key("\x13");
    expect(writes).toEqual([]);
    expect(ui.frame).toContain("original");
    expect(ui.frame).not.toContain("replacement");
  }
);

test("hidden controls cannot receive clicks through a clipping ancestor", async () => {
  let hidden = 0,
    visible = 0;
  const ui = await mount(
    <Box width={20} height={5} flexDirection="column">
      <HitBox width={20} height={2} overflow="hidden" flexShrink={0} flexDirection="column">
        <Box height={2} flexShrink={0}>
          <Text>filler</Text>
        </Box>
        <HitBox
          height={1}
          flexShrink={0}
          onPress={() => {
            hidden++;
          }}
        >
          <Text>hidden</Text>
        </HitBox>
      </HitBox>
      <HitBox
        height={1}
        flexShrink={0}
        onPress={() => {
          visible++;
        }}
      >
        <Text>visible</Text>
      </HitBox>
    </Box>
  );
  ui.mouse.dispatch({ x: 0, y: 2, button: 0, kind: "press", delta: 0 });
  ui.mouse.dispatch({ x: 0, y: 2, button: 0, kind: "release", delta: 0 });
  ui.mouse.dispatch({ x: 0, y: 2, button: 2, kind: "press", delta: 0 });
  expect(hidden).toBe(0);
  expect(visible).toBe(1);
});

test("text editing deletes whole emoji and combining graphemes", async () => {
  const writes: unknown[] = [];
  const ui = await mount(
    <FieldEditor
      field={{ label: "文本", type: "text", value: "" }}
      language="zh"
      width={60}
      height={20}
      onSave={(value) => {
        writes.push(value);
      }}
      onCancel={() => {}}
    />
  );
  await ui.key("基👩‍💻é");
  await ui.key("\x7f");
  expect(ui.frame).toContain("基👩‍💻");
  expect(ui.frame).not.toContain("é");
  await ui.key("\x7f");
  await ui.key("\r");
  expect(writes).toEqual(["基"]);
});

test("a truncated mouse report cannot swallow a later control key", () => {
  const events: MouseEvent[] = [];
  const decoder = new MouseDecoder((event) => events.push(event));
  expect(decoder.feed("\x1b[<0;12;")).toBe("");
  expect(decoder.flush()).toBe("");
  expect(decoder.feed("\x03")).toBe("\x03");
  expect(decoder.feed("\x1b[A")).toBe("\x1b[A");
  expect(decoder.feed("\x1b[<0;2;")).toBe("");
  expect(decoder.feed("\x04")).toBe("\x04");
  expect(events).toEqual([]);
});
