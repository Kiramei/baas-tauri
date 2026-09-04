import { memo, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  Panel,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useTranslation } from "react-i18next";
import {
  GitBranch,
  GripHorizontal,
  Settings2,
  LayoutGrid,
  Unplug,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import type { EventConfig } from "@/types/event";
import { useUISetting } from "@/context/UISettingsProvider";
import StorageUtil from "@/shared/StorageManager";
import { eventNameKey } from "@/shared/I18nKeys";
import {
  arrangeTasks,
  connectionError,
  graphStorageKey,
  relationPatch,
  relationsFor,
  validPositions,
  type Positions,
} from "@/features/schedulerGraph";
import { DateTimePicker } from "@/components/DateTimePicker";
import "@xyflow/react/dist/style.css";
import "./SchedulerGraph.css";

type TaskNode = Node<
  {
    task: EventConfig;
    running: boolean;
    queued: boolean;
    dimmed: boolean;
    onEdit: (task: EventConfig) => void;
    onPatch: (id: string, fields: Partial<EventConfig>) => void;
  },
  "task"
>;

const WorkflowNode = memo(function WorkflowNode({ data, selected }: NodeProps<TaskNode>) {
  const { t } = useTranslation();
  const { task } = data;
  return (
    <section
      className={`workflow-node ${selected ? "is-selected" : ""} ${data.running ? "is-running" : ""} ${data.dimmed ? "is-dimmed" : ""}`}
    >
      <div className="workflow-node-header">
        <span className="workflow-node-icon">
          <GitBranch size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 title={t(eventNameKey(task.func_name))}>{t(eventNameKey(task.func_name))}</h3>
          <span className="workflow-node-id">{task.func_name}</span>
        </div>
        <GripHorizontal size={16} className="text-slate-400" />
      </div>
      <div className="workflow-node-body nodrag">
        <div className="flex items-center justify-between gap-2">
          <span
            className={`workflow-status ${data.running ? "running" : task.enabled ? "enabled" : "disabled"}`}
          >
            <i />
            {data.running
              ? t("task.running")
              : data.queued
                ? t("workflow.queued")
                : task.enabled
                  ? t("workflow.enabled")
                  : t("workflow.disabled")}
          </span>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <span>{t("workflow.enabled")}</span>
            <input
              type="checkbox"
              checked={task.enabled}
              onChange={(e) => data.onPatch(task.func_name, { enabled: e.target.checked })}
              aria-label={`${t("workflow.enabled")} ${t(eventNameKey(task.func_name))}`}
            />
          </label>
        </div>
        <div className="mt-3 mb-1 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {t("scheduler.nextTick")}
        </div>
        <DateTimePicker
          value={task.next_tick * 1000}
          onChange={(ts) => {
            if (ts !== null && Number.isFinite(ts))
              data.onPatch(task.func_name, { next_tick: Math.floor(ts / 1000) });
          }}
          className="workflow-time w-full flex"
        />
        <button className="workflow-edit" onClick={() => data.onEdit(task)}>
          <Settings2 size={12} />
          {t("scheduler.detailConfig")}
        </button>
      </div>
      <div className="workflow-ports">
        <div className="workflow-port-row pre">
          <Handle type="target" position={Position.Left} id="pre" title={t("scheduler.preTask")} />
          <span>{t("scheduler.preTask")}</span>
          <span>{t("workflow.asPre")}</span>
          <Handle type="source" position={Position.Right} id="pre" title={t("workflow.asPre")} />
        </div>
        <div className="workflow-port-row post">
          <Handle type="target" position={Position.Left} id="post" title={t("workflow.asPost")} />
          <span>{t("workflow.asPost")}</span>
          <span>{t("scheduler.postTask")}</span>
          <Handle
            type="source"
            position={Position.Right}
            id="post"
            title={t("scheduler.postTask")}
          />
        </div>
      </div>
    </section>
  );
});
const nodeTypes = { task: WorkflowNode };

export default function SchedulerGraph({
  tasks,
  profileId,
  backend,
  search,
  runningTask,
  queue,
  onPatch,
  onRelations,
  onEdit,
}: {
  tasks: EventConfig[];
  profileId: string;
  backend: string;
  search: string;
  runningTask?: string | null;
  queue: string[];
  onPatch: (id: string, fields: Partial<EventConfig>) => void;
  onRelations: (patch: Record<string, unknown>) => void;
  onEdit: (task: EventConfig) => void;
}) {
  const { t } = useTranslation();
  const theme = useUISetting((settings) => settings.theme);
  const storageKey = graphStorageKey(backend, profileId);
  const [positions, setPositions] = useState<Positions>(() => ({
    ...arrangeTasks(tasks),
    ...validPositions(StorageUtil.get(storageKey)),
  }));
  const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>(
    {}
  );
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<TaskNode> | null>(null);
  const defaults = useMemo(() => arrangeTasks(tasks), [tasks]);
  const graph = useMemo(() => relationsFor(tasks), [tasks]);
  const nodes: TaskNode[] = tasks.map((task) => ({
    id: task.func_name,
    type: "task",
    position: positions[task.func_name] ?? defaults[task.func_name],
    measured: dimensions[task.func_name],
    selected: selectedNode === task.func_name,
    deletable: false,
    data: {
      task,
      running: task.func_name === runningTask,
      queued: queue.includes(task.func_name),
      dimmed:
        Boolean(search) &&
        !`${task.event_name} ${task.func_name} ${t(eventNameKey(task.func_name))}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      onPatch,
      onEdit,
    },
  }));
  const edges = graph.relations.map((relation) => ({
    id: relation.id,
    source: relation.source,
    target: relation.target,
    sourceHandle: relation.kind,
    targetHandle: relation.kind,
    type: "smoothstep",
    selected: selectedEdge === relation.id,
    style: {
      stroke: relation.kind === "pre" ? "#0891b2" : "#8b5cf6",
      strokeWidth: selectedEdge === relation.id ? 3.5 : 2,
      strokeDasharray: relation.kind === "post" ? "7 5" : undefined,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: relation.kind === "pre" ? "#0891b2" : "#8b5cf6",
    },
    label:
      selectedEdge === relation.id
        ? relation.kind === "pre"
          ? t("scheduler.preTask")
          : t("scheduler.postTask")
        : undefined,
  }));
  const disconnect = () => {
    const relation = graph.relations.find((edge) => edge.id === selectedEdge);
    if (relation) onRelations(relationPatch(tasks, relation, true));
    setSelectedEdge(null);
  };
  const persist = (next: Positions) => {
    setPositions(next);
    StorageUtil.set(storageKey, next);
  };
  return (
    <div className="workflow-shell" data-testid="scheduler-workflow">
      <div className="workflow-toolbar">
        <div className="flex items-center gap-3">
          <span className="workflow-brand">
            <GitBranch size={17} />
          </span>
          <div>
            <h3>{t("workflow.title")}</h3>
            <p>{t("workflow.summary", { tasks: tasks.length, relations: edges.length })}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedEdge && (
            <button className="workflow-tool" onClick={disconnect}>
              <Unplug size={14} />
              {t("workflow.disconnect")}
            </button>
          )}
          <button
            className="workflow-tool"
            onClick={() => {
              persist(arrangeTasks(tasks));
              requestAnimationFrame(() => flow?.fitView({ padding: 0.15, duration: 0 }));
            }}
          >
            <LayoutGrid size={14} />
            {t("workflow.arrange")}
          </button>
        </div>
      </div>
      {(graph.cyclic || graph.unknown.length > 0) && (
        <div className="workflow-warning" role="status">
          <AlertTriangle size={15} />
          <span>
            {graph.cyclic && t("workflow.existingCycle")}{" "}
            {graph.unknown.length > 0 &&
              t("workflow.unknownRefs", { refs: graph.unknown.join(", ") })}
          </span>
        </div>
      )}
      <div className="workflow-canvas">
        <ReactFlow<TaskNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={setFlow}
          colorMode={theme === "dark" ? "dark" : theme === "light" ? "light" : "system"}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
          minZoom={0.15}
          maxZoom={1.5}
          deleteKeyCode={null}
          nodesConnectable
          nodesDraggable
          snapToGrid
          snapGrid={[10, 10]}
          onNodesChange={(changes) => {
            for (const change of changes)
              if (change.type === "select" && change.selected) setSelectedNode(change.id);
            if (changes.some((change) => change.type === "position"))
              setPositions((previous) => {
                const next = { ...previous };
                for (const change of changes)
                  if (change.type === "position" && change.position)
                    next[change.id] = change.position;
                return next;
              });
            if (changes.some((change) => change.type === "dimensions"))
              setDimensions((previous) => {
                const next = { ...previous };
                for (const change of changes)
                  if (change.type === "dimensions" && change.dimensions)
                    next[change.id] = change.dimensions;
                return next;
              });
          }}
          onEdgesChange={(changes) => {
            for (const change of changes)
              if (change.type === "select") setSelectedEdge(change.selected ? change.id : null);
          }}
          ariaLabelConfig={{
            "controls.zoomIn.ariaLabel": t("workflow.zoomIn"),
            "controls.zoomOut.ariaLabel": t("workflow.zoomOut"),
            "controls.fitView.ariaLabel": t("workflow.fitView"),
          }}
          onNodeDragStop={(_, node) => persist({ ...positions, [node.id]: node.position })}
          onNodeClick={(_, node) => {
            setSelectedNode(node.id);
            setSelectedEdge(null);
          }}
          onEdgeClick={(_, edge) => {
            setSelectedEdge(edge.id);
            setSelectedNode(null);
          }}
          onPaneClick={() => {
            setSelectedEdge(null);
            setSelectedNode(null);
          }}
          onConnect={(connection) => {
            const error = connectionError(
              tasks,
              connection.source,
              connection.target,
              connection.sourceHandle,
              connection.targetHandle
            );
            if (error) {
              toast.error(
                {
                  selfLink: t("workflow.errors.selfLink"),
                  duplicate: t("workflow.errors.duplicate"),
                  cycle: t("workflow.errors.cycle"),
                  unknown: t("workflow.errors.unknown"),
                  portMismatch: t("workflow.errors.portMismatch"),
                }[error]
              );
              return;
            }
            const kind = connection.sourceHandle as "pre" | "post";
            onRelations(
              relationPatch(tasks, {
                kind,
                owner: kind === "pre" ? connection.target : connection.source,
                related: kind === "pre" ? connection.source : connection.target,
              })
            );
          }}
        >
          <Background gap={22} size={1} color="#94a3b833" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => ((node.data.task as EventConfig).enabled ? "#0891b2" : "#94a3b8")}
            maskColor="rgba(148,163,184,0.12)"
          />
          <Panel position="top-left">
            <div className="workflow-legend">
              <span>
                <i className="pre" />
                {t("scheduler.preTask")}
              </span>
              <span>
                <i className="post" />
                {t("scheduler.postTask")}
              </span>
            </div>
          </Panel>
          {!tasks.length && (
            <Panel position="top-center">
              <p className="workflow-empty">{t("workflow.empty")}</p>
            </Panel>
          )}
        </ReactFlow>
      </div>
      <div className="workflow-footer">
        <span>{t("workflow.hint")}</span>
        <span>{t("workflow.layoutSaved")}</span>
      </div>
    </div>
  );
}
