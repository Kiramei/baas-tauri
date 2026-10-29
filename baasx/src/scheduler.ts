export type ClockTime = [number, number, number];
export type DisabledRange = [ClockTime, ClockTime];
export interface SchedulerTask extends Record<string, unknown> {
  func_name: string;
  event_name: string;
  enabled: boolean;
  priority: number;
  interval: number;
  next_tick: number;
  daily_reset: ClockTime[];
  disabled_time_range: DisabledRange[];
  pre_task: string[];
  post_task: string[];
}
export type NewEventState = "on" | "off" | "default";
export interface SchedulerState {
  profile: string;
  tasks: SchedulerTask[];
  newEventState: NewEventState;
}
export const SCHEDULER_FIELDS = [
  { key: "enabled", label: "启用", type: "boolean", hint: "true / false" },
  {
    key: "next_tick",
    label: "下次执行时间",
    type: "datetime",
    hint: "本地日期时间、ISO 日期、Unix 秒，或 now",
  },
  { key: "priority", label: "优先级", type: "number", hint: "整数；数值越小越优先" },
  {
    key: "interval",
    label: "执行间隔",
    type: "number",
    hint: "非负整数，单位：秒；0 使用每日重置时间",
  },
  { key: "daily_reset", label: "每日重置", type: "times", hint: "05:00:00, 17:00:00；留空为 []" },
  {
    key: "disabled_time_range",
    label: "禁用时段",
    type: "ranges",
    hint: "12:00-13:00, 23:00-23:59:59；跨午夜请拆分",
  },
  {
    key: "pre_task",
    label: "前置任务",
    type: "tasks",
    hint: "按执行顺序输入任务 ID，以逗号分隔；留空清除",
  },
  {
    key: "post_task",
    label: "后置任务",
    type: "tasks",
    hint: "按执行顺序输入任务 ID，以逗号分隔；留空清除",
  },
] as const;
export type SchedulerField = (typeof SCHEDULER_FIELDS)[number]["key"];
export type SchedulerChanges = Partial<Pick<SchedulerTask, SchedulerField>>;
const fields = new Set<string>(SCHEDULER_FIELDS.map((field) => field.key));
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const integer = (value: unknown, minimum: number, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${label}需要${minimum === 0 ? "非负" : "有效"}整数`);
  return value;
};
function clock(value: unknown): ClockTime {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(
      (part, index) =>
        typeof part !== "number" || !Number.isInteger(part) || part < 0 || part > (index ? 59 : 23)
    )
  )
    throw new Error("时间需要 [时,分,秒]，范围为 00:00:00–23:59:59");
  return [...value] as ClockTime;
}
const clockSeconds = (value: ClockTime) => value[0] * 3600 + value[1] * 60 + value[2];
function parseClock(value: string): ClockTime {
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value.trim()))
    throw new Error("时间格式需要 HH:mm 或 HH:mm:ss");
  const parts = value.trim().split(":").map(Number);
  return clock([parts[0], parts[1], parts[2] ?? 0]);
}
export function parseSchedulerField(key: SchedulerField, text: string): unknown {
  const value = text.trim();
  if (!fields.has(key)) throw new Error("不支持的调度字段");
  if (key === "enabled") {
    if (["true", "1", "on", "yes", "开启", "是"].includes(value.toLowerCase())) return true;
    if (["false", "0", "off", "no", "关闭", "否"].includes(value.toLowerCase())) return false;
    throw new Error("启用状态需要 true 或 false");
  }
  if (key === "priority" || key === "interval") {
    if (!value) throw new Error("数值不能为空");
    return integer(
      Number(value),
      key === "interval" ? 0 : Number.MIN_SAFE_INTEGER,
      key === "interval" ? "执行间隔" : "优先级"
    );
  }
  if (key === "next_tick") {
    const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    let localSeconds: number | undefined;
    if (local) {
      const parts = local.slice(1).map((part) => Number(part ?? 0));
      const date = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
      if (
        date.getFullYear() !== parts[0] ||
        date.getMonth() !== parts[1] - 1 ||
        date.getDate() !== parts[2] ||
        date.getHours() !== parts[3] ||
        date.getMinutes() !== parts[4] ||
        date.getSeconds() !== parts[5]
      )
        throw new Error("下次执行时间不是有效的本地日期时间");
      localSeconds = date.getTime() / 1000;
    }
    const seconds =
      value === "立即"
        ? 0
        : /^(?:now|现在)$/i.test(value)
          ? Math.floor(Date.now() / 1000)
          : /^\d+$/.test(value)
            ? Number(value)
            : (localSeconds ?? Math.floor(Date.parse(value) / 1000));
    return integer(seconds, 0, "下次执行时间");
  }
  if (value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("请输入有效 JSON 数组");
    }
  }
  if (!value) return [];
  const entries = value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (key === "daily_reset") return entries.map(parseClock);
  if (key === "disabled_time_range")
    return entries.map((entry) => {
      const ends = entry.split(/\s*[-–—]\s*/);
      if (ends.length !== 2) throw new Error("禁用时段需要 HH:mm-HH:mm");
      return [parseClock(ends[0]), parseClock(ends[1])];
    });
  return entries;
}
export function validateSchedulerChanges(
  taskId: string,
  changes: Record<string, unknown>,
  tasks: SchedulerTask[]
): SchedulerChanges {
  if (!tasks.some((task) => task.func_name === taskId)) throw new Error(`任务不存在：${taskId}`);
  const result: Record<string, unknown> = {};
  const ids = new Set(tasks.map((task) => task.func_name));
  for (const [key, value] of Object.entries(changes)) {
    if (!fields.has(key)) throw new Error(`调度字段不可编辑：${key}`);
    if (key === "enabled") {
      if (typeof value !== "boolean") throw new Error("启用状态需要布尔值");
      result[key] = value;
    } else if (["priority", "interval", "next_tick"].includes(key))
      result[key] = integer(value, key === "priority" ? Number.MIN_SAFE_INTEGER : 0, key);
    else {
      if (!Array.isArray(value) || value.length > 1440)
        throw new Error("调度列表需要不超过 1440 项的数组");
      if (key === "daily_reset") result[key] = value.map(clock);
      else if (key === "disabled_time_range")
        result[key] = value.map((range) => {
          if (!Array.isArray(range) || range.length !== 2)
            throw new Error("禁用时段需要开始和结束时间");
          const start = clock(range[0]),
            end = clock(range[1]);
          if (clockSeconds(start) > clockSeconds(end))
            throw new Error("禁用时段结束不能早于开始；跨午夜请拆成两个时段");
          return [start, end];
        });
      else {
        const seen = new Set<string>();
        result[key] = value.map((id) => {
          if (typeof id !== "string" || !ids.has(id) || id === taskId || seen.has(id))
            throw new Error("前后置任务必须是其他现有任务，且不能重复");
          seen.add(id);
          return id;
        });
      }
    }
  }
  return structuredClone(result) as SchedulerChanges;
}
export function schedulerTasks(data: unknown): SchedulerTask[] {
  const entries = Array.isArray(data)
    ? data.map((task, index) => [String(task?.func_name ?? index), task] as const)
    : data && typeof data === "object"
      ? Object.entries(data)
      : [];
  const seen = new Set<string>();
  return entries.map(([id, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("调度任务数据无效");
    const value = raw as Record<string, unknown>,
      name = String(value.func_name || id);
    if (!name || seen.has(name)) throw new Error("调度任务 ID 缺失或重复");
    seen.add(name);
    return structuredClone({
      enabled: true,
      priority: 0,
      interval: 0,
      next_tick: 0,
      daily_reset: [],
      disabled_time_range: [],
      pre_task: [],
      post_task: [],
      ...value,
      func_name: name,
      event_name: String(value.event_name || name),
    }) as SchedulerTask;
  });
}
export function schedulerState(
  profile: string,
  data: unknown,
  newEventState: unknown = "default"
): SchedulerState {
  return {
    profile,
    tasks: schedulerTasks(data),
    newEventState: validateNewEventState(newEventState),
  };
}
export function validateNewEventState(value: unknown): NewEventState {
  if (typeof value !== "string" || !["on", "off", "default"].includes(value))
    throw new Error("新增任务默认状态需要 on、off 或 default");
  return value as NewEventState;
}
export function changedSchedulerFields(
  task: SchedulerTask,
  changes: SchedulerChanges
): SchedulerChanges {
  return Object.fromEntries(
    Object.entries(changes).filter(([key, value]) => !equal(task[key], value))
  ) as SchedulerChanges;
}
export function formatSchedulerField(key: SchedulerField, value: unknown): string {
  if (key === "next_tick" && typeof value === "number") {
    if (value === 0) return "立即";
    const date = new Date(value * 1000);
    if (!Number.isFinite(date.getTime())) return String(value);
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  if (key === "daily_reset" && Array.isArray(value))
    return value
      .map((item) =>
        clock(item)
          .map((part) => String(part).padStart(2, "0"))
          .join(":")
      )
      .join(", ");
  if (key === "disabled_time_range" && Array.isArray(value))
    return value
      .map(
        (range) =>
          `${formatSchedulerField("daily_reset", [range[0]])}-${formatSchedulerField("daily_reset", [range[1]])}`
      )
      .join(", ");
  if (["pre_task", "post_task"].includes(key) && Array.isArray(value)) return value.join(", ");
  return String(value ?? "");
}
export function schedulerSummary(
  state: SchedulerState,
  runtime: Record<string, unknown> = {},
  now = Date.now() / 1000
) {
  const enabled = state.tasks.filter((task) => task.enabled),
    current = typeof runtime.current_task === "string" ? runtime.current_task : undefined,
    localNow = new Date(now * 1000),
    seconds = localNow.getHours() * 3600 + localNow.getMinutes() * 60 + localNow.getSeconds();
  const disabledNow = (task: SchedulerTask) =>
    task.disabled_time_range.some(
      ([start, end]) => clockSeconds(start) <= seconds && seconds <= clockSeconds(end)
    );
  // This is the backend's queue rule: due, enabled, outside disabled periods, then priority.
  // Stable sorting deliberately preserves event.json order when priorities are equal.
  const ready = enabled
    .filter((task) => task.next_tick <= now && !disabledNow(task))
    .sort((a, b) => a.priority - b.priority);
  const candidates = enabled.flatMap((task) => {
    let tick = Math.max(now, task.next_tick);
    // Overlapping disabled ranges may advance the candidate more than once. Two days
    // without any opening means the task has no possible time under these daily rules.
    const limit = (task.disabled_time_range.length + 1) * 2;
    for (let attempt = 0; attempt < limit; attempt++) {
      const date = new Date(tick * 1000),
        seconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds(),
        range = task.disabled_time_range.find(
          ([start, end]) => clockSeconds(start) <= seconds && seconds <= clockSeconds(end)
        );
      if (!range) return [{ task, tick }];
      date.setHours(0, 0, clockSeconds(range[1]) + 1, 0);
      tick = date.getTime() / 1000;
    }
    return [];
  });
  candidates.sort((a, b) => a.tick - b.tick || a.task.priority - b.task.priority);
  const next = ready[0] || candidates[0]?.task;
  return {
    total: state.tasks.length,
    enabled: enabled.length,
    disabled: state.tasks.length - enabled.length,
    currentTask: current,
    waitingTasks: Array.isArray(runtime.waiting_tasks)
      ? runtime.waiting_tasks.filter((task): task is string => typeof task === "string")
      : [],
    nextTask: next?.func_name,
    nextTick: ready.length ? next?.next_tick : candidates[0]?.tick,
    due: ready.length,
    blocked: enabled.filter(disabledNow).length,
    queue: ready.map((task) => task.func_name),
  };
}
