import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/Button";
import { Copy, Terminal as TerminalIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/Tooltip";
import { toast } from "sonner";
import { useGlobalLogStore } from "@/store/GlobalLogStore";
import { FitAddon } from "@xterm/addon-fit";
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

interface TermStableRegionPayload {
  sessionId: string;
  taskId: string;
  regionId: string;
  title: string;
  lines: string[];
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
  durationMs?: number;
}

interface TermSessionFinishedPayload {
  sessionId: string;
  success: boolean;
}

interface WorkflowNodePayload {
  taskId: string;
  regionId: string;
  stepIndex: number;
  stepTotal: number;
  stage: number;
  lane: number;
  name: string;
  description: string;
  command: string;
}

interface WorkflowEdgePayload {
  from: string;
  to: string;
}

interface WorkflowPlannedPayload {
  sessionId: string;
  nodes: WorkflowNodePayload[];
  edges: WorkflowEdgePayload[];
}

interface TerminalSnapshotPayload {
  sessionId?: string;
  workflowPlan?: {
    nodes: WorkflowNodePayload[];
    edges: WorkflowEdgePayload[];
  };
}

interface TermClearedPayload {
  sessionId?: string;
}

interface TermTaskView {
  taskId: string;
  label: string;
  name: string;
  command: string;
  description: string;
  stage: number;
  lane: number;
  stepIndex: number;
  stepTotal: number;
  status: TermTaskStatus;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

interface TermViewerProps {
  onAbort: () => void | Promise<void>;
  onReady?: () => void | Promise<void>;
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
    }).catch(() => undefined);
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

const statusClass: Record<TermTaskStatus, string> = {
  idle: "border-slate-400 bg-slate-300 dark:border-slate-600 dark:bg-slate-700",
  pending: "border-slate-400 bg-slate-300 dark:border-slate-600 dark:bg-slate-700",
  running: "border-blue-300 bg-blue-500 shadow-blue-500/40",
  success: "border-green-300 bg-green-500 shadow-green-500/30",
  failed: "border-red-300 bg-red-500 shadow-red-500/30",
  stopped: "border-yellow-300 bg-yellow-500 shadow-yellow-500/30",
};

const statusEdgeClass: Record<TermTaskStatus, string> = {
  idle: "#94a3b8",
  pending: "#94a3b8",
  running: "#3b82f6",
  success: "#22c55e",
  failed: "#ef4444",
  stopped: "#eab308",
};

const statusLabel: Record<TermTaskStatus, string> = {
  idle: "Idle",
  pending: "Pending",
  running: "Running",
  success: "Success",
  failed: "Failed",
  stopped: "Stopped",
};

const statusPillClass: Record<TermTaskStatus, string> = {
  idle: "border-slate-600 bg-slate-800 text-slate-200",
  pending: "border-slate-600 bg-slate-800 text-slate-200",
  running: "border-blue-400/40 bg-blue-500/15 text-blue-200",
  success: "border-green-400/40 bg-green-500/15 text-green-200",
  failed: "border-red-400/40 bg-red-500/15 text-red-200",
  stopped: "border-yellow-400/40 bg-yellow-500/15 text-yellow-100",
};

const isTerminalTaskStatus = (status?: TermTaskStatus) =>
  status === "success" || status === "failed" || status === "stopped";

const formatDuration = (durationMs?: number) => {
  if (durationMs === undefined) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
};

const fallbackDuration = (task: TermTaskView) => {
  if (task.durationMs !== undefined) return task.durationMs;
  if (!task.startedAt || !task.finishedAt) return undefined;
  const started = Date.parse(task.startedAt);
  const finished = Date.parse(task.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started)
    return undefined;
  return finished - started;
};

const formatTime = (value?: string) => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toLocaleTimeString();
};

const stripAnsi = (value: string) =>
  value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g,
    ""
  );

const plannedTasksFromNodes = (nodes: WorkflowNodePayload[]) => {
  const planned: Record<string, TermTaskView> = {};
  for (const node of nodes) {
    planned[node.taskId] = {
      taskId: node.taskId,
      label: `[${String(node.stepIndex).padStart(2, "0")}/${String(node.stepTotal).padStart(2, "0")}] ${node.name}`,
      name: node.name,
      command: node.command,
      description: node.description,
      stage: node.stage,
      lane: node.lane,
      stepIndex: node.stepIndex,
      stepTotal: node.stepTotal,
      status: "pending",
    };
  }
  return planned;
};

const WorkflowNodeDot: React.FC<{ task: TermTaskView }> = ({ task }) => {
  const duration = task.status === "success" ? formatDuration(fallbackDuration(task)) : null;
  const startedAt = formatTime(task.startedAt);
  const finishedAt = formatTime(task.finishedAt);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="relative flex h-4.5 w-4.5 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          aria-label={`${task.name}: ${task.status}`}
        >
          <div
            className={`h-3.5 w-3.5 rounded-full border-2 shadow-sm transition ${statusClass[task.status]}`}
          />
          {duration && (
            <span className="pointer-events-none absolute left-0 translate-x-4 -top-2  whitespace-nowrap text-[9px] font-medium leading-none text-green-600 dark:text-green-300 text-shadow-sm text-shadow-accent-100">
              {duration}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className="w-72 rounded-lg border border-slate-700/80 bg-slate-950/95 p-0 text-left text-slate-100 shadow-xl shadow-black/35 backdrop-blur"
        arrowClassName="bg-slate-950 fill-slate-950 dark:bg-slate-950 dark:fill-slate-950"
      >
        <div className="border-b border-slate-800 px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold leading-5 text-white">{task.name}</div>
              <div className="mt-0.5 text-[11px] font-medium text-slate-400">
                Step {String(task.stepIndex).padStart(2, "0")}/
                {String(task.stepTotal).padStart(2, "0")}
              </div>
            </div>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-4 ${statusPillClass[task.status]}`}
            >
              {statusLabel[task.status]}
            </span>
          </div>
        </div>
        <div className="space-y-2 px-3 py-2">
          {(task.description || task.command) && (
            <p className="text-xs leading-5 text-slate-200">{task.description || task.command}</p>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] leading-4 text-slate-400">
            {duration && (
              <>
                <span>Duration</span>
                <span className="text-right font-medium text-green-200">{duration}</span>
              </>
            )}
            {startedAt && (
              <>
                <span>Started</span>
                <span className="text-right text-slate-200">{startedAt}</span>
              </>
            )}
            {finishedAt && (
              <>
                <span>Finished</span>
                <span className="text-right text-slate-200">{finishedAt}</span>
              </>
            )}
          </div>
          {task.command && (
            <div className="rounded-md border border-slate-800 bg-black/35 px-2 py-1.5 font-mono text-[11px] leading-4 text-slate-300 text-ellipsis overflow-hidden text-nowrap">
              {task.command}
            </div>
          )}
          {task.error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] leading-4 text-red-100">
              {task.error}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};

const WorkflowGraph: React.FC<{
  tasks: Record<string, TermTaskView>;
  edges: WorkflowEdgePayload[];
}> = ({ tasks, edges }) => {
  const graphRef = useRef<HTMLDivElement | null>(null);
  const [graphWidth, setGraphWidth] = useState(602);
  const taskList = useMemo(
    () =>
      Object.values(tasks).sort(
        (a, b) => a.stage - b.stage || a.lane - b.lane || a.stepIndex - b.stepIndex
      ),
    [tasks]
  );

  useEffect(() => {
    const node = graphRef.current;
    if (!node) return;
    const update = () => setGraphWidth(Math.max(240, node.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const byStage = new Map<number, TermTaskView[]>();
    for (const task of taskList) {
      const stageTasks = byStage.get(task.stage) ?? [];
      stageTasks.push(task);
      byStage.set(task.stage, stageTasks);
    }
    const nodeSize = 18;
    const maxStage = Math.max(...taskList.map((task) => task.stage), 0);
    const paddingX = 14;
    const graphHeight = 80;
    const graphCenterY = (graphHeight - nodeSize) / 2;
    const usableWidth = Math.max(nodeSize, graphWidth - paddingX * 2 - 28);
    const colGap = maxStage > 0 ? usableWidth / maxStage : 0;
    const positions = new Map<string, { x: number; y: number }>();
    for (const task of taskList) {
      const stageTasks = byStage.get(task.stage) ?? [task];
      const stageIndex = stageTasks.findIndex((candidate) => candidate.taskId === task.taskId);
      const rowGap = stageTasks.length > 1 ? Math.min(24, 48 / (stageTasks.length - 1)) : 0;
      const stageTop = graphCenterY - ((stageTasks.length - 1) * rowGap) / 2;
      positions.set(task.taskId, {
        x: paddingX + task.stage * colGap,
        y: Math.max(16, Math.min(56, stageTop + stageIndex * rowGap)),
      });
    }
    return {
      nodeSize,
      positions,
      width: graphWidth,
      height: graphHeight,
    };
  }, [graphWidth, taskList]);

  if (!taskList.length) return null;

  return (
    <div
      ref={graphRef}
      className="h-20 overflow-hidden border-b border-border bg-black/90 dark:bg-black/50"
    >
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg
          className="pointer-events-none absolute inset-0"
          width={layout.width}
          height={layout.height}
        >
          {edges.map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (!from || !to) return null;
            const target = tasks[edge.to];
            const color = target ? statusEdgeClass[target.status] : "#94a3b8";
            const x1 = from.x + layout.nodeSize;
            const y1 = from.y + layout.nodeSize / 2;
            const x2 = to.x;
            const y2 = to.y + layout.nodeSize / 2;
            const mid = x1 + Math.max(8, (x2 - x1) / 2);
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                stroke={color}
                strokeWidth="2"
                fill="none"
                opacity={target?.status === "pending" ? 0.55 : 0.9}
              />
            );
          })}
        </svg>
        {taskList.map((task) => {
          const position = layout.positions.get(task.taskId);
          if (!position) return null;
          return (
            <div
              key={task.taskId}
              className="absolute"
              style={{ left: position.x, top: position.y }}
            >
              <WorkflowNodeDot task={task} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

const TermViewer: React.FC<TermViewerProps> = ({
  onAbort,
  onReady,
  onFailure,
  onSessionFinished,
}) => {
  const terminalLogData = useGlobalLogStore((e) => e.terminalLogData);
  const appendTerminalLog = useGlobalLogStore((e) => e.appendTerminalLog);
  const appendTerminalLogs = useGlobalLogStore((e) => e.appendTerminalLogs);

  const terminalRef = useRef<TerminalHandle | null>(null);
  const readySentRef = useRef(false);
  const onReadyRef = useRef(onReady);
  const onFailureRef = useRef(onFailure);
  const onSessionFinishedRef = useRef(onSessionFinished);
  const appendTerminalLogRef = useRef(appendTerminalLog);
  const appendTerminalLogsRef = useRef(appendTerminalLogs);
  const concreteFailureRef = useRef(false);
  const [tasks, setTasks] = useState<Record<string, TermTaskView>>({});
  const [edges, setEdges] = useState<WorkflowEdgePayload[]>([]);

  useEffect(() => {
    onReadyRef.current = onReady;
    onFailureRef.current = onFailure;
    onSessionFinishedRef.current = onSessionFinished;
    appendTerminalLogRef.current = appendTerminalLog;
    appendTerminalLogsRef.current = appendTerminalLogs;
  }, [appendTerminalLog, appendTerminalLogs, onFailure, onReady, onSessionFinished]);

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
    let chunkBuffer = "";
    let chunkFrame: number | null = null;
    const capturedStableRegions = new Set<string>();

    const flushChunks = () => {
      chunkFrame = null;
      if (!chunkBuffer) return;
      const chunk = chunkBuffer;
      chunkBuffer = "";
      terminalRef.current?.write(chunk);
    };

    const writeChunk = (chunk: string) => {
      chunkBuffer += chunk;
      if (chunkFrame === null) {
        chunkFrame = requestAnimationFrame(flushChunks);
      }
    };

    const appendStatusLog = (level: string, message: string) => {
      appendTerminalLogRef.current({
        message,
        level,
        time: new Date().toLocaleTimeString(),
      });
    };

    const appendStableRegionLog = (payload: TermStableRegionPayload) => {
      if (capturedStableRegions.has(payload.regionId)) return;
      capturedStableRegions.add(payload.regionId);

      const title = stripAnsi(payload.title).trim();
      const lines = payload.lines
        .map((line) => stripAnsi(line).trimEnd())
        .filter((line) => line.trim().length > 0);
      const messages = title ? [title, ...lines] : lines;
      if (messages.length === 0) return;

      const time = new Date().toLocaleTimeString();
      appendTerminalLogsRef.current(
        messages.map((message) => ({
          message,
          level: "terminal",
          time,
        }))
      );
    };

    async function bindEvents() {
      const listeners = await Promise.all([
        listen<WorkflowPlannedPayload>("term:workflow-planned", (event) => {
          if (disposed) return;
          setTasks(plannedTasksFromNodes(event.payload.nodes));
          setEdges(event.payload.edges);
        }),
        listen<TermChunkPayload>("term:chunk", (event) => {
          if (disposed) return;
          writeChunk(event.payload.chunk);
        }),
        listen<TermStableRegionPayload>("term:region-stable", (event) => {
          if (disposed) return;
          appendStableRegionLog(event.payload);
        }),
        listen<TermTaskStartedPayload>("term:task-started", (event) => {
          if (disposed) return;
          const payload = event.payload;
          const label = `[${String(payload.stepIndex).padStart(2, "0")}/${String(payload.stepTotal).padStart(2, "0")}] ${payload.name}`;
          setTasks((current) => ({
            ...current,
            [payload.taskId]: {
              ...current[payload.taskId],
              taskId: payload.taskId,
              label,
              name: payload.name,
              command: payload.command,
              description: current[payload.taskId]?.description ?? payload.command,
              stage: current[payload.taskId]?.stage ?? payload.stepIndex - 1,
              lane: current[payload.taskId]?.lane ?? 0,
              stepIndex: payload.stepIndex,
              stepTotal: payload.stepTotal,
              status: isTerminalTaskStatus(current[payload.taskId]?.status)
                ? current[payload.taskId].status
                : payload.status,
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
              description: "",
              stage: 0,
              lane: 0,
              stepIndex: 0,
              stepTotal: 0,
              status: "pending" as TermTaskStatus,
            };
            return {
              ...current,
              [payload.taskId]: {
                ...previous,
                status:
                  isTerminalTaskStatus(previous.status) && payload.status === "running"
                    ? previous.status
                    : payload.status,
                error: payload.error ?? previous.error,
                startedAt: payload.startedAt ?? previous.startedAt,
                finishedAt: payload.finishedAt ?? previous.finishedAt,
                durationMs: payload.durationMs ?? previous.durationMs,
              },
            };
          });
          if (payload.status === "failed" || payload.status === "stopped") {
            const message = payload.error || `${payload.taskId} ${payload.status}`;
            appendStatusLog(payload.status === "failed" ? "error" : "warning", message);
            concreteFailureRef.current = true;
            onFailureRef.current?.({ step: payload.taskId, message });
          }
        }),
        listen<TermSessionFinishedPayload>("term:session-finished", (event) => {
          if (disposed) return;
          flushChunks();
          terminalRef.current?.setRunning(false);
          onSessionFinishedRef.current?.(event.payload.success);
          if (!event.payload.success && !concreteFailureRef.current) {
            onFailureRef.current?.({
              step: "workflow",
              message: "Updater workflow did not complete successfully.",
            });
          }
        }),
        listen<TermClearedPayload>("term:dashboard-cleared", () => {
          if (disposed) return;
          terminalRef.current?.setRunning(true);
          terminalRef.current?.reset();
          concreteFailureRef.current = false;
          capturedStableRegions.clear();
          setTasks({});
          setEdges([]);
        }),
      ]);

      if (disposed) {
        for (const unlisten of listeners) {
          unlisten();
        }
        return;
      }
      unlisteners.push(...listeners);
      try {
        const snapshot = await invoke<TerminalSnapshotPayload>("updater_terminal_snapshot");
        if (!disposed && snapshot.workflowPlan) {
          setTasks((current) => {
            const planned = plannedTasksFromNodes(snapshot.workflowPlan!.nodes);
            for (const [taskId, task] of Object.entries(current)) {
              planned[taskId] = { ...planned[taskId], ...task };
            }
            return planned;
          });
          setEdges(snapshot.workflowPlan.edges);
        }
      } catch {
        // Snapshot is best-effort; live events still drive normal runs.
      }
      if (!readySentRef.current) {
        readySentRef.current = true;
        void onReadyRef.current?.();
      }
    }

    void bindEvents();

    return () => {
      disposed = true;
      if (chunkFrame !== null) {
        cancelAnimationFrame(chunkFrame);
        chunkFrame = null;
      }
      chunkBuffer = "";
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);

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

      <WorkflowGraph tasks={tasks} edges={edges} />

      <div className="flex-1 overflow-auto p-2 font-mono text-xs bg-black/90 dark:bg-black/50 text-gray-300">
        <TermEmulator ref={terminalRef} />
      </div>
    </div>
  );
};

export default TermViewer;
