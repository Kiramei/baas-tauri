export type EditAction = "undo" | "redo" | "cut" | "copy" | "paste" | "delete" | "selectAll";
export type EditActionResult = {
  status: "applied" | "unavailable" | "failed";
  reason?: string;
};
export type EditAvailability = Record<EditAction, boolean>;
type TextControl = HTMLInputElement | HTMLTextAreaElement;
type ClipboardAccess = Partial<Pick<Clipboard, "readText" | "writeText">>;
type Target = {
  element: HTMLElement | null;
  control: TextControl | null;
  range: Range | null;
  start: number | null;
  end: number | null;
  direction: "forward" | "backward" | "none";
  value: string;
  text: string;
  writable: boolean;
  undo: boolean;
  redo: boolean;
  nativePaste: boolean;
  forwardDelete: boolean;
  backward?: boolean;
};

const isElement = (node: unknown): node is HTMLElement =>
  Boolean(node && typeof node === "object" && (node as Node).nodeType === 1);
const isControl = (element: HTMLElement): element is TextControl =>
  element.tagName === "TEXTAREA" ||
  (element.tagName === "INPUT" &&
    !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(
      (element as HTMLInputElement).type
    ));

function contentEditor(element: HTMLElement | null): HTMLElement | null {
  for (let current = element; current; current = current.parentElement) {
    const attribute = current.getAttribute("contenteditable");
    if (attribute === "false") return null;
    if (attribute === "" || attribute === "true" || attribute === "plaintext-only") return current;
  }
  return null;
}

/** Menu actions use the captured editor, never whichever menu button later has focus. */
export class EditActionsController {
  private target: Target | null = null;
  private acting = false;
  private restoring = false;
  private readonly doc: Document;
  private readonly clipboard?: ClipboardAccess;

  constructor(options: { document: Document; clipboard?: ClipboardAccess }) {
    this.doc = options.document;
    this.clipboard = options.clipboard ?? options.document.defaultView?.navigator.clipboard;
  }

  private enabled(command: string) {
    try {
      return this.doc.queryCommandEnabled?.(command) === true;
    } catch {
      return false;
    }
  }

  private capture(element: HTMLElement | null): Target | null {
    if (element && isControl(element)) {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      return {
        element,
        control: element,
        range: null,
        start,
        end,
        direction: element.selectionDirection ?? "none",
        value: element.value,
        // Match native password-field copy restrictions; pasting remains available.
        text:
          element.tagName === "INPUT" && (element as HTMLInputElement).type === "password"
            ? ""
            : start !== null && end !== null
              ? element.value.slice(start, end)
              : "",
        writable: !element.readOnly && !element.disabled,
        undo: this.enabled("undo"),
        redo: this.enabled("redo"),
        nativePaste: this.enabled("paste"),
        forwardDelete: this.enabled("forwardDelete"),
      };
    }
    const selection = this.doc.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const anchor = range?.commonAncestorContainer;
    const rangeElement = isElement(anchor) ? anchor : (anchor?.parentElement ?? null);
    const editor = contentEditor(element) ?? contentEditor(rangeElement);
    const scopedRange =
      editor && range && !editor.contains(range.commonAncestorContainer) ? null : range;
    if (!editor && !selection?.toString()) return null;
    return {
      element: editor ?? element,
      control: null,
      range: scopedRange,
      start: null,
      end: null,
      direction: "none",
      value: editor?.innerHTML ?? "",
      text: editor && !scopedRange ? "" : (selection?.toString() ?? ""),
      writable: Boolean(editor),
      undo: this.enabled("undo"),
      redo: this.enabled("redo"),
      nativePaste: this.enabled("paste"),
      forwardDelete: this.enabled("forwardDelete"),
      backward: Boolean(
        range &&
        selection?.anchorNode === range.endContainer &&
        selection.anchorOffset === range.endOffset
      ),
    };
  }

  captureTarget = () => {
    const active = this.doc.activeElement;
    // A keyboard-opened menubar already owns focus. Keep the last editor/selection.
    if (isElement(active) && active.closest("[aria-haspopup='menu'], [role='menu']")) return;
    this.target = this.capture(isElement(active) ? active : null);
  };

  /** Called by passive focus/selection observers; never handles keyboard shortcuts. */
  rememberTarget = () => {
    if (this.acting || this.restoring) return;
    this.captureTarget();
  };

  private valid(target = this.target): target is Target {
    if (!target) return false;
    if (target.element && !target.element.isConnected) return false;
    if (target.control) return target.control.value === target.value;
    if (target.writable) return target.element?.innerHTML === target.value;
    return Boolean(
      target.range?.startContainer.isConnected &&
      target.range.endContainer.isConnected &&
      target.range.toString() === target.text
    );
  }

  private writable(target: Target) {
    return (
      target.writable &&
      (target.control
        ? !target.control.disabled && !target.control.readOnly
        : contentEditor(target.element) !== null && target.range !== null)
    );
  }

  restoreTarget = (): boolean => {
    const target = this.target;
    if (!this.valid(target)) return false;
    this.restoring = true;
    try {
      target.element?.focus({ preventScroll: true });
      if (target.control && target.start !== null && target.end !== null) {
        target.control.setSelectionRange(target.start, target.end, target.direction);
      } else if (target.range) {
        const selection = this.doc.getSelection();
        selection?.removeAllRanges();
        if (target.backward && selection?.setBaseAndExtent) {
          selection.setBaseAndExtent(
            target.range.endContainer,
            target.range.endOffset,
            target.range.startContainer,
            target.range.startOffset
          );
        } else selection?.addRange(target.range.cloneRange());
      }
      return true;
    } catch {
      return false;
    } finally {
      this.restoring = false;
    }
  };

  getAvailability = (): EditAvailability => {
    const target = this.target;
    const valid = this.valid(target);
    const writable = valid && this.writable(target);
    return {
      undo: writable && target.undo,
      redo: writable && target.redo,
      cut: writable && Boolean(target.text),
      copy: valid && Boolean(target.text),
      paste: writable && (typeof this.clipboard?.readText === "function" || target.nativePaste),
      delete:
        writable &&
        (target.control
          ? target.start !== null &&
            target.end !== null &&
            target.start < target.control.value.length
          : Boolean(target.range && (!target.range.collapsed || target.forwardDelete))),
      selectAll: valid || Boolean(this.doc.body?.textContent),
    };
  };

  private value(target: Target) {
    return target.control?.value ?? target.element?.innerHTML ?? "";
  }

  private editState(target: Target) {
    const selection = target.control
      ? [target.control.selectionStart, target.control.selectionEnd]
      : [this.doc.getSelection()?.toString() ?? ""];
    return JSON.stringify([this.value(target), selection]);
  }

  /** Native edits preserve the browser undo stack; a true return alone proves nothing. */
  private nativeEdit(target: Target, command: string, text?: string) {
    const before = this.editState(target);
    const beforeEvents: Event[] = [];
    const listen = (event: Event) => beforeEvents.push(event);
    this.doc.addEventListener("beforeinput", listen, true);
    try {
      this.doc.execCommand?.(command, false, text);
    } catch {
      /* Try the safe fallback. */
    } finally {
      this.doc.removeEventListener("beforeinput", listen, true);
    }
    return {
      changed: this.editState(target) !== before,
      canceled: beforeEvents.some((event) => event.defaultPrevented),
    };
  }

  private inputEvent(type: string, inputType: string, data: string | null, cancelable: boolean) {
    const Constructor = this.doc.defaultView?.InputEvent;
    return Constructor
      ? new Constructor(type, { bubbles: true, cancelable, inputType, data })
      : new Event(type, { bubbles: true, cancelable });
  }

  private replace(target: Target, text: string, inputType: string): EditActionResult {
    if (!this.valid(target) || !this.writable(target))
      return { status: "unavailable", reason: "target-changed" };
    const before = this.editState(target);
    const native = this.nativeEdit(
      target,
      text ? "insertText" : inputType === "deleteContentForward" ? "forwardDelete" : "delete",
      text || undefined
    );
    if (native.changed) return { status: "applied" };
    if (native.canceled) return { status: "unavailable", reason: "canceled" };
    const element = target.element!;
    if (!element.dispatchEvent(this.inputEvent("beforeinput", inputType, text || null, true))) {
      return { status: "unavailable", reason: "canceled" };
    }
    if (!this.valid(target) || !this.writable(target))
      return { status: "unavailable", reason: "target-changed" };
    if (target.control) {
      const { control, start, end } = target;
      if (start === null || end === null)
        return { status: "unavailable", reason: "unsupported-selection" };
      const nextEnd =
        start === end && !text ? end + (Array.from(control.value.slice(end))[0]?.length ?? 0) : end;
      const value = control.value.slice(0, start) + text + control.value.slice(nextEnd);
      const view = this.doc.defaultView;
      const prototype =
        control.tagName === "INPUT"
          ? view?.HTMLInputElement.prototype
          : view?.HTMLTextAreaElement.prototype;
      const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(control, value);
      else control.value = value;
      control.setSelectionRange(start + text.length, start + text.length);
    } else if (target.range && element.contains(target.range.commonAncestorContainer)) {
      const range = target.range.cloneRange();
      if (range.collapsed && !text) return { status: "unavailable", reason: "no-selection" };
      range.deleteContents();
      if (text) {
        const node = this.doc.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
      }
      range.collapse(true);
      this.doc.getSelection()?.removeAllRanges();
      this.doc.getSelection()?.addRange(range);
    } else return { status: "unavailable", reason: "no-selection" };
    element.dispatchEvent(this.inputEvent("input", inputType, text || null, false));
    return this.editState(target) !== before
      ? { status: "applied" }
      : { status: "failed", reason: "no-change" };
  }

  private async copy(text: string): Promise<EditActionResult> {
    try {
      if (this.clipboard?.writeText) {
        await this.clipboard.writeText(text);
        return { status: "applied" };
      }
    } catch {
      /* Native copy may still be available in a user-initiated menu action. */
    }
    let supplied = false;
    const listener = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      supplied = true;
    };
    this.doc.addEventListener("copy", listener);
    try {
      const accepted = this.doc.execCommand?.("copy") === true;
      return accepted && supplied
        ? { status: "applied" }
        : { status: "failed", reason: "clipboard-unavailable" };
    } catch {
      return { status: "failed", reason: "clipboard-unavailable" };
    } finally {
      this.doc.removeEventListener("copy", listener);
    }
  }

  execute = async (action: EditAction): Promise<EditActionResult> => {
    if (this.acting) return { status: "unavailable", reason: "busy" };
    const target = this.valid(this.target) ? this.target : null;
    if (action !== "selectAll" && !this.valid(target))
      return { status: "unavailable", reason: "target-changed" };
    if (!this.getAvailability()[action]) return { status: "unavailable", reason: "not-available" };
    this.acting = true;
    try {
      if (target && !this.restoreTarget())
        return { status: "unavailable", reason: "target-changed" };
      let result: EditActionResult;
      if (action === "copy" || action === "cut") {
        result = await this.copy(target!.text);
        if (action === "cut" && result.status === "applied")
          result = this.restoreTarget()
            ? this.replace(target!, "", "deleteByCut")
            : { status: "unavailable", reason: "target-changed" };
      } else if (action === "paste") {
        if (this.clipboard?.readText) {
          let text: string;
          try {
            text = await this.clipboard.readText();
          } catch {
            return { status: "failed", reason: "clipboard-denied" };
          }
          if (!this.restoreTarget()) return { status: "unavailable", reason: "target-changed" };
          result = text
            ? this.replace(target!, text, "insertFromPaste")
            : { status: "unavailable", reason: "empty-clipboard" };
        } else {
          result = this.nativeEdit(target!, "paste").changed
            ? { status: "applied" }
            : { status: "failed", reason: "clipboard-unavailable" };
        }
      } else if (action === "delete") result = this.replace(target!, "", "deleteContentForward");
      else if (action === "undo" || action === "redo") {
        result = this.nativeEdit(target!, action).changed
          ? { status: "applied" }
          : { status: "unavailable", reason: "no-change" };
      } else {
        if (target?.control) {
          target.control.select();
          result =
            target.control.selectionStart === 0 &&
            target.control.selectionEnd === target.control.value.length
              ? { status: "applied" }
              : { status: "unavailable", reason: "unsupported-selection" };
        } else {
          const range = this.doc.createRange();
          range.selectNodeContents(target?.writable ? target.element! : this.doc.body);
          const selection = this.doc.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          result = selection?.rangeCount
            ? { status: "applied" }
            : { status: "unavailable", reason: "no-selection" };
        }
      }
      // Capture the resulting caret/value before restoring focus after asynchronous clipboard calls.
      if (result.status === "applied") this.target = this.capture(target?.element ?? null);
      return result;
    } catch {
      return { status: "failed", reason: "edit-failed" };
    } finally {
      this.restoreTarget();
      this.acting = false;
    }
  };
}
