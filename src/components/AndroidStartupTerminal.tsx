import React, { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { observeResizeOnAnimationFrame } from "@/shared/AnimationFrameResizeObserver";

interface AndroidStartupTerminalProps {
  text: string;
  theme: string;
}

/** Renders the Android startup log with xterm after the first loading paint. */
const AndroidStartupTerminal: React.FC<AndroidStartupTerminalProps> = ({ text, theme }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenLengthRef = useRef(0);
  const previousTextRef = useRef("");

  useEffect(() => {
    if (!hostRef.current) return;

    const isLight = theme === "light";
    const term = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.18,
      scrollback: 160,
      theme: {
        background: "#00000000",
        foreground: isLight ? "#334155" : "#dbe7f3",
        cursor: "transparent",
        selectionBackground: isLight ? "#cbd5e1" : "#38506b",
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
    const isLight = theme === "light";
    term.options.theme = {
      background: "#00000000",
      foreground: isLight ? "#334155" : "#dbe7f3",
      cursor: "transparent",
      selectionBackground: isLight ? "#cbd5e1" : "#38506b",
    };
  }, [theme]);

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

  return <div ref={hostRef} className="terminal-host h-full w-full" />;
};

export default AndroidStartupTerminal;
