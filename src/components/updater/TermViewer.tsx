import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
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

type TermTaskStatus = "idle" | "pending" | "running" | "success" | "failed" | "stopped";

interface TermChunkPayload {
  sessionId: string;
  chunk: string;
}

interface TermTaskStartedPayload {
  sessionId: string;
  taskId: string;
  regionId: string;
  stepIndex: number;
  stepTotal: number;
  name: string;
  command: string;
  status: "running";
}

interface TermTaskStatusPayload {
  sessionId: string;
  taskId: string;
  regionId: string;
  status: Exclude<TermTaskStatus, "idle">;
  exitCode?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface TermSessionFinishedPayload {
  sessionId: string;
  success: boolean;
}

interface TermClearedPayload {
  sessionId?: string;
}

interface TermTaskView {
  taskId: string;
  label: string;
  name: string;
  command: string;
  status: TermTaskStatus;
  error?: string;
}

interface TermViewerProps {
  onAbort: () => void | Promise<void>;
  onFailure?: (failure: { step: string; message: string }) => void;
  onSessionFinished?: (success: boolean) => void;
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
    void invoke("updater_resize_term", {
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

const TermViewer: React.FC<TermViewerProps> = ({ onAbort, onFailure, onSessionFinished }) => {
  const terminalLogData = useGlobalLogStore((e) => e.terminalLogData);
  const appendTerminalLog = useGlobalLogStore((e) => e.appendTerminalLog);

  const terminalRef = useRef<TerminalHandle | null>(null);
  const [tasks, setTasks] = useState<Record<string, TermTaskView>>({});
  const [sessionStatus, setSessionStatus] = useState<TermTaskStatus>("running");

  const copyLogs = () => {
    const text = terminalLogData
      .map((l) => `[${l.time}] [${l.level.toUpperCase()}] ${l.message}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(undefined);
    toast.success("Logs copied to clipboard");
  };

  const appendStatusLog = useCallback(
    (level: string, message: string) => {
      appendTerminalLog({
        message,
        level,
        time: new Date().toLocaleTimeString(),
      });
    },
    [appendTerminalLog]
  );

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    async function bindEvents() {
      const listeners = await Promise.all([
        listen<TermChunkPayload>("term:chunk", (event) => {
          if (disposed) return;
          terminalRef.current?.write(event.payload.chunk);
        }),
        listen<TermTaskStartedPayload>("term:task-started", (event) => {
          if (disposed) return;
          const payload = event.payload;
          const label = `[${String(payload.stepIndex).padStart(2, "0")}/${String(payload.stepTotal).padStart(2, "0")}] ${payload.name}`;
          setTasks((current) => ({
            ...current,
            [payload.taskId]: {
              taskId: payload.taskId,
              label,
              name: payload.name,
              command: payload.command,
              status: payload.status,
            },
          }));
          appendStatusLog("info", `${label} started`);
        }),
        listen<TermTaskStatusPayload>("term:task-status", (event) => {
          if (disposed) return;
          const payload = event.payload;
          setTasks((current) => {
            const previous = current[payload.taskId] ?? {
              taskId: payload.taskId,
              label: payload.taskId,
              name: payload.taskId,
              command: "",
              status: "pending" as TermTaskStatus,
            };
            return {
              ...current,
              [payload.taskId]: {
                ...previous,
                status: payload.status,
                error: payload.error ?? previous.error,
              },
            };
          });
          if (payload.status === "failed" || payload.status === "stopped") {
            const message = payload.error || `${payload.taskId} ${payload.status}`;
            appendStatusLog(payload.status === "failed" ? "error" : "warning", message);
            onFailure?.({ step: payload.taskId, message });
          }
        }),
        listen<TermSessionFinishedPayload>("term:session-finished", (event) => {
          if (disposed) return;
          terminalRef.current?.setRunning(false);
          setSessionStatus(event.payload.success ? "success" : "failed");
          onSessionFinished?.(event.payload.success);
          if (!event.payload.success) {
            onFailure?.({
              step: "workflow",
              message: "Updater workflow did not complete successfully.",
            });
          }
        }),
        listen<TermClearedPayload>("term:dashboard-cleared", () => {
          if (disposed) return;
          terminalRef.current?.setRunning(true);
          terminalRef.current?.reset();
          setTasks({});
          setSessionStatus("running");
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
  }, [appendStatusLog, onFailure, onSessionFinished]);

  return (
    <div className="rounded-lg border border-border bg-transparent text-card-foreground shadow-sm overflow-hidden flex flex-col h-100">
      <div className="flex items-center justify-between px-3 py-0 border-b border-border bg-muted/50">
        <div className="flex items-center gap-2">
          <button
            className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 focus:outline-none transition duration-150 ease-in-out"
            title="Abort"
            onClick={() => void onAbort()}
          />
          <button className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 focus:outline-none transition duration-150 ease-in-out" />
          <button className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 focus:outline-none transition duration-150 ease-in-out" />
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
      </div>

      <div className="border-t border-border bg-muted/30 px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">Session: {sessionStatus}</span>
          <span className="text-muted-foreground">{Object.keys(tasks).length} tasks</span>
        </div>
        {Object.values(tasks).length > 0 && (
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-1 max-h-20 overflow-auto">
            {Object.values(tasks).map((task) => (
              <div key={task.taskId} className="flex justify-between gap-2">
                <span className="truncate">{task.label}</span>
                <span
                  className={
                    task.status === "failed"
                      ? "text-red-500"
                      : task.status === "success"
                        ? "text-green-500"
                        : task.status === "stopped"
                          ? "text-yellow-500"
                          : "text-muted-foreground"
                  }
                >
                  {task.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TermViewer;
