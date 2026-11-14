import type { IBufferLine, ITheme, Terminal } from "@xterm/xterm";

const ansiKeys = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
const ansiDefaults = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec",
];

function paletteColor(index: number, theme: ITheme | undefined): string {
  if (index < 16) return theme?.[ansiKeys[index]] ?? ansiDefaults[index];
  if (index >= 232)
    return `rgb(${Array(3)
      .fill(8 + (index - 232) * 10)
      .join(",")})`;
  const value = index - 16;
  const channel = (level: number) => (level === 0 ? 0 : 55 + level * 40);
  return `rgb(${channel(Math.floor(value / 36))},${channel(Math.floor(value / 6) % 6)},${channel(value % 6)})`;
}

function lineAttributes(line: IBufferLine, term: Terminal): string {
  const cell = term.buffer.active.getNullCell();
  let signature = "";
  let previous = "";
  for (let column = 0; column < line.length; column++) {
    if (!line.getCell(column, cell) || cell.getWidth() === 0) continue;
    const value = cell.isAttributeDefault()
      ? "default"
      : [
          cell.getFgColorMode(),
          cell.getFgColor(),
          cell.getBgColorMode(),
          cell.getBgColor(),
          !!cell.isBold(),
          !!cell.isItalic(),
          !!cell.isDim(),
          !!cell.isUnderline(),
          !!cell.isInverse(),
          !!cell.isInvisible(),
          !!cell.isStrikethrough(),
          !!cell.isOverline(),
        ].join(":");
    if (value !== previous) signature += `${column}:${value};`;
    previous = value;
  }
  return signature;
}

function renderLine(
  line: IBufferLine,
  term: Terminal,
  defaultBackground: string,
  newline: boolean
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const cell = term.buffer.active.getNullCell();
  let span: HTMLSpanElement | undefined;
  let previousStyle = "";
  let run = "";
  let lastColumn = line.length - 1;
  while (lastColumn >= 0) {
    line.getCell(lastColumn, cell);
    if (cell.getChars() || !cell.isBgDefault()) break;
    lastColumn--;
  }
  for (let column = 0; column <= lastColumn; column++) {
    if (!line.getCell(column, cell) || cell.getWidth() === 0) continue;
    const color = (rgb: boolean, palette: boolean, value: number, fallback: string) =>
      rgb
        ? `#${value.toString(16).padStart(6, "0")}`
        : palette
          ? paletteColor(value, term.options.theme)
          : fallback;
    let foreground = color(
      cell.isFgRGB(),
      cell.isFgPalette(),
      cell.getFgColor(),
      term.options.theme?.foreground ?? "inherit"
    );
    let background = color(
      cell.isBgRGB(),
      cell.isBgPalette(),
      cell.getBgColor(),
      cell.isInverse() ? defaultBackground : "transparent"
    );
    if (cell.isInverse()) [foreground, background] = [background, foreground];
    const decoration = [
      cell.isUnderline() ? "underline" : "",
      cell.isStrikethrough() ? "line-through" : "",
      cell.isOverline() ? "overline" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const style = `color:${foreground};background-color:${background};font-weight:${cell.isBold() ? "bold" : "normal"};font-style:${cell.isItalic() ? "italic" : "normal"};opacity:${cell.isDim() ? ".5" : "1"};text-decoration:${decoration || "none"}`;
    if (!span || style !== previousStyle) {
      if (span) span.textContent = run;
      run = "";
      span = document.createElement("span");
      span.style.cssText = style;
      fragment.append(span);
      previousStyle = style;
    }
    run += cell.isInvisible() ? " " : cell.getChars() || " ";
  }
  if (span) span.textContent = run;
  // A newline remains real text for Android's native selection and clipboard.
  if (newline) fragment.append(document.createTextNode("\n"));
  return fragment;
}

/** Keeps terminal parsing while exposing native, selectable text without an IME on Android. */
export function attachAndroidReadOnlyTerminal(term: Terminal, host: HTMLElement): () => void {
  const textarea = term.textarea;
  if (textarea) {
    textarea.readOnly = true;
    textarea.inputMode = "none";
    textarea.tabIndex = -1;
    textarea.setAttribute("aria-readonly", "true");
  }

  const terminalElement = term.element;
  if (!terminalElement) return () => {};
  const previousPosition = host.style.position;
  let defaultBackground = term.options.theme?.background;
  if (
    !defaultBackground ||
    /^(?:transparent|#(?:[0-9a-f]{6}00|[0-9a-f]{3}0))$/i.test(defaultBackground)
  ) {
    defaultBackground = "#000000";
    for (let ancestor: HTMLElement | null = host; ancestor; ancestor = ancestor.parentElement) {
      const background = getComputedStyle(ancestor).backgroundColor;
      if (background !== "transparent" && background !== "rgba(0, 0, 0, 0)") {
        defaultBackground = background;
        break;
      }
    }
  }
  host.style.position = "relative";
  terminalElement.style.visibility = "hidden";
  terminalElement.setAttribute("aria-hidden", "true");

  // xterm's canvas cannot offer Android's native long-press selection menu.
  // A non-editable text layer also avoids its hidden textarea receiving taps.
  const text = document.createElement("pre");
  text.dataset.androidReadonlyLog = "";
  text.className = "allow-select-text";
  Object.assign(text.style, {
    position: "absolute",
    inset: "0",
    margin: "0",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontFamily: term.options.fontFamily,
    fontSize: `${term.options.fontSize}px`,
    lineHeight: String(term.options.lineHeight),
    color: term.options.theme?.foreground,
    userSelect: "text",
    touchAction: "pan-x pan-y",
  });
  text.style.setProperty("-webkit-user-select", "text");
  host.append(text);

  const hasSelection = () => {
    const selection = document.getSelection();
    return (
      !!selection &&
      !selection.isCollapsed &&
      (text.contains(selection.anchorNode) || text.contains(selection.focusNode))
    );
  };
  let frame = 0;
  let pointerDown = false;
  let dirty = true;
  const rows: { element: HTMLSpanElement; signature: string }[] = [];
  const render = () => {
    frame = 0;
    if (!dirty) return;
    // Appending output must not dismiss Android's selection/copy handles.
    if (pointerDown || hasSelection()) return;
    const buffer = term.buffer.active;
    const lines: { value: string; index: number }[] = [];
    for (let index = 0; index < buffer.length; index++) {
      lines.push({ value: buffer.getLine(index)?.translateToString(true) ?? "", index });
    }
    while (lines.length > 1 && lines[lines.length - 1]?.value === "") lines.pop();
    const followOutput = text.scrollHeight - text.clientHeight - text.scrollTop < 24;
    for (const { value, index } of lines) {
      let row = rows[index];
      if (!row) {
        row = { element: document.createElement("span"), signature: "\0" };
        rows.push(row);
        text.append(row.element);
      }
      const line = buffer.getLine(index);
      const newline = !buffer.getLine(index + 1)?.isWrapped;
      const signature = value + "\0" + newline + "\0" + (line ? lineAttributes(line, term) : "");
      if (line && row.signature !== signature) {
        row.element.replaceChildren(renderLine(line, term, defaultBackground, newline));
        row.signature = signature;
      }
    }
    while (rows.length > lines.length) rows.pop()?.element.remove();
    if (followOutput) text.scrollTop = text.scrollHeight;
    dirty = false;
  };
  const scheduleRender = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };
  const invalidate = () => {
    dirty = true;
    scheduleRender();
  };
  const write = term.onWriteParsed(invalidate);
  const resize = term.onResize(invalidate);
  const paint = term.onRender(invalidate);
  const hold = () => {
    pointerDown = true;
  };
  const release = () => {
    pointerDown = false;
    scheduleRender();
  };
  text.addEventListener("pointerdown", hold, { passive: true });
  window.addEventListener("pointerup", release, { passive: true });
  window.addEventListener("pointercancel", release, { passive: true });
  document.addEventListener("selectionchange", scheduleRender);
  render();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    write.dispose();
    resize.dispose();
    paint.dispose();
    text.removeEventListener("pointerdown", hold);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    document.removeEventListener("selectionchange", scheduleRender);
    text.remove();
    terminalElement.style.visibility = "";
    terminalElement.removeAttribute("aria-hidden");
    host.style.position = previousPosition;
  };
}
