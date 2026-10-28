import { describe, expect, test } from "bun:test";
import { EditActionsController } from "../../src/shared/EditActions";

class TestInput extends EventTarget {
  nodeType = 1;
  tagName = "INPUT";
  type = "text";
  isConnected = true;
  readOnly = false;
  disabled = false;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection: "forward" | "backward" | "none" = "none";
  private text: string;
  constructor(
    public ownerDocument: TestDocument,
    value: string
  ) {
    super();
    this.text = value;
  }
  get value() {
    return this.text;
  }
  set value(value: string) {
    this.text = value;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  closest() {
    return null;
  }
  setSelectionRange(
    start: number,
    end: number,
    direction: "forward" | "backward" | "none" = "none"
  ) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  select() {
    this.setSelectionRange(0, this.value.length);
  }
}
class TestDocument extends EventTarget {
  activeElement: TestInput | object | null = null;
  body = { textContent: "page" };
  defaultView = { HTMLInputElement: TestInput, HTMLTextAreaElement: TestInput };
  queryCommandEnabled = (action: string) => action === "undo" || action === "redo";
  execCommand: (command: string, showUI?: boolean, value?: string) => boolean = () => false;
  getSelection = () => null;
}
function setup(
  clipboard: { readText?: () => Promise<string>; writeText?: (text: string) => Promise<void> } = {}
) {
  const doc = new TestDocument();
  const input = new TestInput(doc, "hello world");
  input.setSelectionRange(6, 11, "backward");
  input.focus();
  const controller = new EditActionsController({ document: doc as unknown as Document, clipboard });
  controller.captureTarget();
  return { doc, input, controller };
}
function focusMenu(doc: TestDocument) {
  doc.activeElement = { nodeType: 1, closest: () => ({}) };
}

describe("captured menu editing actions", () => {
  test("paste restores the original editor and selection after the menu takes focus", async () => {
    const { doc, input, controller } = setup({ readText: async () => "BAAS" });
    focusMenu(doc);
    input.setSelectionRange(0, 0);
    controller.captureTarget();
    const events: string[] = [];
    input.addEventListener("beforeinput", () => events.push("beforeinput"));
    input.addEventListener("input", () => events.push("input"));
    expect(await controller.execute("paste")).toEqual({ status: "applied" });
    expect(input.value).toBe("hello BAAS");
    expect([input.selectionStart, input.selectionEnd]).toEqual([10, 10]);
    expect(doc.activeElement).toBe(input);
    expect(events).toEqual(["beforeinput", "input"]);
  });

  test("readonly selections can be copied but never cut or deleted", async () => {
    let copied = "";
    const { input, controller } = setup({
      writeText: async (text) => {
        copied = text;
      },
    });
    input.readOnly = true;
    expect(controller.getAvailability().copy).toBe(true);
    expect(controller.getAvailability().cut).toBe(false);
    expect(await controller.execute("cut")).toMatchObject({ status: "unavailable" });
    expect(await controller.execute("copy")).toEqual({ status: "applied" });
    expect(copied).toBe("world");
    expect(input.value).toBe("hello world");
    expect(input.selectionDirection).toBe("backward");
  });

  test("permission rejection never removes text or reports cut success", async () => {
    const { input, doc, controller } = setup({
      writeText: async () => {
        throw new Error("denied");
      },
    });
    doc.execCommand = () => true; // A claimed native success with no copy event is insufficient.
    expect(await controller.execute("cut")).toEqual({
      status: "failed",
      reason: "clipboard-unavailable",
    });
    expect(input.value).toBe("hello world");
  });

  test("native copy fallback must receive and supply a real copy event", async () => {
    const { doc, controller } = setup();
    let copied = "";
    doc.execCommand = (command) => {
      if (command !== "copy") return false;
      const event = new Event("copy", { cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          setData: (_type: string, text: string) => {
            copied = text;
          },
        },
      });
      doc.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(await controller.execute("copy")).toEqual({ status: "applied" });
    expect(copied).toBe("world");
  });

  test("cut rechecks and restores its editor after asynchronous clipboard access", async () => {
    const { doc, input, controller } = setup({
      writeText: async () => {
        focusMenu(doc);
        input.setSelectionRange(0, 0);
      },
    });
    expect(await controller.execute("cut")).toEqual({ status: "applied" });
    expect(input.value).toBe("hello ");
    expect(input.selectionStart).toBe(6);
    expect(doc.activeElement).toBe(input);
  });

  test("a target changed while awaiting the clipboard is never overwritten", async () => {
    const { input, controller } = setup({
      readText: async () => {
        input.value = "new user input";
        return "old paste";
      },
    });
    expect(await controller.execute("paste")).toEqual({
      status: "unavailable",
      reason: "target-changed",
    });
    expect(input.value).toBe("new user input");
  });

  test("cancelled beforeinput prevents the fallback mutation", async () => {
    const { input, controller } = setup({ readText: async () => "new" });
    input.addEventListener("beforeinput", (event) => event.preventDefault());
    expect(await controller.execute("paste")).toEqual({
      status: "unavailable",
      reason: "canceled",
    });
    expect(input.value).toBe("hello world");
  });

  test("undo/redo use the native stack and reject a true return without a change", async () => {
    const { input, doc, controller } = setup();
    doc.execCommand = () => true;
    expect(await controller.execute("undo")).toEqual({
      status: "unavailable",
      reason: "no-change",
    });
    doc.execCommand = (command) => {
      input.value = command === "undo" ? "hello" : "hello world";
      return true;
    };
    expect(await controller.execute("undo")).toEqual({ status: "applied" });
    expect(input.value).toBe("hello");
    expect(await controller.execute("redo")).toEqual({ status: "applied" });
    expect(input.value).toBe("hello world");
  });

  test("detached targets and password copy do not leak or mutate captured text", async () => {
    let writes = 0;
    const { input, controller } = setup({
      writeText: async () => {
        writes += 1;
      },
    });
    input.isConnected = false;
    expect(await controller.execute("copy")).toMatchObject({ status: "unavailable" });
    input.isConnected = true;
    input.type = "password";
    controller.captureTarget();
    expect(controller.getAvailability().copy).toBe(false);
    expect(await controller.execute("cut")).toMatchObject({ status: "unavailable" });
    expect(writes).toBe(0);
  });

  test("select all remains available on a readonly input", async () => {
    const { input, controller } = setup();
    input.readOnly = true;
    expect(await controller.execute("selectAll")).toEqual({ status: "applied" });
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  });

  test("Delete removes the following character, consistently with the Del shortcut", async () => {
    const { input, doc, controller } = setup();
    input.setSelectionRange(6, 6);
    controller.captureTarget();
    const commands: string[] = [];
    doc.execCommand = (command) => {
      commands.push(command);
      return false;
    };
    expect(await controller.execute("delete")).toEqual({ status: "applied" });
    expect(input.value).toBe("hello orld");
    expect(commands).toEqual(["forwardDelete"]);
  });

  test("global Select All does not refocus a stale detached input", async () => {
    const { input, doc, controller } = setup();
    input.isConnected = false;
    focusMenu(doc);
    const body = {
      nodeType: 1,
      textContent: "page text",
      isConnected: true,
      parentElement: null,
      getAttribute: () => null,
    };
    let selected = "";
    const range = {
      commonAncestorContainer: body,
      startContainer: body,
      endContainer: body,
      toString: () => selected,
      cloneRange() {
        return this;
      },
      selectNodeContents() {
        selected = body.textContent;
      },
    };
    const selection = {
      rangeCount: 0,
      toString: () => selected,
      getRangeAt: () => range,
      removeAllRanges() {
        this.rangeCount = 0;
      },
      addRange() {
        this.rangeCount = 1;
      },
    };
    Object.assign(doc, { body, getSelection: () => selection, createRange: () => range });
    expect(await controller.execute("selectAll")).toEqual({ status: "applied" });
    expect(selected).toBe("page text");
    expect(doc.activeElement).not.toBe(input);
  });

  test("an empty clipboard and denied reads leave the selected text intact", async () => {
    const empty = setup({ readText: async () => "" });
    expect(await empty.controller.execute("paste")).toEqual({
      status: "unavailable",
      reason: "empty-clipboard",
    });
    expect(empty.input.value).toBe("hello world");
    const denied = setup({
      readText: async () => {
        throw new Error("denied");
      },
    });
    expect(await denied.controller.execute("paste")).toEqual({
      status: "failed",
      reason: "clipboard-denied",
    });
    expect(denied.input.value).toBe("hello world");
  });
});
