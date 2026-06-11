import React, {
  forwardRef,
  memo,
  useCallback,
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
import { useGlobalLogStore } from "@/store/GlobalLogStore.ts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactFlow, {
  Background,
  Handle,
  MarkerType,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";

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

const isTerminalTaskStatus = (status?: TermTaskStatus) =>
  status === "success" || status === "failed" || status === "stopped";

interface WorkflowNodeData {
  task: TermTaskView;
}

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

/* eslint-disable react/prop-types */
const WorkflowTaskNode = memo<NodeProps<WorkflowNodeData>>(({ data }) => {
  const task = data.task;
  const duration = task.status === "success" ? formatDuration(fallbackDuration(task)) : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="nodrag nopan relative flex h-6 w-6 items-center justify-center">
          <Handle
            type="target"
            position={Position.Left}
            className="h-px! w-px! border-0! bg-transparent! opacity-0!"
            style={{ pointerEvents: "none" }}
            isConnectable={false}
          />
          <div
            className={`h-5 w-5 rounded-full border-2 shadow-sm transition ${statusClass[task.status]}`}
            aria-label={`${task.name}: ${task.status}`}
          />
          {duration && (
            <span className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-medium text-green-600 dark:text-green-300">
              {duration}
            </span>
          )}
          <Handle
            type="source"
            position={Position.Right}
            className="h-px! w-px! border-0! bg-transparent! opacity-0!"
            style={{ pointerEvents: "none" }}
            isConnectable={false}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 space-y-1 text-left">
        <div className="font-semibold">{task.name}</div>
        <div>{task.description || task.command}</div>
        <div>Status: {task.status}</div>
        <div>
          Step: {String(task.stepIndex).padStart(2, "0")}/{String(task.stepTotal).padStart(2, "0")}
        </div>
        {duration && <div>Duration: {duration}</div>}
        {task.command && <div className="break-all opacity-80">{task.command}</div>}
        {task.startedAt && (
          <div className="opacity-80">Started: {new Date(task.startedAt).toLocaleTimeString()}</div>
        )}
        {task.finishedAt && (
          <div className="opacity-80">
            Finished: {new Date(task.finishedAt).toLocaleTimeString()}
          </div>
        )}
        {task.error && <div className="text-red-200">{task.error}</div>}
      </TooltipContent>
    </Tooltip>
  );
});
/* eslint-enable react/prop-types */

WorkflowTaskNode.displayName = "WorkflowTaskNode";

const nodeTypes = { task: WorkflowTaskNode };

const WorkflowGraph: React.FC<{
  tasks: Record<string, TermTaskView>;
  edges: WorkflowEdgePayload[];
}> = ({ tasks, edges }) => {
  const taskList = useMemo(
    () =>
      Object.values(tasks).sort(
        (a, b) => a.stage - b.stage || a.lane - b.lane || a.stepIndex - b.stepIndex
      ),
    [tasks]
  );

  const flowNodes = useMemo<Node<WorkflowNodeData>[]>(() => {
    const byStage = new Map<number, TermTaskView[]>();
    for (const task of taskList) {
      const stageTasks = byStage.get(task.stage) ?? [];
      stageTasks.push(task);
      byStage.set(task.stage, stageTasks);
    }
    return taskList.map((task) => {
      const stageTasks = byStage.get(task.stage) ?? [task];
      const stageIndex = stageTasks.findIndex((candidate) => candidate.taskId === task.taskId);
      const centeredY = (stageIndex - (stageTasks.length - 1) / 2) * 58;
      return {
        id: task.taskId,
        type: "task",
        position: {
          x: task.stage * 96,
          y: centeredY,
        },
        data: { task },
        draggable: false,
        selectable: false,
      };
    });
  }, [taskList]);

  const flowEdges = useMemo<Edge[]>(() => {
    return edges.map((edge) => {
      const target = tasks[edge.to];
      const color = target ? statusEdgeClass[target.status] : "#94a3b8";
      return {
        id: `${edge.from}-${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
        animated: target?.status === "running",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color,
        },
        style: {
          stroke: color,
          strokeWidth: 2,
        },
      };
    });
  }, [edges, tasks]);

  if (!taskList.length) return null;

  return (
    <div className="h-20 border-b border-border bg-muted/20">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        minZoom={0.35}
        maxZoom={1.4}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
      </ReactFlow>
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

  const terminalRef = useRef<TerminalHandle | null>(null);
  const readySentRef = useRef(false);
  const [tasks, setTasks] = useState<Record<string, TermTaskView>>({});
  const [edges, setEdges] = useState<WorkflowEdgePayload[]>([]);
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
        listen<WorkflowPlannedPayload>("term:workflow-planned", (event) => {
          if (disposed) return;
          setTasks(plannedTasksFromNodes(event.payload.nodes));
          setEdges(event.payload.edges);
        }),
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
          setEdges([]);
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
        void onReady?.();
      }
    }

    void bindEvents();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [appendStatusLog, onFailure, onReady, onSessionFinished]);

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

      <div className="border-t border-border bg-muted/30 px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">Session: {sessionStatus}</span>
          <span className="text-muted-foreground">{Object.keys(tasks).length} tasks</span>
        </div>
      </div>
    </div>
  );
};

export default TermViewer;
