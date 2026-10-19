import React, {
  useMemo,
  useState,
  useCallback,
  useDeferredValue,
  startTransition,
  lazy,
  Suspense,
} from "react";
import { useAppTranslation as useTranslation } from "@/shared/useAppTranslation";
import { useApp } from "@/context/AppContext";
import { Card } from "@/components/ui/Card";
import { RefreshCw, Settings, ListTodo, SearchX, Network } from "lucide-react";
import { ProfileProps } from "@/types/app";
import { SearchInput } from "@/components/ui/SearchInput";
import { IconTooltip } from "@/components/ui/Tooltip";
import { FormSelect } from "@/components/ui/FormSelect";
import CButton from "@/components/ui/CButton.tsx";
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
import { TaskStatus } from "@/components/HomeTaskStatus";
import { sortSchedulerTasks } from "@/shared/SchedulerTaskOrder";
import "@/components/ui/control-switch.css";
import "./scheduler-task-list.css";

const SchedulerGraph = lazy(() => import("@/components/SchedulerGraph"));

const EMPTY_ARRAY: any[] = [];

// Memoized row to keep expensive controls from re-rendering unnecessarily.
const TaskRow = React.memo(function TaskRow({
  task,
  startsInactive,
  onToggle,
  onEdit,
  onChangeTime,
  t,
}: {
  task: EventConfig;
  startsInactive: boolean;
  onToggle: (task: EventConfig, enabled: boolean) => void;
  onEdit: (task: EventConfig) => void;
  onChangeTime: (task: EventConfig, ts: number) => void;
  t: (key: TranslationKey) => string;
}) {
  const name = t(eventNameKey(task.func_name));

  return (
    <li
      className="scheduler-task-row"
      data-task-id={task.func_name}
      data-enabled={task.enabled}
      data-starts-inactive={startsInactive || undefined}
    >
      <div className="scheduler-task-name">
        <EllipsisWithTooltip text={name} />
      </div>
      <div
        className="scheduler-task-time"
        role="group"
        aria-label={`${t("scheduler.nextTick")} · ${name}`}
      >
        <DateTimePicker
          value={task.next_tick * 1000}
          onChange={(ts) => {
            if (ts !== null) onChangeTime(task, ts);
          }}
        />
      </div>
      <div className="scheduler-task-actions">
        <IconTooltip content={t("common.edit")}>
          <button
            type="button"
            onClick={() => onEdit(task)}
            aria-label={`${t("common.edit")} ${name}`}
            className="scheduler-task-edit"
          >
            <Settings size={16} strokeWidth={1.7} />
          </button>
        </IconTooltip>
        <IconTooltip content={task.enabled ? t("workflow.enabled") : t("workflow.disabled")}>
          <button
            type="button"
            role="switch"
            aria-checked={task.enabled}
            aria-label={name}
            onClick={() => onToggle(task, !task.enabled)}
            className="scheduler-task-toggle"
          >
            <span className="control-switch" data-checked={task.enabled} aria-hidden="true">
              <span className="control-switch-thumb" />
            </span>
          </button>
        </IconTooltip>
      </div>
    </li>
  );
});

/** Renders the scheduler page component. */
const SchedulerPage: React.FC<ProfileProps> = ({ profileId }) => {
  const { t } = useTranslation();
  const { profiles, activeProfile } = useApp();

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
    const base = eventConfigs.filter((task) =>
      `${task.event_name} ${task.func_name} ${t(eventNameKey(task.func_name))}`
        .toLowerCase()
        .includes(deferredSearch.toLowerCase())
    );

    return sortSchedulerTasks(base, sortKey);
  }, [deferredSearch, eventConfigs, sortKey, t]);

  const totalEnabled = eventConfigs.filter((task) => task.enabled).length;

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

  const handleToggle = useCallback(
    (task: EventConfig, enabled: boolean) => {
      patchTask(task.func_name, { enabled });
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

  const toggleAll = (enabled: boolean) => {
    startTransition(() => {
      updateAll({ enabled });
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
    <div className="scheduler-page h-full flex flex-col gap-4 min-h-0 text-foreground">
      {/* Page heading with the active profile reference. */}
      <div className="flex items-center flex-wrap gap-2">
        {!__WITH_ANDROID__ && (
          <>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              {t("nav.scheduler")}
            </h2>
            <span className="ml-1 text-sm text-muted-foreground">{profile?.name}</span>
          </>
        )}
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
          <IconTooltip content={t("workflow.showGraph")}>
            <CButton
              variant="secondary"
              className="rounded-full w-9 h-9"
              aria-label={t("workflow.showGraph")}
              aria-haspopup="dialog"
              disabled={!pid}
              onClick={() => setGraphOpen(true)}
            >
              <Network size={18} />
            </CButton>
          </IconTooltip>
        </div>
      </div>

      <div className="scheduler-task-overview shrink-0 rounded-xl border border-border px-3 py-3 sm:px-4">
        <TaskStatus profileId={pid ?? ""} />
      </div>
      {/* Filtering toolbar for quick navigation and sorting. */}
      <div className="scheduler-task-toolbar flex items-center justify-between gap-3">
        <SearchInput
          placeholder={t("scheduler.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          containerClassName="min-w-0 flex-1"
        />
        <div className="rounded-lg">
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
        <IconTooltip content={t("scheduler.resetTimes")}>
          <CButton
            variant="secondary"
            onClick={refreshAll}
            className="w-8 h-8"
            aria-label={t("scheduler.resetTimes")}
          >
            <RefreshCw className="w-4 h-4" />
          </CButton>
        </IconTooltip>
      </div>
      {/* Keep the graph independent of the list presentation. */}
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
      <Card className="scheduler-task-panel flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="scheduler-task-list-header">
          <div
            className="scheduler-task-counts"
            aria-label={`${t("scheduler.activeTasks")} ${totalEnabled}; ${t("scheduler.inactiveTasks")} ${eventConfigs.length - totalEnabled}`}
          >
            <ListTodo size={16} strokeWidth={1.7} aria-hidden="true" />
            <span className="scheduler-enabled-count tabular-nums">
              {totalEnabled}/{eventConfigs.length}
            </span>
          </div>
          <div className="scheduler-task-bulk-actions">
            <button
              type="button"
              disabled={!pid || eventConfigs.length === 0}
              onClick={() => toggleAll(totalEnabled !== eventConfigs.length)}
            >
              {totalEnabled === eventConfigs.length
                ? t("scheduler.disableAll")
                : t("scheduler.enableAll")}
            </button>
          </div>
        </div>
        <div className="scheduler-task-scroll scroll-embedded">
          {filtered.length ? (
            <ul className="scheduler-task-rows" aria-label={t("nav.scheduler")}>
              {filtered.map((task, index) => (
                <TaskRow
                  key={task.func_name}
                  task={task}
                  startsInactive={!task.enabled && index > 0 && filtered[index - 1].enabled}
                  onToggle={handleToggle}
                  onEdit={handleEdit}
                  onChangeTime={handleChangeTime}
                  t={t}
                />
              ))}
            </ul>
          ) : (
            <div className="scheduler-task-empty" role="status">
              <SearchX size={22} strokeWidth={1.5} aria-hidden="true" />
              <span>{search.trim() ? t("scheduler.noResults") : t("workflow.empty")}</span>
            </div>
          )}
        </div>
      </Card>
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
