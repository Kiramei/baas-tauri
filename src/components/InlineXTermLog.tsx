import React, { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { observeResizeOnAnimationFrame } from "@/shared/AnimationFrameResizeObserver";

/** Renders a compact xterm log for Android updater output. */
const InlineXTermLog: React.FC<{ text: string }> = ({ text }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenLengthRef = useRef(0);
  const previousTextRef = useRef("");

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.18,
      scrollback: 1000,
      theme: {
        background: "#00000000",
        foreground: "#dbe7f3",
        cursor: "transparent",
        selectionBackground: "#38506b",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    /** Resizes xterm to match the update log panel. */
    const resize = () => {
      try {
        fit.fit();
      } catch {
        // The terminal may be hidden while the update popover is closing.
      }
    };
    const stopObserving = observeResizeOnAnimationFrame(hostRef.current, resize);

    return () => {
      stopObserving();
      fit.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenLengthRef.current = 0;
      previousTextRef.current = "";
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (text.length < writtenLengthRef.current || !text.startsWith(previousTextRef.current)) {
      term.reset();
      term.clear();
      writtenLengthRef.current = 0;
    }
    const chunk = text.slice(writtenLengthRef.current);
    if (!chunk) return;
    writtenLengthRef.current = text.length;
    previousTextRef.current = text;
    term.write(chunk);
    term.scrollToBottom();
  }, [text]);

  return <div ref={hostRef} className="terminal-host h-full w-full" />;
};

export default InlineXTermLog;
