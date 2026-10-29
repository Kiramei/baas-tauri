import React, { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { observeResizeOnAnimationFrame } from "@/shared/AnimationFrameResizeObserver";

interface AndroidStartupTerminalProps {
  text: string;
}

/** Renders the Android startup log with xterm after the first loading paint. */
const AndroidStartupTerminal: React.FC<AndroidStartupTerminalProps> = ({ text }) => {
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
      scrollback: 160,
      theme: {
        background: "#0b1220",
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

    /** Resizes xterm to match the loading log panel. */
    const resize = () => {
      try {
        fit.fit();
      } catch {
        // The terminal can briefly be detached during route transitions.
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
    term.write(chunk.replace(/\n/g, "\r\n"));
    term.scrollToBottom();
  }, [text]);

  return (
    <div
      ref={hostRef}
      data-android-startup-terminal
      className="terminal-host h-full w-full bg-[#0b1220]"
    />
  );
};

export default AndroidStartupTerminal;
