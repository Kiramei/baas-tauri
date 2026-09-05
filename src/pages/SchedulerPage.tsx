import React, {
  useMemo,
  useState,
  useCallback,
  useDeferredValue,
  startTransition,
  lazy,
  Suspense,
} from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/context/AppContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import {
  CheckCircle2,
  Hourglass,
  RefreshCw,
  ArrowRight,
  ArrowLeft,
  Settings,
  Search,
  Ban,
  ArrowUp,
  ArrowDown,
  Network,
} from "lucide-react";
import { ProfileProps } from "@/types/app";
import { FormInput } from "@/components/ui/FormInput";
import { FormSelect } from "@/components/ui/FormSelect";
import CButton from "@/components/ui/CButton.tsx";
import { Separator } from "@/components/ui/Separator";
import FeatureSwitchModal from "@/components/FeatureSwitchModal";
import { DateTimePicker } from "@/components/DateTimePicker.tsx";
import { EventConfig } from "@/types/event";
import { EllipsisWithTooltip } from "@/components/ui/ETooltip";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { eventNameKey } from "@/shared/I18nKeys";
import type { TranslationKey } from "@/types/i18n";
import { Modal } from "@/components/ui/Modal";
import { taskFieldPatch } from "@/features/schedulerGraph";
import { useUISetting, useSetUISettings } from "@/context/UISettingsProvider";
import { resolveHttpBase } from "@/store/WebsocketStore";
import FeaturePanelErrorBoundary from "@/components/FeaturePanelErrorBoundary";

const SchedulerGraph = lazy(() => import("@/components/SchedulerGraph"));

const EMPTY_ARRAY: any[] = [];

// Memoized row to keep expensive controls from re-rendering unnecessarily.
const TaskRow = React.memo(function TaskRow({
  task,
  side,
  onMove,
  onEdit,
  onChangeTime,
  t,
}: {
  task: EventConfig;
  side: "left" | "right";
  onMove: (task: EventConfig, toRight: boolean) => void;
  onEdit: (task: EventConfig) => void;
  onChangeTime: (task: EventConfig, ts: number) => void;
  t: (key: TranslationKey) => string;
}) {
  const MoveToEnabledIcon = __WITH_ANDROID__ ? ArrowDown : ArrowRight;
  const MoveToInactiveIcon = __WITH_ANDROID__ ? ArrowUp : ArrowLeft;

  return (
    <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-700 p-2 rounded-md gap-2 min-w-0 overflow-x-hidden">
      {side === "left" ? (
        <>
          <div className="flex grow min-w-0 overflow-hidden text-ellipsis text-left mr-2">
            <EllipsisWithTooltip text={t(eventNameKey(task.func_name))} />
          </div>
          <DateTimePicker
            value={task.next_tick * 1000}
            onChange={(ts) => onChangeTime(task, ts!)}
            className="hidden xl:flex"
          />
          <CButton onClick={() => onEdit(task)} className="rounded-[50%] w-8 h-8">
            <Settings className="w-4 h-4" />
          </CButton>
          <Separator orientation="vertical" className="h-8!" />
          <CButton onClick={() => onMove(task, true)} className="rounded-[50%] w-8 h-8">
            <MoveToEnabledIcon className="w-4 h-4" />
          </CButton>
        </>
      ) : (
        <>
          <CButton onClick={() => onMove(task, false)} className="rounded-[50%] w-8 h-8">
            <MoveToInactiveIcon className="w-4 h-4" />
          </CButton>
          <Separator orientation="vertical" className="h-8!" />
          <CButton onClick={() => onEdit(task)} className="rounded-[50%] w-8 h-8">
            <Settings className="w-4 h-4" />
          </CButton>
          <DateTimePicker
            value={task.next_tick * 1000}
            onChange={(ts) => onChangeTime(task, ts!)}
            className="hidden xl:flex"
          />
          <div className="flex grow min-w-0 overflow-hidden text-ellipsis text-right mr-2 justify-end">
            <EllipsisWithTooltip text={t(eventNameKey(task.func_name))} />
          </div>
        </>
      )}
    </div>
  );
});

/** Renders the scheduler page component. */
const SchedulerPage: React.FC<ProfileProps> = ({ profileId }) => {
  const { t } = useTranslation();
  const { profiles, activeProfile } = useApp();
  const MoveAllToEnabledIcon = __WITH_ANDROID__ ? ArrowDown : ArrowRight;
  const MoveAllToInactiveIcon = __WITH_ANDROID__ ? ArrowUp : ArrowLeft;

  const pid = profileId ?? activeProfile?.id;
  const profile = useMemo(
    () => profiles.find((p) => p.id === pid) ?? activeProfile ?? null,
    [profiles, pid, activeProfile]
  );

  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const sortKey = useUISetting((settings) => settings.schedulerSortMode ?? "default");
  const setUiSettings = useSetUISettings();
  const [graphOpen, setGraphOpen] = useState(false);
  const [modalTask, setModalTask] = useState<EventConfig | null>(null);

  const runningTask = useWebSocketStore((e) => e.statusStore[pid!]?.current_task);
  const taskQueue = useWebSocketStore((e) => e.statusStore[pid!]?.waiting_tasks);
  const newEventState = useWebSocketStore(
    (e) => e.configStore[pid!]?.new_event_enable_state ?? "default"
  );
  const eventConfigs: EventConfig[] = useWebSocketStore((e) => e.eventStore[pid!] ?? EMPTY_ARRAY);
  const modify = useWebSocketStore((e) => e.modify);

  const filtered = useMemo(() => {
    let base = eventConfigs.filter((task) =>
      `${task.event_name} ${task.func_name} ${t(eventNameKey(task.func_name))}`
        .toLowerCase()
        .includes(deferredSearch.toLowerCase())
    );

    if (sortKey === "default") {
      base = [...base].sort((a, b) => a.priority - b.priority);
    } else if (sortKey === "time") {
      base = [...base].sort((a, b) => a.next_tick - b.next_tick);
    }
    return base;
  }, [deferredSearch, eventConfigs, sortKey, t]);

  const { left, right } = useMemo(() => {
    const inactive: EventConfig[] = [];
    const enabled: EventConfig[] = [];
    filtered.forEach((task) => (task.enabled ? enabled : inactive).push(task));
    return { left: inactive, right: enabled };
  }, [filtered]);

  /** Handles the on update interaction. */
  const updateAll = useCallback(
    (fields: Partial<EventConfig>) => {
      if (!pid) return;
      const current = useWebSocketStore.getState().eventStore[pid] ?? [];
      const patch = Object.assign(
        {},
        ...current.map((task: EventConfig) => taskFieldPatch(current, task.func_name, fields))
      );
      if (Object.keys(patch).length) modify(`${pid}::event`, patch);
    },
    [pid, modify]
  );

  const patchTask = useCallback(
    (id: string, fields: Partial<EventConfig>) => {
      if (!pid) return;
      const current = useWebSocketStore.getState().eventStore[pid] ?? [];
      const patch = taskFieldPatch(current, id, fields);
      if (Object.keys(patch).length) modify(`${pid}::event`, patch);
    },
    [pid, modify]
  );

  /** Handles the handle move one interaction. */
  const handleMoveOne = useCallback(
    (task: EventConfig, toRight: boolean) => {
      patchTask(task.func_name, { enabled: toRight });
    },
    [patchTask]
  );

  /** Handles the handle change time interaction. */
  const handleChangeTime = useCallback(
    (task: EventConfig, ts: number) => {
      if (Number.isFinite(ts)) patchTask(task.func_name, { next_tick: Math.floor(ts / 1000) });
    },
    [patchTask]
  );

  /** Handles the handle edit interaction. */
  const handleEdit = useCallback((task: EventConfig) => {
    setModalTask(task);
  }, []);

  const moveAll = (toRight: boolean) => {
    startTransition(() => {
      updateAll({ enabled: toRight });
    });
  };

  const refreshAll = () => {
    const now = new Date().getTime();
    startTransition(() => {
      updateAll({ next_tick: Math.floor(now / 1000) });
    });
  };

  /** Handles the handle update task interaction. */
  const handleUpdateTask = (updated: EventConfig) => {
    startTransition(() => {
      const fields = Object.fromEntries(
        Object.entries(updated).filter(
          ([key, value]) =>
            JSON.stringify(modalTask?.[key as keyof EventConfig]) !== JSON.stringify(value)
        )
      );
      patchTask(updated.func_name, fields);
      setModalTask(null);
    });
  };

  return (
    <div className="h-full flex flex-col gap-4 min-h-0">
      {/* Page heading with the active profile reference. */}
      <div className="flex items-center flex-wrap gap-2">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100">
          {t("nav.scheduler")}
        </h2>
        <h2 className="text-2xl ml-3 text-slate-500 dark:text-slate-400">#{profile?.name}</h2>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <FormSelect
            value={newEventState}
            onChange={(value) => {
              if (pid) modify(`${pid}::config`, { new_event_enable_state: value });
            }}
            options={[
              { value: "on", label: t("workflow.newEvents", { state: t("workflow.enabled") }) },
              { value: "off", label: t("workflow.newEvents", { state: t("workflow.disabled") }) },
              {
                value: "default",
                label: t("workflow.newEvents", { state: t("workflow.defaultState") }),
              },
            ]}
          />
          <CButton
            className="rounded-full w-9 h-9"
            title={t("workflow.showGraph")}
            aria-label={t("workflow.showGraph")}
            aria-haspopup="dialog"
            disabled={!pid}
            onClick={() => setGraphOpen(true)}
          >
            <Network size={18} />
          </CButton>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <Hourglass className="w-5 h-5 mr-2 text-primary-500" />
              {t("task.overview")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <div className="border-dashed border-b-2 pb-1">
                {runningTask ? (
                  <div className="px-3 py-2 bg-primary-100 dark:bg-primary-800 rounded-md">
                    <span className="text-primary-700 dark:text-primary-300 font-semibold">
                      {t("task.running")}: {t(eventNameKey(runningTask))}
                    </span>
                  </div>
                ) : (
                  <p className="text-slate-500 dark:text-slate-400">{t("task.noneRunning")}</p>
                )}
              </div>
              {taskQueue && taskQueue.length > 0 ? (
                <ul className="space-y-0 h-35 overflow-auto pr-2 gap-2 flex flex-col">
                  {taskQueue.map((task, index) => (
                    <div
                      key={index}
                      className="px-3 py-2 bg-slate-100 dark:bg-slate-800 rounded-md"
                    >
                      <span className="text-slate-700 dark:text-slate-300">
                        {t(eventNameKey(task))}
                      </span>
                    </div>
                  ))}
                </ul>
              ) : (
                <p className="h-35 max-h-35 text-slate-500 dark:text-slate-400">
                  {t("task.noneQueued")}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      {/* Filtering toolbar for quick navigation and sorting. */}
      <div className="flex items-center justify-between gap-2">
        <Search size={20} />
        <div className="flex-1 bg-white dark:bg-slate-800 rounded-md shadow-sm">
          <FormInput
            placeholder={t("scheduler.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full"
          />
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-md shadow-sm">
          <FormSelect
            onChange={(value: string) =>
              setUiSettings((settings) => ({
                ...settings,
                schedulerSortMode: value as "default" | "time",
              }))
            }
            value={sortKey}
            options={[
              { label: t("scheduler.sortDefault"), value: "default" },
              { label: t("scheduler.sortByTime"), value: "time" },
            ]}
          />
        </div>
        <CButton variant="primary" onClick={refreshAll} className="mr-2 rounded-[50%] w-8 h-8">
          <RefreshCw className="w-4 h-4" />
        </CButton>
      </div>
      {/* Dual column layout showing inactive and active task queues. */}
      {graphOpen && pid && (
        <Modal
          isOpen={true}
          onClose={() => {
            if (!modalTask) setGraphOpen(false);
          }}
          title={`${t("workflow.showGraph")} · ${profile?.name ?? ""}`}
          fullscreen
        >
          <div className="h-full min-h-0" role="dialog" aria-label={t("workflow.showGraph")}>
            <FeaturePanelErrorBoundary
              key={pid}
              closeLabel={t("workflow.showList")}
              errorMessage={t("workflow.loadFailed")}
              onClose={() => setGraphOpen(false)}
            >
              <Suspense fallback={<div className="p-6">{t("workflow.loading")}</div>}>
                <SchedulerGraph
                  key={`${__WITH_TAURI__ ? "local" : resolveHttpBase()}:${pid}`}
                  profileId={pid}
                  backend={__WITH_TAURI__ ? "local" : resolveHttpBase()}
                  tasks={eventConfigs}
                  search=""
                  runningTask={runningTask}
                  queue={taskQueue ?? EMPTY_ARRAY}
                  frameless
                  onPatch={patchTask}
                  onRelations={(patch) => {
                    if (Object.keys(patch).length) modify(`${pid}::event`, patch);
                  }}
                  onEdit={handleEdit}
                />
              </Suspense>
            </FeaturePanelErrorBoundary>
          </div>
        </Modal>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 md:min-h-40">
        {/* Inactive task backlog awaiting activation. */}
        <Card className="flex flex-col min-h-0">
          <CardContent className="pr-1 sm:pr-4 flex flex-col flex-1 min-h-0">
            <div className="flex justify-between mb-2">
              <div className="flex items-center">
                <Ban className="w-5 h-5 mr-2 text-red-500" />
                <span className="font-medium">{t("scheduler.inactiveTasks")}</span>
              </div>
              <CButton
                variant="primary"
                onClick={() => moveAll(true)}
                className="rounded-[50%] w-8 h-8 mr-4.5"
              >
                <MoveAllToEnabledIcon className="w-4 h-4" />
              </CButton>
            </div>
            <div className="flex-1 min-h-0 overflow-auto space-y-2 scroll-embedded pr-1 max-md:max-h-40">
              {left.map((task) => (
                <TaskRow
                  key={task.func_name}
                  task={task}
                  side="left"
                  onMove={handleMoveOne}
                  onEdit={handleEdit}
                  onChangeTime={handleChangeTime}
                  t={t}
                />
              ))}
            </div>
          </CardContent>
        </Card>
        {/* Active task queue currently scheduled for execution. */}
        <Card className="flex flex-col min-h-0">
          <CardContent className="flex flex-col flex-1 min-h-0">
            <div className="flex justify-between mb-2">
              <CButton
                variant="primary"
                onClick={() => moveAll(false)}
                className="rounded-[50%] w-8 h-8 ml-2"
              >
                <MoveAllToInactiveIcon className="w-4 h-4" />
              </CButton>
              <div className="flex items-center">
                <span className="font-medium">{t("scheduler.activeTasks")}</span>
                <CheckCircle2 className="w-5 h-5 ml-2 text-green-500" />
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto space-y-2 scroll-embedded pr-1 max-md:max-h-40">
              {right.map((task) => (
                <TaskRow
                  key={task.func_name}
                  task={task}
                  side="right"
                  onMove={handleMoveOne}
                  onEdit={handleEdit}
                  onChangeTime={handleChangeTime}
                  t={t}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
      {/* Modal for editing the selected task configuration in depth. */}
      {modalTask && (
        <FeatureSwitchModal
          task={modalTask}
          onClose={() => setModalTask(null)}
          onSave={handleUpdateTask}
          allTasks={eventConfigs
            .filter((e) => e.func_name != modalTask.func_name)
            .map((e) => e.func_name)}
        />
      )}
    </div>
  );
};

export default SchedulerPage;
