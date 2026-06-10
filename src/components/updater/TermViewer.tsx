import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Copy, Terminal as TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import { useGlobalLogStore } from "@/store/GlobalLogStore.ts";
import { FitAddon } from "@xterm/addon-fit/src/FitAddon.ts";
import { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TerminalHandle {
  write: (chunk: string) => void;
  reset: () => void;
  resize: () => void;
  setRunning: (running: boolean) => void;
}

// type TermTaskStatus = "idle" | "pending" | "running" | "success" | "failed" | "stopped";

interface TermChunkPayload {
  sessionId: string;
  chunk: string;
}

// interface TermTaskStartedPayload {
//   sessionId: string;
//   taskId: string;
//   regionId: string;
//   stepIndex: number;
//   stepTotal: number;
//   name: string;
//   command: string;
//   status: "running";
// }
//
// interface TermTaskStatusPayload {
//   sessionId: string;
//   taskId: string;
//   regionId: string;
//   status: Exclude<TermTaskStatus, "idle">;
//   exitCode?: number;
//   error?: string;
//   startedAt?: string;
//   finishedAt?: string;
// }
//
// interface TermSessionFinishedPayload {
//   sessionId: string;
//   success: boolean;
// }

interface TermClearedPayload {
  sessionId?: string;
}

const TermEmulator = forwardRef<TerminalHandle>((_, ref) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const resize = () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    fit.fit();
    void invoke("resize_term", {
      rows: term.rows,
      cols: term.cols,
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      write: (chunk: string) => termRef.current?.write(chunk),
      reset: () => {
        const term = termRef.current;
        if (!term) return;
        term.reset();
        term.clear();
      },
      setRunning: (running: boolean) => {
        const term = termRef.current;
        if (!term) return;
        term.options.scrollback = running ? 0 : 10000;
        if (running) {
          term.scrollToBottom();
        }
      },
      resize,
    }),
    []
  );

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.22,
      scrollback: 0,
      theme: {
        background: "#06080a00",
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

    const observer = new ResizeObserver(() => resize());
    observer.observe(hostRef.current);
    requestAnimationFrame(() => resize());

    return () => {
      observer.disconnect();
      fit.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  return <div ref={hostRef} className="terminal-host" />;
});

TermEmulator.displayName = "TermEmulator";

const TermViewer: React.FC = () => {
  const terminalLogData = useGlobalLogStore((e) => e.terminalLogData);

  const terminalRef = useRef<TerminalHandle | null>(null);
  const startTerminalDemo = async () => {
    terminalRef.current?.setRunning(true);
    terminalRef.current?.reset();
    await invoke("start_term_demo");
  };

  const copyLogs = () => {
    const text = terminalLogData
      .map((l) => `[${l.time}] [${l.level.toUpperCase()}] ${l.message}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(undefined);
    toast.success("Logs copied to clipboard");
  };

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    async function bindEvents() {
      const listeners = await Promise.all([
        listen<TermChunkPayload>("term:chunk", (event) => {
          if (disposed) return;
          terminalRef.current?.write(event.payload.chunk);
        }),
        // listen<TermTaskStartedPayload>("term:task-started", (event) => {
        //   if (disposed) return;
        //   // const payload = event.payload;
        //   // setTasks((current) => ({
        //   //   ...current,
        //   //   [payload.taskId]: {
        //   //     taskId: payload.taskId,
        //   //     regionId: payload.regionId,
        //   //     label: `[${String(payload.stepIndex).padStart(2, "0")}/${String(payload.stepTotal).padStart(2, "0")}] ${payload.name}`,
        //   //     name: payload.name,
        //   //     command: payload.command,
        //   //     status: payload.status,
        //   //     startedAt: new Date().toISOString(),
        //   //   },
        //   // }));
        // }),
        // listen<TermTaskStatusPayload>("term:task-status", (event) => {
        //   if (disposed) return;
        //   // const payload = event.payload;
        //   // setTasks((current) => {
        //   //   const previous = current[payload.taskId];
        //   //   if (!previous) return current;
        //   //   return {
        //   //     ...current,
        //   //     [payload.taskId]: {
        //   //       ...previous,
        //   //       status: payload.status,
        //   //       exitCode: payload.exitCode,
        //   //       finishedAt: payload.finishedAt ?? previous.finishedAt,
        //   //     },
        //   //   };
        //   // });
        // }),
        // listen<TermSessionFinishedPayload>("term:session-finished", (event) => {
        //   if (disposed) return;
        //   terminalRef.current?.setRunning(false);
        //   // setSession((current) => ({
        //   //   ...current,
        //   //   status: event.payload.success ? "success" : "failed",
        //   //   finishedAt: new Date().toISOString(),
        //   // }));
        // }),
        listen<TermClearedPayload>("term:dashboard-cleared", () => {
          if (disposed) return;
          terminalRef.current?.setRunning(true);
          terminalRef.current?.reset();
          // setTasks({});
          // setSession({ status: "idle" });
        }),
      ]);

      if (disposed) {
        for (const unlisten of listeners) {
          unlisten();
        }
        return;
      }
      unlisteners.push(...listeners);
    }

    void bindEvents();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);

  return (
    <div className="rounded-lg border border-border bg-transparent text-card-foreground shadow-sm overflow-hidden flex flex-col h-100">
      <div className="flex items-center justify-between px-3 py-0 border-b border-border bg-muted/50">
        <div className="flex items-center gap-2">
          <button className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 focus:outline-none transition duration-150 ease-in-out" />
          <button className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 focus:outline-none transition duration-150 ease-in-out" />
          <button
            className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 focus:outline-none transition duration-150 ease-in-out"
            onClick={startTerminalDemo}
          />
        </div>

        <div className="flex items-center gap-2 text-sm font-medium">
          <TerminalIcon className="w-4 h-4" />
          <span>Installation Logs</span>
        </div>

        <Button variant="ghost" size="icon" onClick={copyLogs}>
          <Copy className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-2 font-mono text-xs bg-black/90 dark:bg-black/50 text-gray-300">
        <TermEmulator ref={terminalRef} />

        {/*{terminalLogData.length === 0 && (*/}
        {/*  <div className="text-gray-500 italic">Waiting for logs...</div>*/}
        {/*)}*/}
        {/*{terminalLogData.map((log, i) => (*/}
        {/*  <div key={i} className="flex mb-1 wrap-break-word allow-select-text cursor-text">*/}
        {/*    <span className="text-gray-500 mr-2">[{log.time}]</span>*/}
        {/*    <span className={getColor(log.level)}>{log.message}</span>*/}
        {/*  </div>*/}
        {/*))}*/}
      </div>
    </div>
  );
};

export default TermViewer;
