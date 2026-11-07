import React, {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Text, useInput, type DOMElement } from "ink";
import { MouseBus, type MouseEvent } from "./terminal";
import { displayWidth, terminalText } from "./ui";
import { useAnimation } from "./motion";
import {
  activityGlyph,
  activityPalette,
  breathingColor,
  glimmerColumn,
  marqueeWindow,
  prepareAnimatedText,
  shimmerSegments,
  type ActivityMode,
} from "./activity-motion";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const MouseContext = createContext<MouseBus | undefined>(undefined);
export function HitBox({
  onPress,
  onWheel,
  children,
  ...props
}: React.ComponentProps<typeof Box> & {
  onPress?: (event: MouseEvent) => void;
  onWheel?: (delta: number) => void;
}) {
  const ref = useRef<DOMElement>(null),
    bus = useContext(MouseContext);
  const callbacks = useRef({ onPress, onWheel });
  const interactive = !!(onPress || onWheel);
  useLayoutEffect(() => {
    callbacks.current = { onPress, onWheel };
  });
  useEffect(() => {
    if (!bus || !interactive) return;
    const handler = (event: MouseEvent) => {
      if (!ref.current || bus.hasCapture) return;
      const ancestors: DOMElement[] = [];
      let current: DOMElement | undefined = ref.current;
      while (current) {
        ancestors.push(current);
        current = current.parentNode;
      }
      let x = 0,
        y = 0;
      // Walk the ancestry once. Hit testing must honor every clipping ancestor,
      // including a scroll viewport covering an otherwise clickable child.
      for (const node of ancestors.reverse()) {
        x += node.yogaNode?.getComputedLeft() || 0;
        y += node.yogaNode?.getComputedTop() || 0;
        if (
          event.x < x ||
          event.x >= x + (node.yogaNode?.getComputedWidth() || 0) ||
          event.y < y ||
          event.y >= y + (node.yogaNode?.getComputedHeight() || 0)
        )
          return;
      }
      if (event.kind === "press" && event.button === 0) callbacks.current.onPress?.(event);
      if (event.kind === "wheel") callbacks.current.onWheel?.(event.delta);
    };
    bus.on("mouse", handler);
    return () => {
      bus.off("mouse", handler);
    };
  }, [bus, interactive]);
  return (
    <Box {...props} ref={ref}>
      {children}
    </Box>
  );
}

/** A one-cell divider that captures left-button drags until release anywhere. */
export function ColumnDivider({
  height,
  onResize,
  color = "#89969f",
  activeColor = "#70d7e5",
}: {
  height: number;
  onResize: (column: number) => void;
  color?: string;
  activeColor?: string;
}) {
  const bus = useContext(MouseContext);
  const [dragging, setDragging] = useState(false);
  const resize = useRef(onResize);
  const release = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    resize.current = onResize;
  });
  useEffect(() => () => release.current?.(), [bus]);
  return (
    <HitBox
      width={1}
      height={height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      onPress={() => {
        if (!bus) return;
        setDragging(true);
        release.current = bus.capture(
          (event) => {
            if (event.button !== 0) return;
            if (event.kind === "drag" || event.kind === "release") resize.current(event.x);
            if (event.kind === "release") {
              release.current?.();
              setDragging(false);
            }
          },
          () => setDragging(false)
        );
      }}
    >
      <Text color={dragging ? activeColor : color}>
        {Array.from({ length: Math.max(0, height) }, () => (dragging ? "┃" : "│")).join("\n")}
      </Text>
    </HitBox>
  );
}

/** Wrap only when the content or viewport changes, not on each wheel event or animation. */
export function wrapTerminalText(value: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const source of terminalText(value).slice(0, 64000).split("\n")) {
    let line = "",
      used = 0;
    for (const { segment } of segmenter.segment(source)) {
      const cells = displayWidth(segment);
      if (used + cells > columns && line) {
        lines.push(line);
        line = "";
        used = 0;
      }
      // A two-cell character cannot fit a one-cell viewport. Never let it wrap
      // into the next control row or split an emoji/combining sequence.
      line += cells > columns ? "…" : segment;
      used += Math.min(cells, columns);
    }
    lines.push(line);
  }
  return lines;
}

/** Scroll actual wrapped content inside the alternate screen, never stale terminal frames. */
export const ScrollText = memo(function ScrollText({
  value,
  width,
  height,
}: {
  value: string;
  width: number;
  height: number;
}) {
  const [scrollOffset, setOffset] = useState(0);
  const lines = useMemo(() => wrapTerminalText(value, width), [value, width]);
  const offset = Math.max(0, Math.min(scrollOffset, lines.length - height));
  const move = (delta: number) =>
    setOffset((previous) =>
      Math.max(
        0,
        Math.min(
          Math.max(0, lines.length - height),
          Math.min(previous, Math.max(0, lines.length - height)) + delta
        )
      )
    );
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
});

/** Bounce at grapheme boundaries so full labels can be read without changing layout. */
export function marqueeText(value: string, width: number, step: number): string {
  return marqueeWindow(prepareAnimatedText(value), width, step).text;
}

function useAnimatedLabel(value: string, width: number, scroll: boolean, motion?: ActivityMode) {
  const prepared = useMemo(() => prepareAnimatedText(value), [value]);
  const animation = useAnimation(
    width > 0 && (!!motion || (scroll && prepared.cells > width)),
    motion ? 50 : 160
  );
  const frame = Math.floor(animation.time / 160);
  const [started, setStarted] = useState(frame);
  useEffect(() => setStarted(frame), [value, width, scroll]);
  const window = useMemo(
    () => marqueeWindow(prepared, width, scroll ? Math.max(0, frame - started) : 0),
    [prepared, width, scroll, frame, started]
  );
  return { prepared, window, ...animation };
}

function GlimmerLabel({
  label,
  motion,
  color,
  ...props
}: {
  label: ReturnType<typeof useAnimatedLabel>;
  motion?: ActivityMode;
} & React.ComponentProps<typeof Text>) {
  const palette = useMemo(() => activityPalette(color), [color]);
  if (!motion || !label.enabled)
    return (
      <Text {...props} color={motion ? palette.color : color} wrap="truncate">
        {label.window.text}
      </Text>
    );
  if (motion === "tool-use")
    return (
      <Text {...props} color={breathingColor(palette, label.time)} wrap="truncate">
        {label.window.text}
      </Text>
    );
  const parts = shimmerSegments(
    label.prepared,
    label.window,
    glimmerColumn(motion, label.window.cells, label.time)
  );
  return (
    <Text {...props} color={palette.color} wrap="truncate">
      {parts.before}
      <Text color={palette.highlight}>{parts.highlight}</Text>
      {parts.after}
    </Text>
  );
}

export const Marquee = memo(function Marquee({
  value,
  width,
  active = true,
  motion,
  ...props
}: { value: string; width: number; active?: boolean; motion?: ActivityMode } & React.ComponentProps<
  typeof Text
>) {
  const label = useAnimatedLabel(value, width, active, active ? motion : undefined);
  return <GlimmerLabel label={label} motion={active ? motion : undefined} {...props} />;
});

/** The star grows and shrinks; a fixed cell keeps the adjacent text still. */
export const Sparkle = memo(function Sparkle({
  active = true,
  ...props
}: { active?: boolean } & React.ComponentProps<typeof Text>) {
  const { time, enabled } = useAnimation(active, 120);
  return (
    <Text color="#70d7e5" {...props}>
      {active ? activityGlyph(time, enabled) : "✦"}
    </Text>
  );
});

/** One local clock subscription drives the star, sweep/breathing and label scroll. */
export const ActivityText = memo(function ActivityText({
  value,
  width,
  active = false,
  mode = "thinking",
  color = "#70d7e5",
  ...props
}: { value: string; width: number; active?: boolean; mode?: ActivityMode } & React.ComponentProps<
  typeof Text
>) {
  const showGlyph = active && width >= 2;
  const label = useAnimatedLabel(
    value,
    Math.max(0, width - (showGlyph ? 2 : 0)),
    true,
    active ? mode : undefined
  );
  return (
    <Box width={Math.max(0, width)} height={1} overflow="hidden">
      {showGlyph && (
        <Box width={2} flexShrink={0}>
          <Text color={color}>{activityGlyph(label.time, label.enabled)} </Text>
        </Box>
      )}
      <GlimmerLabel label={label} motion={active ? mode : undefined} color={color} {...props} />
    </Box>
  );
});

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
