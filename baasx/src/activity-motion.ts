import { displayWidth, terminalText } from "./ui";

export type ActivityMode = "requesting" | "thinking" | "tool-use";

// Timing follows the Spinner components in oboard/claude-code-rev at 3b0498a6.
// Keep the terminal renderer independent; these are only glyph/color calculations.
export function spinnerFrames(platform = process.platform, term = process.env.TERM) {
  const forward =
    term === "xterm-ghostty"
      ? ["·", "✢", "✳", "✶", "✻", "*"]
      : platform === "darwin"
        ? ["·", "✢", "✳", "✶", "✻", "✽"]
        : ["·", "✢", "*", "✶", "✻", "✽"];
  // The reference's custom renderer measures ✳ as one cell. npm Ink measures
  // it as two, even with VS15; use its ASCII fallback to keep the label still.
  const fixedWidth = forward.map((glyph) => (displayWidth(glyph) === 1 ? glyph : "*"));
  return [...fixedWidth, ...[...fixedWidth].reverse()];
}

const frames = spinnerFrames();
export function activityGlyph(time: number, animated = true): string {
  return animated ? frames[Math.floor(time / 120) % frames.length] : "●";
}

export function glimmerColumn(mode: ActivityMode, width: number, time: number): number {
  const position = Math.floor(time / (mode === "requesting" ? 50 : 200)) % (width + 20);
  return mode === "requesting" ? position - 10 : width + 10 - position;
}

type RGB = readonly [number, number, number];
const hex = (rgb: RGB) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
export function activityPalette(color = "#70d7e5") {
  const match = /^#([\da-f]{6})$/i.exec(color);
  const short = /^#([\da-f]{3})$/i.exec(color);
  const digits =
    match?.[1] ??
    short?.[1]
      .split("")
      .map((v) => v + v)
      .join("");
  const base: RGB | undefined = digits
    ? ([0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16)) as [
        number,
        number,
        number,
      ])
    : undefined;
  const bright: RGB | undefined = base && [
    Math.min(255, base[0] + 20),
    Math.min(255, base[1] + 40),
    Math.min(255, base[2] + 40),
  ];
  return { color, highlight: bright ? hex(bright) : color, base, bright };
}

export function breathingColor(palette: ReturnType<typeof activityPalette>, time: number) {
  if (!palette.base || !palette.bright) return palette.color;
  const amount = (Math.sin((time / 1000) * Math.PI) + 1) / 2;
  return hex(
    palette.base.map((value, index) =>
      Math.round(value + (palette.bright![index] - value) * amount)
    ) as [number, number, number]
  );
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function prepareAnimatedText(value: string) {
  const text = terminalText(value).replace(/\n/g, " ");
  const characters = [...segmenter.segment(text)].map((entry) => entry.segment);
  const widths = characters.map(displayWidth);
  const positions = [0];
  for (const width of widths) positions.push(positions.at(-1)! + width);
  return { text, characters, widths, positions, cells: positions.at(-1)! };
}

export function marqueeWindow(
  prepared: ReturnType<typeof prepareAnimatedText>,
  width: number,
  step: number
) {
  const { text, cells, positions, characters, widths } = prepared;
  if (width <= 0) return { text: "", start: 0, end: 0, cells: 0 };
  if (cells <= width) return { text, start: 0, end: characters.length, cells };
  const maximum = Math.max(0, cells - width),
    period = maximum * 2 + 8;
  const phase = Math.max(0, step) % period;
  const offset = Math.max(
    0,
    Math.min(maximum, phase < maximum + 4 ? phase - 4 : period - phase - 4)
  );
  let low = 0,
    high = characters.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (positions[middle] < offset) low = middle + 1;
    else high = middle;
  }
  let used = 0,
    result = "",
    end = low;
  for (; end < characters.length; end++) {
    if (used + widths[end] > width) break;
    result += characters[end];
    used += widths[end];
  }
  return { text: result, start: low, end, cells: used };
}

/** Three spans, even for long/CJK labels: never one React node per character. */
export function shimmerSegments(
  prepared: ReturnType<typeof prepareAnimatedText>,
  window: ReturnType<typeof marqueeWindow>,
  column: number
) {
  let before = "",
    highlight = "",
    after = "",
    position = 0;
  const start = Math.max(0, column - 1),
    end = column + 1;
  for (let i = window.start; i < window.end; i++) {
    const char = prepared.characters[i],
      width = prepared.widths[i];
    if (position + width <= start) before += char;
    else if (position > end) after += char;
    else highlight += char;
    position += width;
  }
  return { before, highlight, after };
}
