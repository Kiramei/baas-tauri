import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Box, Text, useInput, type DOMElement } from "ink";
import { MouseBus, type MouseEvent } from "./terminal";
import { displayWidth, terminalText } from "./ui";

export const MouseContext = createContext<MouseBus | undefined>(undefined);
function bounds(node: DOMElement) {
  let x = 0,
    y = 0;
  let current: DOMElement | undefined = node;
  while (current) {
    x += current.yogaNode?.getComputedLeft() || 0;
    y += current.yogaNode?.getComputedTop() || 0;
    current = current.parentNode;
  }
  return {
    x,
    y,
    width: node.yogaNode?.getComputedWidth() || 0,
    height: node.yogaNode?.getComputedHeight() || 0,
  };
}
export function HitBox({
  onPress,
  onWheel,
  children,
  ...props
}: React.ComponentProps<typeof Box> & { onPress?: () => void; onWheel?: (delta: number) => void }) {
  const ref = useRef<DOMElement>(null),
    bus = useContext(MouseContext);
  useEffect(() => {
    if (!bus) return;
    const handler = (event: MouseEvent) => {
      if (!ref.current) return;
      let current: DOMElement | undefined = ref.current;
      while (current) {
        const b = bounds(current);
        if (event.x < b.x || event.x >= b.x + b.width || event.y < b.y || event.y >= b.y + b.height)
          return;
        current = current.parentNode;
      }
      if (event.kind === "press" && event.button === 0) onPress?.();
      if (event.kind === "wheel") onWheel?.(event.delta);
    };
    bus.on("mouse", handler);
    return () => {
      bus.off("mouse", handler);
    };
  }, [bus, onPress, onWheel]);
  return (
    <Box {...props} ref={ref}>
      {children}
    </Box>
  );
}

/** Scroll actual wrapped content inside the alternate screen, never stale terminal frames. */
export function ScrollText({
  value,
  width,
  height,
}: {
  value: string;
  width: number;
  height: number;
}) {
  const [scrollOffset, setOffset] = useState(0);
  const lines: string[] = [];
  for (const source of terminalText(value).slice(0, 64000).split("\n")) {
    let line = "",
      used = 0;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      source
    )) {
      const cells = displayWidth(segment);
      if (used + cells > Math.max(1, width) && line) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += segment;
      used += cells;
    }
    lines.push(line);
  }
  const offset = Math.max(0, Math.min(scrollOffset, lines.length - height));
  const move = (delta: number) =>
    setOffset(Math.max(0, Math.min(Math.max(0, lines.length - height), offset + delta)));
  useInput((_input, key) => {
    if (key.pageUp) move(-height);
    if (key.pageDown) move(height);
  });
  return (
    <HitBox flexDirection="column" height={height} width={width} overflow="hidden" onWheel={move}>
      {lines.slice(offset, offset + height).map((line, index) => (
        <Text key={index} wrap="truncate">
          {line || " "}
        </Text>
      ))}
    </HitBox>
  );
}

/** Bounce at grapheme boundaries so full labels can be read without changing layout. */
export function marqueeText(value: string, width: number, step: number): string {
  const text = terminalText(value).replace(/\n/g, " ");
  if (width <= 0) return "";
  const cells = displayWidth(text);
  if (cells <= width) return text;
  const characters = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
  ].map((x) => x.segment);
  const maximum = Math.max(0, cells - width),
    period = maximum * 2 + 8;
  const phase = step % period,
    offset = Math.max(0, Math.min(maximum, phase < maximum + 4 ? phase - 4 : period - phase - 4));
  let skipped = 0,
    result = "",
    used = 0;
  for (const character of characters) {
    const size = displayWidth(character);
    if (skipped < offset) {
      skipped += size;
      continue;
    }
    if (used + size > width) break;
    result += character;
    used += size;
  }
  return result;
}
export function Marquee({
  value,
  width,
  active = true,
  ...props
}: { value: string; width: number; active?: boolean } & React.ComponentProps<typeof Text>) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    setStep(0);
    if (!active || displayWidth(value) <= width) return;
    const timer = setInterval(() => setStep((n) => n + 1), 180);
    return () => clearInterval(timer);
  }, [value, width, active]);
  return (
    <Text {...props} wrap="truncate">
      {marqueeText(value, width, active ? step : 0)}
    </Text>
  );
}
// The desktop mark is a set of overlapping turquoise windows and one detached tile.
export const PIXEL_LOGO = [
  "█████████████ ▄▄▄▄ ",
  "██   ▀▀▀   ██ ▀▀▀▀ ",
  "██      ███████████",
  "██ ▄▄▄▄▄██ ██    ██",
  "█████████████    ██",
  "   ██   ███████████",
  "   ▀▀▀▀▀▀▀▀       ",
];
