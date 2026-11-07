import { expect, test } from "bun:test";
import {
  activityGlyph,
  activityPalette,
  breathingColor,
  glimmerColumn,
  marqueeWindow,
  prepareAnimatedText,
  shimmerSegments,
  spinnerFrames,
} from "../src/activity-motion";
import { displayWidth } from "../src/ui";

test("the star grows and shrinks with endpoint pauses and terminal-compatible glyphs", () => {
  expect(spinnerFrames("darwin", "xterm").slice(0, 6)).toEqual(["·", "✢", "*", "✶", "✻", "✽"]);
  expect(spinnerFrames("win32", "xterm")[2]).toBe("*");
  expect(spinnerFrames("linux", "xterm-ghostty").slice(0, 6)).toEqual([
    "·",
    "✢",
    "*",
    "✶",
    "✻",
    "*",
  ]);
  for (const platform of ["linux", "darwin", "win32"] as const) {
    const frames = spinnerFrames(platform, "xterm");
    expect(frames.slice(6)).toEqual(frames.slice(0, 6).reverse());
    expect(frames[5]).toBe(frames[6]);
    expect(frames[11]).toBe(frames[0]);
    expect(frames.every((glyph) => displayWidth(glyph) === 1)).toBe(true);
  }
  expect(activityGlyph(119)).toBe(activityGlyph(0));
  expect(activityGlyph(120)).not.toBe(activityGlyph(119));
  expect(activityGlyph(600)).toBe(activityGlyph(720));
  expect(activityGlyph(1440)).toBe(activityGlyph(0));
  expect(activityGlyph(360, false)).toBe("●");
});

test("request and thinking sweeps move in opposite directions with pauses beyond the label", () => {
  const text = prepareAnimatedText("Working");
  const window = marqueeWindow(text, 20, 0);
  expect(glimmerColumn("requesting", text.cells, 500)).toBe(0);
  expect(glimmerColumn("requesting", text.cells, 550)).toBe(1);
  expect(glimmerColumn("thinking", text.cells, 2000)).toBe(text.cells);
  expect(glimmerColumn("thinking", text.cells, 2200)).toBe(text.cells - 1);
  for (const mode of ["requesting", "thinking"] as const) {
    const interval = mode === "requesting" ? 50 : 200;
    const start = glimmerColumn(mode, text.cells, 0);
    expect(shimmerSegments(text, window, start).highlight).toBe("");
    expect(glimmerColumn(mode, text.cells, (text.cells + 20) * interval)).toBe(start);
  }
  expect(
    shimmerSegments(text, window, glimmerColumn("requesting", text.cells, 550)).highlight
  ).toBe("Wor");
});

test("the three-column highlight preserves text and whole CJK, emoji and combining graphemes", () => {
  const ascii = prepareAnimatedText("abcdef");
  expect(shimmerSegments(ascii, marqueeWindow(ascii, 10, 0), 2)).toEqual({
    before: "a",
    highlight: "bcd",
    after: "ef",
  });
  const text = prepareAnimatedText("A界👩‍💻éZ");
  expect(shimmerSegments(text, marqueeWindow(text, 20, 0), 3).highlight).toBe("界👩‍💻");
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const width of [1, 2, 4, 8]) {
    for (const step of [0, 6, 13]) {
      const window = marqueeWindow(text, width, step);
      const boundaries = new Set([0]);
      let position = 0;
      for (const { segment } of segmenter.segment(window.text)) {
        position += segment.length;
        boundaries.add(position);
      }
      for (const column of [-10, 0, 1, 3, 6, 20]) {
        const parts = shimmerSegments(text, window, column);
        expect(parts.before + parts.highlight + parts.after).toBe(window.text);
        expect(boundaries.has(parts.before.length)).toBe(true);
        expect(boundaries.has(parts.before.length + parts.highlight.length)).toBe(true);
        expect(displayWidth(parts.before + parts.highlight + parts.after)).toBe(window.cells);
        expect(window.cells).toBeLessThanOrEqual(width);
      }
    }
  }
});

test("breathing smoothly reaches both colors every two seconds and never exceeds RGB bounds", () => {
  const palette = activityPalette();
  expect(palette.highlight).toBe("#84ffff");
  expect(breathingColor(palette, 500)).toBe(palette.highlight);
  expect(breathingColor(palette, 1500)).toBe(palette.color);
  expect(breathingColor(palette, 0)).toBe(breathingColor(palette, 2000));
  expect(breathingColor(palette, 100)).not.toBe(breathingColor(palette, 150));
  expect(activityPalette("#fff").highlight).toBe("#ffffff");
  expect(breathingColor(activityPalette("#fefefe"), 500)).toBe("#ffffff");
  expect(breathingColor(activityPalette("red"), 500)).toBe("red");
});
