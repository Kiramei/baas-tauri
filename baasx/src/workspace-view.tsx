import chalk from "chalk";
import { InstallationPanel } from "./installation-view";
import { FieldEditor, type EditableField } from "./field-editor";
import {
  configurationFields,
  configurationSections,
  parseConfigurationValue,
  formatConfigurationValue,
} from "./configuration";
import {
  SCHEDULER_FIELDS,
  formatSchedulerField,
  parseSchedulerField,
  schedulerState,
  schedulerSummary,
  type SchedulerField,
} from "./scheduler";
import { MouseBus, terminalSession } from "./terminal";
import { HitBox, Marquee, MouseContext, PIXEL_LOGO, ScrollText } from "./terminal-components";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Box, Text as InkText, render, useApp, useInput, useStdin, useStdout } from "ink";
import { Workspace, type WorkspaceOptions } from "./workspace";
import { displayWidth, terminalText, truncateText } from "./ui";
import manifest from "../package.json";
import { translate, LANGUAGES } from "./i18n";

const LanguageContext = createContext("zh");

function useCurrentInput(
  handler: Parameters<typeof useInput>[0],
  options: Parameters<typeof useInput>[1]
) {
  const current = useRef(handler);
  // Ink replaces input callbacks in a passive effect. A key arriving after a
  // committed frame must observe that frame's prompt and selection immediately.
  useLayoutEffect(() => {
    current.current = handler;
  });
  useInput(
    useCallback((text, key) => current.current(text, key), []),
    options
  );
}

function Text(props: React.ComponentProps<typeof InkText>) {
  const language = useContext(LanguageContext);
  return (
    <InkText {...props}>
      {React.Children.map(props.children, (child) =>
        typeof child === "string" ? translate(child, language) : child
      )}
    </InkText>
  );
}

const ACCENT = "#70d7e5";
const MUTED = "#89969f";
const GREEN = "#98cf9e";
const AMBER = "#e9bd78";
const RED = "#f38b91";
const SELECTED = "#203f49";

type View =
  | "home"
  | "scheduler"
  | "tasks"
  | "profiles"
  | "logs"
  | "config"
  | "packs"
  | "help"
  | "language"
  | "setup";
type Snapshot = Workspace["snapshot"];
type Choice = { id: string; label: string; detail: string };
const VIEWS: [View, string][] = [
  ["home", "总览"],
  ["tasks", "任务"],
  ["scheduler", "调度"],
  ["profiles", "配置档"],
  ["logs", "日志"],
  ["config", "配置"],
  ["packs", "指令包"],
];
export const COMMANDS: Choice[] = [
  { id: "scheduler", label: "/scheduler", detail: "编辑任务调度" },
  { id: "update", label: "/update", detail: "检查并更新本地后端" },
  { id: "new-profile", label: "/new-profile", detail: "新建配置档" },
  { id: "language", label: "/language", detail: "选择语言" },
  { id: "install", label: "/install", detail: "安装本地环境" },
  { id: "local", label: "/local", detail: "启动本地后端" },
  { id: "run", label: "/run", detail: "选择并运行任务" },
  { id: "tasks", label: "/tasks", detail: "选择并运行任务" },
  { id: "profiles", label: "/profiles", detail: "切换配置档" },
  { id: "start", label: "/start", detail: "启动当前配置档的调度" },
  { id: "stop", label: "/stop", detail: "停止当前运行" },
  { id: "logs", label: "/logs", detail: "查看实时运行日志" },
  { id: "config", label: "/config", detail: "浏览、搜索与修改配置" },
  { id: "connect", label: "/connect", detail: "连接 BAAS 服务" },
  { id: "status", label: "/status", detail: "刷新运行状态" },
  { id: "packs", label: "/packs", detail: "查看独立指令包" },
  { id: "devices", label: "/devices", detail: "检测 ADB 设备" },
  { id: "doctor", label: "/doctor", detail: "检查服务连接" },
  { id: "home", label: "/home", detail: "返回工作台总览" },
  { id: "help", label: "/help", detail: "命令与键盘操作" },
  { id: "quit", label: "/quit", detail: "退出终端" },
];
const chars = (text: string) =>
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
    (x) => x.segment
  );
const clean = (value: unknown) => terminalText(value).replace(/\n/g, " ");
const pad = (value: string, width: number) => {
  const clipped = truncateText(value, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
};
export function filterChoices(items: Choice[], query: string): Choice[] {
  const search = clean(query).trim().toLowerCase();
  return items.filter((item) =>
    `${item.id} ${item.label} ${item.detail}`.toLowerCase().includes(search)
  );
}
export function configChoices(config: Record<string, unknown>, language = "zh"): Choice[] {
  return configurationFields(config, { language }).map((field) => ({
    id: field.path,
    label: field.label,
    detail: formatConfigurationValue(field),
  }));
}

function useSize() {
  const { stdout } = useStdout();
  const measure = () => ({
    columns: Math.max(1, stdout.columns || 80),
    rows: Math.max(2, stdout.rows || 30),
  });
  const [size, setSize] = useState(measure);
  useEffect(() => {
    const resized = () => setSize(measure());
    stdout.on("resize", resized);
    return () => {
      stdout.off("resize", resized);
    };
  }, [stdout]);
  return size;
}

function Welcome({
  state,
  columns,
  compact,
}: {
  state: Snapshot;
  columns: number;
  compact: boolean;
}) {
  const language = useContext(LanguageContext);
  const t = (text: string) => translate(text, language);
  const current = state.status[state.profile || ""];
  const tasks = Object.values(state.tasks);
  const enabled = tasks.filter((task) => task.enabled !== false && task.enable !== false);
  let summary: ReturnType<typeof schedulerSummary> | undefined;
  try {
    summary = schedulerSummary(
      state.scheduler || schedulerState(state.profile || "", state.tasks),
      current || {}
    );
  } catch {
    /* A malformed backend event must not break the workbench header. */
  }
  const next = tasks.find((task) => task.func_name === summary?.nextTask);
  const nextTime = next
    ? summary?.due
      ? t("待执行")
      : new Date(Number(summary?.nextTick) * 1000).toLocaleString(language, {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
    : t("暂无安排");
  const label = clean(state.profiles[state.profile || ""] || state.profile || t("尚未选择配置档"));
  const status = t(state.connecting ? "连接中" : state.connected ? "已连接" : "未连接");
  const activity = state.activity.at(-1);
  const info = (
    <>
      <Marquee
        value={`${label} · ${status}${state.demo ? " · DEMO" : state.endpoint ? " · " + clean(state.endpoint) : ""}`}
        width={compact ? columns - 2 : columns - 33}
        color={state.connected ? GREEN : AMBER}
      />
      <Marquee
        value={
          current?.running
            ? `${t("正在执行")} · ${clean(current.current_task || t("调度运行中"))} · ${t("队列")} ${summary?.waitingTasks.length || summary?.due || 0}`
            : `${t("调度")} · ${enabled.length}/${tasks.length} ${t("已启用")} · ${t("待执行")} ${summary?.due || 0}`
        }
        width={compact ? columns - 2 : columns - 33}
        color={current?.running ? GREEN : MUTED}
      />
      <Marquee
        value={`${t("下次执行")} · ${next ? `${clean(next.event_name || next.func_name)} · ${nextTime}` : nextTime}`}
        width={compact ? columns - 2 : columns - 33}
        color={MUTED}
      />
    </>
  );
  if (compact)
    return (
      <Box paddingX={1} flexDirection="column" height={4} flexShrink={0}>
        <Text color={ACCENT} bold>
          ▣ baasx <Text color={MUTED}>v{manifest.version}</Text>
        </Text>
        {info}
      </Box>
    );
  return (
    <Box flexDirection="column" height={9} flexShrink={0}>
      <Text color={ACCENT}>
        ╭─ baasx v{manifest.version}
        {"─".repeat(Math.max(0, columns - displayWidth(`╭─ baasx v${manifest.version}`) - 1))}╮
      </Text>
      <Box
        borderStyle="single"
        borderColor={ACCENT}
        borderTop={false}
        borderBottom={false}
        height={7}
      >
        <Box width={28} alignItems="center" flexDirection="column" flexShrink={0}>
          {PIXEL_LOGO.map((line, index) => (
            <Text key={index} color={index < 3 ? "#43c4c9" : index < 5 ? "#64d5d6" : "#94e3e3"}>
              {line}
            </Text>
          ))}
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          paddingX={1}
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor={MUTED}
        >
          <Text color={ACCENT} bold>
            {state.chooseLanguage || state.setupNeeded ? "首次设置" : "欢迎回来，老师。"}
          </Text>
          {info}
          <Text> </Text>
          <Marquee
            value={
              activity
                ? `${t(activity.title)}${activity.detail ? " · " + t(clean(activity.detail)) : ""}`
                : t("还没有运行记录。输入 / 查看可用操作。")
            }
            width={columns - 33}
            color={activity?.tone === "error" ? RED : MUTED}
          />
          <Text color={MUTED} wrap="truncate">
            /tasks · /scheduler · /config · /update
          </Text>
        </Box>
      </Box>
      <Text color={ACCENT}>╰{"─".repeat(Math.max(0, columns - 2))}╯</Text>
    </Box>
  );
}

function ChoiceList({
  items,
  selected,
  height,
  columns,
  title,
  empty,
  onChoose,
  onScroll,
}: {
  items: Choice[];
  selected: number;
  height: number;
  columns: number;
  title: string;
  empty: string;
  onChoose?: (index: number) => void;
  onScroll?: (delta: number) => void;
}) {
  const language = useContext(LanguageContext);
  const limit = Math.max(1, height - 2);
  const offset = Math.max(0, Math.min(selected - Math.floor(limit / 2), items.length - limit));
  const labelWidth = Math.min(32, Math.floor(columns * 0.42));
  return (
    <HitBox flexDirection="column" paddingX={1} height={height} onWheel={onScroll}>
      <Text bold color={ACCENT}>
        {title} <Text color={MUTED}>{items.length ? `${selected + 1} / ${items.length}` : ""}</Text>
      </Text>
      {!items.length && <Text color={MUTED}>{empty}</Text>}
      {items.slice(offset, offset + limit).map((item, index) => {
        const focused = index + offset === selected;
        return (
          <HitBox
            key={item.id}
            height={1}
            flexShrink={0}
            onPress={() => onChoose?.(index + offset)}
          >
            <Text backgroundColor={focused ? SELECTED : undefined} color={focused ? ACCENT : MUTED}>
              {focused ? "❯ " : "  "}
            </Text>
            <Box width={labelWidth} flexShrink={0}>
              <Marquee
                value={translate(clean(item.label), language)}
                width={labelWidth}
                color={focused ? ACCENT : undefined}
                backgroundColor={focused ? SELECTED : undefined}
              />
            </Box>
            <Text> </Text>
            <Marquee
              value={translate(clean(item.detail), language)}
              width={Math.max(1, columns - labelWidth - 6)}
              color={focused ? ACCENT : MUTED}
              backgroundColor={focused ? SELECTED : undefined}
            />
          </HitBox>
        );
      })}
    </HitBox>
  );
}

function LogPanel({
  state,
  height,
  columns,
  offset,
  onScroll,
}: {
  state: Snapshot;
  height: number;
  columns: number;
  offset: number;
  onScroll: (delta: number) => void;
}) {
  const language = useContext(LanguageContext),
    limit = Math.max(1, height - 3);
  const entries = state.logs.slice(
    Math.max(0, state.logs.length - offset - limit),
    Math.max(0, state.logs.length - offset)
  );
  return (
    <HitBox
      flexDirection="column"
      width={columns}
      height={height}
      paddingX={1}
      onWheel={(delta) => onScroll(-delta)}
    >
      <Text color={ACCENT} bold>
        运行日志 <Text color={MUTED}>{offset ? "↑" : "●"}</Text>
      </Text>
      <Text color={MUTED} wrap="truncate">
        {offset ? "已暂停跟随 · 向下滚动恢复" : "● 实时跟随"}
      </Text>
      {entries.length ? (
        entries.map((entry, index) => {
          const level = String(entry.level).toUpperCase();
          const color = level.includes("ERROR")
            ? RED
            : level.includes("WARN")
              ? AMBER
              : level.includes("SUCCESS")
                ? GREEN
                : level.includes("DEBUG")
                  ? MUTED
                  : undefined;
          return (
            <Box key={index} height={1} flexShrink={0}>
              <Text color={MUTED}>{clean(entry.time).slice(11, 19)} </Text>
              <Marquee
                value={`${level} ${clean(entry.message)}`}
                width={Math.max(1, columns - 11)}
                color={color}
              />
            </Box>
          );
        })
      ) : (
        <Text color={MUTED}>{translate("等待日志…", language)}</Text>
      )}
    </HitBox>
  );
}

function Home({
  state,
  height,
  columns,
  offset = 0,
}: {
  state: Snapshot;
  height: number;
  columns: number;
  offset?: number;
}) {
  const current = state.status[state.profile || ""];
  const count = Math.max(0, Math.floor((height - 3) / 2));
  const rows = count
    ? state.activity.slice(
        Math.max(0, state.activity.length - offset - count),
        Math.max(0, state.activity.length - offset)
      )
    : [];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        {state.profile ? clean(state.profiles[state.profile] || state.profile) : "开始使用"}
        <Text color={current?.running ? GREEN : MUTED}>
          {" "}
          {current?.running ? "● 运行中" : state.connected ? "○ 空闲" : "○ 等待连接"}
        </Text>
      </Text>
      <Text color={MUTED} wrap="truncate">
        {state.connected
          ? `${Object.keys(state.tasks).length} 项任务 · ${state.packs.length} 个指令 · /tasks 选择任务 · /logs 查看日志`
          : "/connect 连接服务 → /profiles 选择配置档 → /tasks 执行任务"}
      </Text>
      {height >= 5 && <Text> </Text>}
      {rows.map((item) => (
        <Box key={item.id} flexDirection="column" flexShrink={0}>
          <Text
            color={item.tone === "error" ? RED : item.tone === "success" ? GREEN : undefined}
            wrap="truncate"
          >
            {item.tone === "error" ? "✗" : item.tone === "success" ? "✓" : "●"} {clean(item.title)}
          </Text>
          {item.detail && (
            <Text color={MUTED} wrap="truncate">
              {" "}
              └ {truncateText(clean(item.detail), columns - 6)}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const deleteKeys = useRef<string[]>([]);
  useEffect(() => {
    // Ink normalizes both DEL (backspace) and CSI 3~ (forward delete) to key.delete.
    // Preserve just these raw tokens before Ink consumes the stream, without another reader.
    const record = (data: Buffer | string) => {
      // eslint-disable-next-line no-control-regex -- Distinguish terminal Delete and Backspace sequences.
      for (const match of String(data).matchAll(/\x1b\[3(?:;\d+)?~|\x7f/g))
        deleteKeys.current.push(match[0]);
      deleteKeys.current = deleteKeys.current.slice(-100);
    };
    stdin.prependListener("data", record);
    return () => {
      stdin.removeListener("data", record);
    };
  }, [stdin]);
  const { columns, rows } = useSize();
  const [state, setState] = useState(workspace.snapshot);
  const [view, setView] = useState<View>(
    state.chooseLanguage ? "language" : state.setupNeeded ? "setup" : "home"
  );
  const [input, setInput] = useState("");
  const [inputSensitive, setInputSensitive] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const [suggested, setSuggested] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState<{
    field: EditableField;
    save: (value: unknown) => Promise<void>;
  }>();
  const [configSection, setConfigSection] = useState<string>();
  const [schedulerTask, setSchedulerTask] = useState<string>();
  const [notice, setNotice] = useState("");
  const [logOffset, setLogOffset] = useState(0);
  const [activityOffset, setActivityOffset] = useState(0);
  const [logVisible, setLogVisible] = useState(false);
  const [installationVisible, setInstallationVisible] = useState(false);
  const [tick, setTick] = useState(0);
  const latestError = state.activity.at(-1)?.tone === "error" ? state.activity.at(-1) : undefined;
  const prompt = state.prompt;
  const compact =
    columns < 100 || rows < 34 || view !== "home" || !!state.busy || installationVisible;
  const language = state.language || "zh";
  const listing = [
    "scheduler",
    "tasks",
    "profiles",
    "packs",
    "config",
    "language",
    "setup",
  ].includes(view);
  const secret = prompt?.kind === "secret";
  const resetInput = (value = "", sensitive = false) => {
    setInput(value);
    setInputSensitive(sensitive);
    setCursor(chars(value).length);
    setSelected(0);
    setSuggested(0);
    setNotice("");
  };
  const answerPrompt = (value: string | boolean) => {
    // Clear the selection with the controller's prompt dismissal, so it cannot
    // become the first character of the next command while effects are pending.
    resetInput();
    workspace.answerPrompt(value);
  };
  useEffect(() => workspace.subscribe((snapshot) => setState(snapshot)), [workspace]);
  useEffect(() => {
    if (state.busy || Object.values(state.status).some((item) => item.running)) {
      const timer = setInterval(() => setTick((n) => n + 1), 120);
      return () => clearInterval(timer);
    }
  }, [state.busy, state.status]);
  useLayoutEffect(() => {
    resetInput(prompt?.kind === "confirm" ? "y" : prompt?.initial || "");
  }, [prompt?.id, prompt?.title, prompt?.kind]);
  useEffect(() => {
    if (!state.installation) setInstallationVisible(false);
    else if (state.busy) setInstallationVisible(true);
  }, [state.busy, state.installation?.startedAt]);
  useEffect(() => {
    setConfig({});
    setConfigSection(undefined);
    setSchedulerTask(undefined);
    setEditing(undefined);
    setSelected(0);
  }, [state.profile]);

  const taskChoices = Object.entries(state.tasks).map(([id, task]) => ({
    id,
    label: String(task.event_name || task.name || task.display_name || id),
    detail: `${id} · ${translate(task.enabled === false || task.enable === false ? "未启用调度" : "已配置", language)}${task.next_tick ? ` · ${formatSchedulerField("next_tick", task.next_tick)}` : ""}`,
  }));
  const configurationOptions = { language, staticData: state.staticData };
  const fields = configurationFields(config, configurationOptions);
  const sections = configurationSections(config, configurationOptions);
  const configItems: Choice[] =
    !configSection && (!input || input.startsWith("/"))
      ? sections.map((section) => ({
          id: `section:${section.id}`,
          label: section.label,
          detail: `${section.fields.length} ${translate("项设置", language)}`,
        }))
      : fields
          .filter((field) => !configSection || field.section === configSection)
          .map((field) => ({
            id: field.path,
            label: field.label,
            detail: formatConfigurationValue(field),
          }));
  const schedule = state.scheduler;
  const currentSchedule = schedule?.tasks.find((task) => task.func_name === schedulerTask);
  const schedulerItems: Choice[] = currentSchedule
    ? SCHEDULER_FIELDS.map((field) => ({
        id: field.key,
        label: field.label,
        detail: formatSchedulerField(field.key, currentSchedule[field.key]),
      }))
    : [
        {
          id: "@all",
          label: !schedule?.tasks.some((task) => !task.enabled) ? "全部禁用" : "全部启用",
          detail: "",
        },
        { id: "@reset", label: "重置执行时间", detail: "立即可执行" },
        {
          id: "@new",
          label: "新增任务默认状态",
          detail: translate(
            schedule?.newEventState === "on"
              ? "开启"
              : schedule?.newEventState === "off"
                ? "关闭"
                : "默认",
            language
          ),
        },
        ...(schedule?.tasks || []).map((task) => ({
          id: task.func_name,
          label: task.event_name,
          detail: `${task.enabled ? "●" : "○"} ${formatSchedulerField("next_tick", task.next_tick)}`,
        })),
      ];
  const baseChoices: Choice[] =
    view === "scheduler"
      ? schedulerItems
      : view === "language"
        ? LANGUAGES.map((item) => ({
            id: item.id,
            label: item.label,
            detail: item.id === language ? "✓" : "",
          }))
        : view === "setup"
          ? [
              { id: "install", label: "安装本地环境", detail: "自动安装 Python、后端与运行依赖" },
              { id: "remote", label: "连接已有服务", detail: "使用已有 BAAS 服务地址" },
            ]
          : view === "tasks"
            ? taskChoices
            : view === "profiles"
              ? Object.entries(state.profiles).map(([id, label]) => ({
                  id,
                  label,
                  detail: `${id}${id === state.profile ? " · 当前" : ""}${state.status[id]?.running ? " · 运行中" : ""}`,
                }))
              : view === "packs"
                ? state.packs.map((p) => ({
                    id: p.name,
                    label: `/${p.name}`,
                    detail: p.description,
                  }))
                : view === "config"
                  ? configItems
                  : [];
  const choices = filterChoices(
    baseChoices,
    input.startsWith("/") || editing || prompt ? "" : input
  );
  const selectedIndex = Math.max(0, Math.min(selected, choices.length - 1));
  const commandQuery = input.startsWith("/") ? input.slice(1) : "";
  const commandItems = [
    ...COMMANDS,
    ...state.packs.map((pack) => ({
      id: pack.name,
      label: `/${pack.name}`,
      detail: pack.description,
    })),
  ];
  const argumentMatch = /^\/(run|use)\s+(.*)$/.exec(input);
  const suggestions =
    !prompt && !editing && input.startsWith("/")
      ? argumentMatch
        ? filterChoices(
            argumentMatch[1] === "run"
              ? taskChoices
              : Object.entries(state.profiles).map(([id, label]) => ({ id, label, detail: id })),
            argumentMatch[2]
          ).map((item) => ({
            ...item,
            id: `${argumentMatch[1]} ${item.id}`,
            label: `/${argumentMatch[1]} ${item.id}`,
          }))
        : commandItems.filter((c) => c.id.startsWith(commandQuery))
      : [];
  const suggestionIndex = Math.min(suggested, Math.max(0, suggestions.length - 1));
  const footerRows = suggestions.length ? Math.min(5, suggestions.length) + 1 : 1;
  const splitLog =
    logVisible &&
    columns >= 110 &&
    view !== "logs" &&
    !prompt &&
    !editing &&
    !state.busy &&
    !installationVisible;
  const mainColumns = splitLog ? Math.floor(columns * 0.56) : columns;
  const showCommandInput = (!editing && !state.busy) || !!prompt;
  const bodyHeight = Math.max(
    1,
    rows - 1 - (compact ? 4 : 9) - 2 - (showCommandInput ? 3 : 0) - footerRows - 1
  );
  const requireSaved = (saved: boolean | void) => {
    if (saved !== false) return;
    const activity = workspace.snapshot.activity.at(-1);
    throw new Error(activity?.detail || activity?.title || translate("未提交", language));
  };
  const operation = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      setNotice(clean((error as Error).message));
    }
  };
  const go = async (next: View) => {
    setInstallationVisible(false);
    setView(next);
    resetInput();
    setLogOffset(0);
    if (
      ["scheduler", "tasks", "profiles", "logs", "config"].includes(next) &&
      !workspace.snapshot.connected
    )
      await workspace.connect();
    if (next === "scheduler") {
      setSchedulerTask(undefined);
      await workspace.loadScheduler();
    }
    if (next === "config" && workspace.snapshot.profile) {
      setConfigSection(undefined);
      const data = await workspace.getConfig();
      if (data) setConfig(data);
    }
  };
  const submitCommand = async (line: string) => {
    const command = line.trim().replace(/^\//, "");
    if (!command) return;
    setInstallationVisible(false);
    setHistory((old) => [line, ...old.filter((x) => x !== line)].slice(0, 100));
    setHistoryIndex(-1);
    resetInput();
    if (["quit", "exit"].includes(command)) {
      workspace.close();
      exit();
      return;
    }
    if (["home", "clear"].includes(command)) {
      setView("home");
      return;
    }
    if (command === "help" || command === "?") {
      setView("help");
      return;
    }
    if (
      ["scheduler", "tasks", "profiles", "logs", "config", "packs", "language", "setup"].includes(
        command
      )
    ) {
      await go(command as View);
      return;
    }
    if (command === "use") {
      await go("profiles");
      return;
    }
    if (command === "run") {
      await go("tasks");
      return;
    }
    if (command === "new-profile") {
      setView("home");
      await workspace.addProfile();
      return;
    }
    if (/^(start|run)( |$)/.test(command)) {
      setLogVisible(true);
      setLogOffset(0);
      setView(columns >= 110 ? "home" : "logs");
    } else setView("home");
    await workspace.execute(command);
  };
  const choose = async (index = selectedIndex) => {
    const item = choices[index];
    if (!item) return;
    resetInput();
    if (view === "language") {
      await workspace.setLanguage(item.id);
      setView(workspace.snapshot.setupNeeded ? "setup" : "home");
    }
    if (view === "setup") {
      if (item.id === "install") await workspace.installLocal();
      else await workspace.setupRemote();
      if (!workspace.snapshot.setupNeeded) setView("home");
    }
    if (view === "profiles") {
      await workspace.selectProfile(item.id);
      setView("home");
    }
    if (view === "tasks") {
      setLogVisible(true);
      setLogOffset(0);
      setView(columns >= 110 ? "home" : "logs");
      await workspace.run(item.id);
    }
    if (view === "packs") {
      setView("home");
      await workspace.execute(`pack ${item.id}`);
    }
    if (view === "config") {
      if (item.id.startsWith("section:")) {
        setConfigSection(item.id.slice(8));
        return;
      }
      const field = fields.find((field) => field.path === item.id);
      if (!field) return;
      if (field.readOnly) {
        setNotice(translate("此项由客户端管理", language));
        return;
      }
      setEditing({
        field,
        save: async (value) => {
          const parsed = parseConfigurationValue(field, value);
          requireSaved(await workspace.setConfig(field.path, parsed));
          const next = await workspace.getConfig();
          if (next) setConfig(next);
          setEditing(undefined);
        },
      });
    }
    if (view === "scheduler") {
      if (item.id === "@all") {
        await workspace.setAllSchedulerEnabled(!!schedule?.tasks.some((task) => !task.enabled));
        return;
      }
      if (item.id === "@reset") {
        await workspace.resetSchedulerTimes();
        return;
      }
      if (item.id === "@new") {
        setEditing({
          field: {
            label: translate(item.label, language),
            type: "select",
            value: schedule?.newEventState,
            options: [
              { label: translate("默认", language), value: "default" },
              { label: translate("启用", language), value: "on" },
              { label: translate("禁用", language), value: "off" },
            ],
          },
          save: async (value) => {
            requireSaved(await workspace.setNewEventState(value as "on" | "off" | "default"));
            setEditing(undefined);
          },
        });
        return;
      }
      if (!currentSchedule) {
        setSchedulerTask(item.id);
        return;
      }
      const key = item.id as SchedulerField,
        definition = SCHEDULER_FIELDS.find((field) => field.key === key)!;
      const value = currentSchedule[key];
      let field: EditableField = {
        label: translate(definition.label, language),
        description: translate(definition.hint, language),
        type: "text",
        value: formatSchedulerField(key, value),
      };
      if (key === "enabled") field = { ...field, type: "switch", value };
      if (key === "priority" || key === "interval")
        field = {
          ...field,
          type: "number",
          value,
          integer: true,
          ...(key === "interval" ? { min: 0 } : {}),
        };
      if (key === "pre_task" || key === "post_task")
        field = {
          ...field,
          type: "list",
          value,
          ordered: true,
          options: schedule!.tasks
            .filter((task) => task.func_name !== currentSchedule.func_name)
            .map((task) => ({ label: task.event_name, value: task.func_name })),
        };
      if (key === "daily_reset")
        field = {
          ...field,
          type: "rows",
          value: (value as number[][]).map(([h, m, s]) => ({ h, m, s })),
          columns: [
            {
              key: "h",
              label: translate("时", language),
              type: "number",
              min: 0,
              max: 23,
              integer: true,
            },
            {
              key: "m",
              label: translate("分", language),
              type: "number",
              min: 0,
              max: 59,
              integer: true,
            },
            {
              key: "s",
              label: translate("秒", language),
              type: "number",
              min: 0,
              max: 59,
              integer: true,
            },
          ],
          defaultRow: { h: 5, m: 0, s: 0 },
        };
      if (key === "disabled_time_range")
        field = {
          ...field,
          type: "rows",
          value: (value as number[][][]).map(([a, b]) => ({
            start: a.map((n) => String(n).padStart(2, "0")).join(":"),
            end: b.map((n) => String(n).padStart(2, "0")).join(":"),
          })),
          columns: [
            { key: "start", label: translate("开始时间", language), type: "text" },
            { key: "end", label: translate("结束时间", language), type: "text" },
          ],
          defaultRow: { start: "00:00:00", end: "01:00:00" },
        };
      setEditing({
        field,
        save: async (edited) => {
          let parsed = edited;
          if (key === "next_tick") parsed = parseSchedulerField(key, String(edited));
          if (key === "daily_reset")
            parsed = (edited as Record<string, number>[]).map((row) => [row.h, row.m, row.s]);
          if (key === "disabled_time_range")
            parsed = parseSchedulerField(
              key,
              (edited as Record<string, string>[]).map((row) => `${row.start}-${row.end}`).join(",")
            );
          requireSaved(await workspace.saveScheduler(currentSchedule.func_name, { [key]: parsed }));
          setEditing(undefined);
        },
      });
    }
  };
  useCurrentInput(
    (text, key) => {
      const forwardDelete = key.delete
        ? (deleteKeys.current.shift() || "\x7f").startsWith("\x1b[")
        : false;
      if (key.ctrl && text === "c") {
        if (prompt || state.busy) {
          workspace.cancel();
          resetInput();
        } else if (input || editing) {
          resetInput();
          setEditing(undefined);
        } else {
          workspace.close();
          exit();
        }
        return;
      }
      if (key.ctrl && text === "d") {
        workspace.close();
        exit();
        return;
      }
      if (key.escape) {
        setInstallationVisible(false);
        if (!prompt && !state.busy && !input && view === "config" && configSection) {
          setConfigSection(undefined);
          setSelected(0);
          return;
        }
        if (!prompt && !state.busy && !input && view === "scheduler" && schedulerTask) {
          setSchedulerTask(undefined);
          setSelected(0);
          return;
        }
        if (prompt || state.busy) workspace.cancel();
        else if (editing) setEditing(undefined);
        else if (!input) setView("home");
        resetInput();
        return;
      }
      if (state.busy && !prompt) return;
      if (installationVisible && (key.pageUp || key.pageDown)) return;
      if (prompt && (key.pageUp || key.pageDown)) return;
      if (prompt?.kind === "confirm") {
        if (key.return) answerPrompt(input.toLowerCase() !== "n");
        else if (text.toLowerCase() === "y" || text.toLowerCase() === "n")
          resetInput(text.toLowerCase());
        else if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)
          resetInput(input !== "n" ? "n" : "y");
        return;
      }
      if (!prompt && !editing && key.ctrl && ["t", "p", "l"].includes(text)) {
        void operation(() => go(text === "t" ? "tasks" : text === "p" ? "profiles" : "logs"));
        return;
      }
      if (!prompt && !editing && key.tab && key.shift) {
        const index = VIEWS.findIndex(([id]) => id === view);
        void operation(() => go(VIEWS[(index + 1) % VIEWS.length][0]));
        return;
      }
      if (key.tab && suggestions.length) {
        resetInput(
          suggestions[suggestionIndex].label +
            (suggestions[suggestionIndex].id.includes(" ") ? "" : " ")
        );
        return;
      }
      if (key.upArrow || key.downArrow) {
        const delta = key.downArrow ? 1 : -1;
        if (suggestions.length)
          setSuggested((index) => (index + delta + suggestions.length) % suggestions.length);
        else if (listing && !editing && !prompt)
          setSelected((index) => Math.max(0, Math.min(choices.length - 1, index + delta)));
        else if ((view === "logs" || (logVisible && view === "home")) && !prompt)
          setLogOffset((n) => Math.max(0, Math.min(state.logs.length, n - delta)));
        else if (!prompt && !editing) {
          if (historyIndex === -1) setDraft(input);
          const next = Math.max(-1, Math.min(history.length - 1, historyIndex - delta));
          setHistoryIndex(next);
          resetInput(next === -1 ? draft : history[next]);
        }
        return;
      }
      if (key.pageUp || key.pageDown) {
        const delta = (key.pageDown ? 1 : -1) * Math.max(1, bodyHeight - 2);
        if (view === "logs")
          setLogOffset((n) => Math.max(0, Math.min(state.logs.length, n - delta)));
        else if (view === "home")
          setActivityOffset((n) => Math.max(0, Math.min(state.activity.length - 1, n - delta)));
        else setSelected((n) => Math.max(0, Math.min(choices.length - 1, n + delta)));
        return;
      }
      if (key.return) {
        if (prompt) {
          answerPrompt(input);
          return;
        }
        if (suggestions.length) {
          void operation(() => submitCommand(suggestions[suggestionIndex].label));
          return;
        }
        if (listing && !input.startsWith("/")) {
          void operation(() => choose());
          return;
        }
        void operation(() => submitCommand(input));
        return;
      }
      const parts = chars(input);
      if (key.leftArrow) {
        setCursor((n) => Math.max(0, n - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((n) => Math.min(parts.length, n + 1));
        return;
      }
      if (key.ctrl && text === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && text === "e") {
        setCursor(parts.length);
        return;
      }
      if (key.ctrl && text === "u") {
        setInput(parts.slice(cursor).join(""));
        setCursor(0);
        return;
      }
      if (key.ctrl && text === "k") {
        setInput(parts.slice(0, cursor).join(""));
        return;
      }
      if (key.delete && forwardDelete) {
        parts.splice(cursor, 1);
        setInput(parts.join(""));
        setSelected(0);
        setSuggested(0);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          parts.splice(cursor - 1, 1);
          setInput(parts.join(""));
          setCursor(cursor - 1);
        }
        setSelected(0);
        setSuggested(0);
        return;
      }
      if (key.ctrl || key.meta) return;
      const safe = clean(text).replace(/\r/g, " ");
      if (!safe || input.length + safe.length > 8192) return;
      if (secret) setInputSensitive(true);
      parts.splice(cursor, 0, ...chars(safe));
      setInput(parts.join(""));
      setCursor(cursor + chars(safe).length);
      setSelected(0);
      setSuggested(0);
      setNotice("");
    },
    { isActive: !editing || !!prompt }
  );

  const promptTitle = prompt?.title || "";
  const tabWidth = ([id, label]: [View, string]) =>
    displayWidth(translate(label, language)) + (view === id ? 4 : 2);
  const currentTab = Math.max(
    0,
    VIEWS.findIndex(([id]) => id === view)
  );
  let firstTab = 0;
  while (
    firstTab < currentTab &&
    VIEWS.slice(firstTab, currentTab + 1).reduce((sum, tab) => sum + tabWidth(tab), 0) > columns - 2
  )
    firstTab++;
  const parts = chars(secret || inputSensitive ? "•".repeat(chars(input).length) : input);
  let start = cursor;
  let used = 0;
  while (start > 0 && used + displayWidth(parts[start - 1]) < columns - 8) {
    start--;
    used += displayWidth(parts[start]);
  }
  const before = parts.slice(start, cursor).join("");
  const after = truncateText(
    parts.slice(cursor + 1).join(""),
    Math.max(0, columns - displayWidth(before) - 5)
  );
  const placeholder = listing
    ? "键入名称筛选 · / 打开命令"
    : "输入 / 查看操作，或输入 tasks、start 等命令";
  const activeTask = state.status[state.profile || ""]?.current_task;
  if (columns < 24 || rows < 12)
    return (
      <LanguageContext.Provider value={language}>
        <Box width={columns} height={rows - 1} flexDirection="column" overflow="hidden">
          <Text wrap="truncate" color={ACCENT}>
            BAAS
          </Text>
          <Text wrap="truncate">请放大终端至 24×12</Text>
          <Text wrap="truncate">Ctrl+C 退出</Text>
        </Box>
      </LanguageContext.Provider>
    );
  return (
    <LanguageContext.Provider value={language}>
      <Box width={columns} height={rows - 1} flexDirection="column" overflow="hidden">
        <Welcome state={state} columns={columns} compact={compact} />
        <Box paddingX={1} marginTop={1} height={1} flexShrink={0} overflow="hidden">
          {VIEWS.slice(firstTab).map(([id, label]) => (
            <HitBox
              key={id}
              paddingRight={2}
              width={displayWidth(translate(label, language)) + (view === id ? 4 : 2)}
              flexShrink={0}
              height={1}
              onPress={() => {
                if (!prompt && !editing && !state.busy) void operation(() => go(id));
              }}
            >
              <Text color={view === id ? ACCENT : MUTED} bold={view === id} wrap="truncate">
                {view === id ? "▸ " : ""}
                {label}
              </Text>
            </HitBox>
          ))}
        </Box>
        <Box height={bodyHeight} flexShrink={0} overflow="hidden">
          <Box width={mainColumns} flexDirection="column" height={bodyHeight} overflow="hidden">
            {editing && (
              <Box display={promptTitle ? "none" : "flex"}>
                <FieldEditor
                  field={editing.field}
                  language={language}
                  width={mainColumns}
                  height={bodyHeight}
                  active={!prompt}
                  onSave={editing.save}
                  onCancel={() => setEditing(undefined)}
                />
              </Box>
            )}
            {promptTitle ? (
              <Box flexDirection="column" paddingX={1}>
                <Text color={AMBER} bold>
                  {clean(promptTitle)}
                </Text>
                {prompt?.kind === "confirm" && (
                  <Box height={1}>
                    <HitBox onPress={() => answerPrompt(true)} paddingRight={5}>
                      <Text color={input !== "n" ? GREEN : MUTED}>
                        {input !== "n" ? "❯" : " "} 确认执行 [y]
                      </Text>
                    </HitBox>
                    <HitBox onPress={() => answerPrompt(false)}>
                      <Text color={input === "n" ? ACCENT : MUTED}>
                        {input === "n" ? "❯" : " "} 取消 [n]
                      </Text>
                    </HitBox>
                  </Box>
                )}
                {prompt?.detail && (
                  <ScrollText
                    key={prompt.id || prompt.title}
                    value={terminalText(prompt.detail)}
                    width={mainColumns - 2}
                    height={Math.max(1, bodyHeight - 2)}
                  />
                )}
                {secret && <Text color={MUTED}>凭据仅在本次进程中使用。</Text>}
              </Box>
            ) : editing ? null : state.installation && (state.busy || installationVisible) ? (
              <InstallationPanel
                progress={state.installation}
                language={language}
                title={state.busy || state.activity.at(-1)?.title}
                failed={!!latestError}
                columns={mainColumns}
                height={bodyHeight}
                tick={tick}
              />
            ) : view === "home" ? (
              <HitBox
                height={bodyHeight}
                onWheel={(delta) =>
                  setActivityOffset((n) =>
                    Math.max(0, Math.min(Math.max(0, state.activity.length - 1), n - delta))
                  )
                }
              >
                <Home
                  state={state}
                  height={bodyHeight}
                  columns={mainColumns}
                  offset={activityOffset}
                />
              </HitBox>
            ) : listing ? (
              <ChoiceList
                title={
                  view === "scheduler"
                    ? currentSchedule?.event_name || "调度设置"
                    : view === "config"
                      ? sections.find((section) => section.id === configSection)?.label ||
                        "配置分类"
                      : view === "language"
                        ? "选择语言"
                        : view === "setup"
                          ? "选择运行方式"
                          : view === "tasks"
                            ? "任务列表 · Enter 运行"
                            : view === "profiles"
                              ? "配置档 · Enter 切换"
                              : view === "packs"
                                ? "指令包 · Enter 执行"
                                : "配置 · Enter 编辑"
                }
                items={choices}
                selected={selectedIndex}
                height={bodyHeight}
                columns={mainColumns}
                onChoose={(index) => {
                  if (!state.busy) void operation(() => choose(index));
                }}
                onScroll={(delta) =>
                  setSelected((n) => Math.max(0, Math.min(choices.length - 1, n + delta)))
                }
                empty={
                  !state.connected && !["packs", "language", "setup"].includes(view)
                    ? "尚未连接 · /connect"
                    : view === "tasks" && !state.profile
                      ? "请先 /profiles 选择配置档"
                      : view === "profiles" && !Object.keys(state.profiles).length
                        ? "还没有配置档 · /new-profile 创建"
                        : "没有匹配项"
                }
              />
            ) : view === "logs" ? (
              <LogPanel
                state={state}
                height={bodyHeight}
                columns={mainColumns}
                offset={logOffset}
                onScroll={(delta) =>
                  setLogOffset((n) =>
                    Math.max(0, Math.min(Math.max(0, state.logs.length - 1), n + delta))
                  )
                }
              />
            ) : (
              <Box flexDirection="column" paddingX={1}>
                <Text bold color={ACCENT}>
                  baasx 操作指南
                </Text>
                <Text>/connect → /profiles → /tasks</Text>
                <Text>/run mail · /start · /stop · /logs</Text>
                <Text>/config · /packs · /devices · /quit</Text>
                <Text color={MUTED}>↑↓ 选择 · Enter 确认 · Esc 返回 · Shift+Tab 切换页</Text>
                <Text color={MUTED}>Ctrl+T 任务 · Ctrl+P 配置档 · Ctrl+L 日志</Text>
                <Text color={MUTED}>Ctrl+C 取消当前操作；空闲时退出</Text>
              </Box>
            )}
          </Box>
          {splitLog && (
            <Box
              borderStyle="single"
              borderColor={MUTED}
              borderTop={false}
              borderRight={false}
              borderBottom={false}
              width={columns - mainColumns}
            >
              <LogPanel
                state={state}
                height={bodyHeight}
                columns={columns - mainColumns - 1}
                offset={logOffset}
                onScroll={(delta) =>
                  setLogOffset((n) =>
                    Math.max(0, Math.min(Math.max(0, state.logs.length - 1), n + delta))
                  )
                }
              />
            </Box>
          )}
        </Box>
        <Box height={1} paddingX={1} flexShrink={0}>
          <Marquee
            color={
              notice || latestError
                ? RED
                : state.busy
                  ? AMBER
                  : state.activity.at(-1)?.tone === "success"
                    ? GREEN
                    : MUTED
            }
            width={columns - 2}
            value={translate(
              notice ||
                (!state.busy && latestError
                  ? `${latestError.title} · ${latestError.detail || ""}`
                  : "") ||
                (state.busy
                  ? `${["✦", "✧", "⋆", "✧"][tick % 4]} ${clean(state.busy)} · Esc 取消`
                  : activeTask
                    ? `● ${clean(activeTask)} · /logs 查看运行详情`
                    : state.activity.at(-1)
                      ? `${state.activity.at(-1)!.title} · ${clean(state.activity.at(-1)!.detail || "")}`
                      : state.demo
                        ? "DEMO · 所有操作仅作用于内存演示"
                        : state.readOnly
                          ? "只读模式 · 可浏览与监控"
                          : state.dryRun
                            ? "预览模式 · 修改不会提交"
                            : ""),
              language
            )}
          />
        </Box>
        {showCommandInput && (
          <Box
            borderStyle="single"
            borderColor={prompt ? AMBER : MUTED}
            borderLeft={false}
            borderRight={false}
            height={3}
            flexShrink={0}
            paddingX={1}
          >
            <Text color={ACCENT}>❯ </Text>
            <Box width={columns - 4} flexDirection="column">
              {!input && !prompt && !editing ? (
                <Text wrap="truncate">
                  <Text inverse> </Text>
                  <Text color={MUTED}>{truncateText(placeholder, columns - 6)}</Text>
                </Text>
              ) : (
                <Text wrap="truncate">
                  {before}
                  <Text inverse>{parts[cursor] || " "}</Text>
                  {after}
                </Text>
              )}
            </Box>
          </Box>
        )}
        {suggestions.length ? (
          <Box flexDirection="column" paddingX={1}>
            {suggestions
              .slice(Math.max(0, suggestionIndex - 4), Math.max(0, suggestionIndex - 4) + 5)
              .map((item) => (
                <HitBox
                  key={item.id}
                  height={1}
                  onPress={() => void operation(() => submitCommand(item.label))}
                >
                  <Text
                    color={item.id === suggestions[suggestionIndex]?.id ? ACCENT : MUTED}
                    backgroundColor={
                      item.id === suggestions[suggestionIndex]?.id ? SELECTED : undefined
                    }
                    wrap="truncate"
                  >
                    {item.id === suggestions[suggestionIndex]?.id ? "❯" : " "}{" "}
                    {pad(item.label, Math.min(22, Math.floor(columns * 0.4)))}{" "}
                    {translate(clean(item.detail), language)}
                  </Text>
                </HitBox>
              ))}
            <Text color={MUTED} wrap="truncate">
              ↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 清空
            </Text>
          </Box>
        ) : (
          <Box paddingX={1}>
            <Text color={MUTED} wrap="truncate">
              {prompt
                ? "Enter 确认 · Esc 取消"
                : state.busy
                  ? "Esc 取消"
                  : editing
                    ? "Esc 返回"
                    : `${listing ? "↑↓ 选择 · Enter 打开" : "/ 命令 · ? 帮助"} · Shift+Tab 切换 · ${clean(state.profiles[state.profile || ""] || state.profile || "未选择配置档")}`}
            </Text>
          </Box>
        )}
      </Box>
    </LanguageContext.Provider>
  );
}

export async function launchWorkspace(options: WorkspaceOptions & { noColor?: boolean }) {
  if (options.noColor || process.env.NO_COLOR !== undefined) process.env.FORCE_COLOR = "0";
  chalk.level =
    options.noColor || process.env.NO_COLOR !== undefined ? 0 : process.stdout.isTTY ? 3 : 0;
  const workspace = await Workspace.create(options);
  const mouse = new MouseBus();
  mouse.setMaxListeners(200);
  const terminal = terminalSession(process.stdin, process.stdout, mouse);
  const restore = () => terminal.close();
  process.once("exit", restore);
  const app = render(
    <MouseContext.Provider value={mouse}>
      <WorkspaceView workspace={workspace} />
    </MouseContext.Provider>,
    { stdin: terminal.input, exitOnCtrlC: false, maxFps: 20 }
  );
  const stop = () => {
    workspace.close();
    app.unmount();
  };
  process.once("SIGTERM", stop);
  try {
    // First-run setup pauses here; configured local and explicit remote modes initialize themselves.
    void workspace.initialize();
    await app.waitUntilExit();
  } finally {
    process.removeListener("SIGTERM", stop);
    workspace.close();
    app.unmount();
    terminal.close();
    process.removeListener("exit", restore);
  }
}
