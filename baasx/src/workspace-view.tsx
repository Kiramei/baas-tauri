import chalk from "chalk";
import { InstallationPanel } from "./installation-view";
import { FieldEditor, type EditableField } from "./field-editor";
import {
  configurationFields,
  configurationSections,
  configurationText,
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
import { MouseBus, terminalSession, terminalViewport } from "./terminal";
import {
  ActivityText,
  ColumnDivider,
  HitBox,
  Marquee,
  MouseContext,
  ScrollText,
  wrapTerminalText,
} from "./terminal-components";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Text as InkText, render, useApp, useInput, useStdin, useStdout } from "ink";
import { isRuntimeOperation, Workspace, type WorkspaceOptions } from "./workspace";
import { displayWidth, terminalText, truncateText } from "./ui";
import manifest from "../package.json";
import { translate, LANGUAGES } from "./i18n";
import { ONE_OFF_TASKS, isOneOffTask } from "./oneoff-tasks";
import { WorkbenchHelp } from "./workbench-help";

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
const NOTICE = "#a8b8ff";
const RED = "#f38b91";
const SELECTED = "#203f49";
const HOME_MARK = ["▄▄▄▄▄  ▄▄", "█   █▄▄▀▀", "█▄▄▄█  █ ", "  ▀▀▀▀▀▀ "];
const CONFIG_SHOPS = [
  {
    id: "common",
    labelKey: "commonShop.title",
    keys: ["CommonShopList", "CommonShopRefreshTime"],
  },
  {
    id: "tactical",
    labelKey: "tacticalShop.title",
    keys: ["TacticalChallengeShopList", "TacticalChallengeShopRefreshTime"],
  },
] as const;

type View =
  | "home"
  | "scheduler"
  | "tasks"
  | "oneoff"
  | "profiles"
  | "logs"
  | "config"
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
];
export const COMMANDS: Choice[] = [
  { id: "scheduler", label: "/scheduler", detail: "编辑任务调度" },
  { id: "update", label: "/update", detail: "检查并更新本地后端" },
  { id: "new-profile", label: "/new-profile", detail: "新建配置档" },
  { id: "language", label: "/language", detail: "选择语言" },
  { id: "install", label: "/install", detail: "安装本地环境" },
  { id: "uninstall", label: "/uninstall", detail: "卸载本地环境并保留数据" },
  { id: "clear", label: "/clear", detail: "清除当前显示" },
  { id: "local", label: "/local", detail: "启动本地后端" },
  { id: "run", label: "/run", detail: "选择并运行任务" },
  { id: "tasks", label: "/tasks", detail: "选择并运行任务" },
  { id: "oneoff", label: "/oneoff", detail: "一次性任务" },
  { id: "profiles", label: "/profiles", detail: "切换配置档" },
  { id: "start", label: "/start", detail: "启动当前配置档的调度" },
  { id: "stop", label: "/stop", detail: "停止当前运行" },
  { id: "logs", label: "/logs", detail: "查看实时运行日志" },
  { id: "config", label: "/config", detail: "浏览、搜索与修改配置" },
  { id: "connect", label: "/connect", detail: "连接 BAAS 服务" },
  { id: "status", label: "/status", detail: "刷新运行状态" },
  { id: "reload", label: "/reload", detail: "重新加载界面与连接" },
  { id: "packs", label: "/packs", detail: "查看独立指令包" },
  { id: "devices", label: "/devices", detail: "检测 ADB 设备" },
  { id: "doctor", label: "/doctor", detail: "检查服务连接" },
  { id: "home", label: "/home", detail: "返回工作台总览" },
  { id: "help", label: "/help", detail: "命令与键盘操作" },
  { id: "quit", label: "/quit", detail: "退出终端" },
];
const inputSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const chars = (text: string) => [...inputSegmenter.segment(text)].map((x) => x.segment);
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
  const stdout = terminalViewport(useStdout().stdout);
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
  minimal = false,
}: {
  state: Snapshot;
  columns: number;
  compact: boolean;
  minimal?: boolean;
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
  const infoWidth = compact ? columns - 2 : columns - 14;
  const info = (
    <>
      <Marquee
        value={`${label} · ${status}${state.demo ? " · DEMO" : ""}`}
        width={infoWidth}
        color={state.connected ? GREEN : NOTICE}
        motion={state.connecting && !state.prompt ? "requesting" : undefined}
      />
      <Marquee
        value={
          current?.running
            ? `${t("正在执行")} · ${clean(current.current_task || t("调度运行中"))} · ${t("队列")} ${summary?.waitingTasks.length || summary?.due || 0}`
            : `${t("调度")} · ${enabled.length}/${tasks.length} ${t("已启用")} · ${t("待执行")} ${summary?.due || 0}`
        }
        width={infoWidth}
        color={current?.running ? GREEN : MUTED}
        motion={
          current?.running && !state.prompt
            ? current.current_task
              ? "tool-use"
              : "thinking"
            : undefined
        }
      />
      <Marquee
        value={`${t("下次执行")} · ${next ? `${clean(next.event_name || next.func_name)} · ${nextTime}` : nextTime}`}
        width={infoWidth}
        color={MUTED}
      />
    </>
  );
  if (minimal)
    return (
      <Box paddingX={1} flexDirection="column" height={2} flexShrink={0}>
        <Text color="#ffffff" bold wrap="truncate">
          ▣ BAASX <Text color={MUTED}>· {label}</Text>
        </Text>
        <ActivityText
          value={`${status}${current?.current_task ? ` · ${clean(current.current_task)}` : ""}`}
          width={columns - 2}
          active={!state.prompt && (state.connecting || !!current?.running)}
          mode={state.connecting ? "requesting" : current?.current_task ? "tool-use" : "thinking"}
          color={state.connected ? GREEN : NOTICE}
        />
      </Box>
    );
  if (compact)
    return (
      <Box paddingX={1} flexDirection="column" height={4} flexShrink={0}>
        <Text color="#ffffff" bold>
          ▣ BAASX <Text color={MUTED}>v{manifest.version}</Text>
        </Text>
        {info}
      </Box>
    );
  return (
    <Box height={6} paddingY={1} paddingLeft={2} paddingRight={1} flexShrink={0}>
      <Box width={9} marginRight={2} flexDirection="column" flexShrink={0}>
        {HOME_MARK.map((line, index) => (
          <Text key={index} color={index < 2 ? "#43c4c9" : "#94e3e3"}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" width={infoWidth}>
        <Text color="#ffffff" bold wrap="truncate">
          BAASX <Text color={MUTED}>v{manifest.version}</Text>
        </Text>
        {info}
      </Box>
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
  const stacked = columns < 64 && height >= 6;
  const rowHeight = stacked ? 2 : 1;
  const limit = Math.max(0, Math.floor((height - 1) / rowHeight));
  const offset = Math.max(0, Math.min(selected - Math.floor(limit / 2), items.length - limit));
  const labelWidth = stacked ? columns - 4 : Math.min(32, Math.floor(columns * 0.42));
  return (
    <HitBox flexDirection="column" paddingX={1} height={height} onWheel={onScroll}>
      <Text bold color={ACCENT} wrap="truncate">
        {title} <Text color={MUTED}>{items.length ? `${selected + 1} / ${items.length}` : ""}</Text>
      </Text>
      {!items.length && height > 1 && <Text color={MUTED}>{empty}</Text>}
      {items.slice(offset, offset + limit).map((item, index) => {
        const focused = index + offset === selected;
        return (
          <HitBox
            key={item.id}
            height={rowHeight}
            flexDirection="column"
            flexShrink={0}
            onPress={() => onChoose?.(index + offset)}
          >
            <Box height={1} flexShrink={0}>
              <Text
                backgroundColor={focused ? SELECTED : undefined}
                color={focused ? ACCENT : MUTED}
              >
                {focused ? "❯ " : "  "}
              </Text>
              <Box width={labelWidth} flexShrink={0}>
                <Marquee
                  value={translate(clean(item.label), language)}
                  width={labelWidth}
                  color={focused ? ACCENT : undefined}
                  backgroundColor={focused ? SELECTED : undefined}
                  active={focused}
                />
              </Box>
              {!stacked && <Text> </Text>}
              {!stacked && (
                <Marquee
                  value={translate(clean(item.detail), language)}
                  width={Math.max(1, columns - labelWidth - 6)}
                  color={focused ? ACCENT : MUTED}
                  backgroundColor={focused ? SELECTED : undefined}
                  active={focused}
                />
              )}
            </Box>
            {stacked && (
              <Box paddingLeft={2} height={1} flexShrink={0}>
                <Marquee
                  value={translate(clean(item.detail), language)}
                  width={Math.max(1, columns - 4)}
                  active={focused}
                  color={MUTED}
                />
              </Box>
            )}
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
    limit = Math.max(0, height - 2);
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
      {height > 1 && (
        <Text color={MUTED} wrap="truncate">
          {offset ? "已暂停跟随 · 向下滚动恢复" : "● 实时跟随"}
        </Text>
      )}
      {entries.length ? (
        entries.map((entry, index) => {
          const level = String(entry.level).toUpperCase();
          const color = level.includes("ERROR")
            ? RED
            : level.includes("WARN")
              ? NOTICE
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
                active={index === entries.length - 1}
              />
            </Box>
          );
        })
      ) : height > 2 ? (
        <Text color={MUTED}>{translate("等待日志…", language)}</Text>
      ) : null}
    </HitBox>
  );
}

function Home({
  state,
  activity,
  height,
  columns,
  offset = 0,
}: {
  state: Snapshot;
  activity: Snapshot["activity"];
  height: number;
  columns: number;
  offset?: number;
}) {
  const current = state.status[state.profile || ""];
  const count = Math.max(0, Math.floor((height - 3) / 2));
  const rows = count
    ? activity.slice(
        Math.max(0, activity.length - offset - count),
        Math.max(0, activity.length - offset)
      )
    : [];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate">
        {state.profile ? clean(state.profiles[state.profile] || state.profile) : "开始使用"}
        <Text color={current?.running ? GREEN : MUTED}>
          {" "}
          {current?.running ? "● 运行中" : state.connected ? "○ 空闲" : "○ 等待连接"}
        </Text>
      </Text>
      {height > 1 && (
        <Text color={MUTED} wrap="truncate">
          {state.connected
            ? `${Object.keys(state.tasks).length} 项任务 · ${state.packs.length} 个指令 · /tasks 选择任务 · /logs 查看日志`
            : "/connect 连接服务 → /profiles 选择配置档 → /tasks 执行任务"}
        </Text>
      )}
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
  const [state, setState] = useState(() => workspace.snapshot);
  useEffect(() => workspace.subscribe(setState), [workspace]);
  return <WorkspaceScreen key={state.reloadRevision ?? 0} workspace={workspace} state={state} />;
}

function WorkspaceScreen({ workspace, state }: { workspace: Workspace; state: Snapshot }) {
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
  const [configuration, setConfiguration] = useState<{
    profile: string;
    data: Record<string, unknown>;
    staticData?: Record<string, unknown>;
  }>();
  const configRequest = useRef(0);
  const [afterProfile, setAfterProfile] = useState<View>();
  const [editing, setEditing] = useState<{
    field: EditableField;
    save: (value: unknown) => Promise<void>;
  }>();
  const [configSection, setConfigSection] = useState<string>();
  const [configShop, setConfigShop] = useState<string>();
  const [schedulerTask, setSchedulerTask] = useState<string>();
  const [notice, setNotice] = useState("");
  const [logOffset, setLogOffset] = useState(0);
  const [activityOffset, setActivityOffset] = useState(0);
  const [logVisible, setLogVisible] = useState(false);
  const [logSplit, setLogSplit] = useState(0.56);
  const [installationVisible, setInstallationVisible] = useState(false);
  const installationBusy = isRuntimeOperation(state.busy);
  const installationFailed = state.installation?.tasks.some((task) => task.status === "failed");
  const latestError = state.activity.at(-1)?.tone === "error" ? state.activity.at(-1) : undefined;
  const activity = state.activity.filter((item) => item.title !== "连接已建立");
  const latestActivity = state.activity.at(-1);
  const statusActivity = latestActivity?.title === "连接已建立" ? undefined : latestActivity;
  const prompt = state.prompt;
  const compact = columns < 64 || rows < 24;
  const language = state.language || "zh";
  const listing = [
    "scheduler",
    "tasks",
    "oneoff",
    "profiles",
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
  useLayoutEffect(() => {
    resetInput(prompt?.kind === "confirm" ? prompt.initial || "y" : prompt?.initial || "");
  }, [prompt?.id, prompt?.title, prompt?.kind]);
  useEffect(() => {
    if (state.connected && !state.busy && !installationFailed) {
      if (installationVisible) {
        setInstallationVisible(false);
        setView("home");
      }
    } else if (!state.installation) setInstallationVisible(false);
    else if (installationBusy) setInstallationVisible(true);
  }, [
    state.busy,
    state.connected,
    state.installation?.startedAt,
    installationBusy,
    installationFailed,
    installationVisible,
  ]);
  useEffect(() => {
    setConfigSection(undefined);
    setConfigShop(undefined);
    setSchedulerTask(undefined);
    setEditing(undefined);
    setSelected(0);
  }, [state.profile]);

  const taskChoices = Object.entries(state.tasks)
    .filter(([id]) => !isOneOffTask(id))
    .map(([id, task]) => ({
      id,
      label: String(task.event_name || task.name || task.display_name || id),
      detail: `${id} · ${translate(task.enabled === false || task.enable === false ? "未启用调度" : "已配置", language)}${task.next_tick ? ` · ${formatSchedulerField("next_tick", task.next_tick)}` : ""}`,
    }));
  const oneOffChoices = ONE_OFF_TASKS.map((task) => ({
    id: task.id,
    label: configurationText(task.labelKey, language),
    detail: task.id,
  }));
  // Build the desktop field model once per loaded configuration. Log/status
  // snapshots contain cloned catalogs and must not rebuild it on every frame.
  const sections = useMemo(
    () =>
      configuration && configuration.profile === state.profile
        ? configurationSections(configuration.data, {
            language,
            staticData: configuration.staticData,
          })
        : [],
    [configuration, state.profile, language]
  );
  const fields = useMemo(() => sections.flatMap((section) => section.fields), [sections]);
  const shopFor = (key: string) =>
    CONFIG_SHOPS.find((shop) => shop.keys.some((shopKey) => shopKey === key));
  const shops = CONFIG_SHOPS.flatMap((shop) => {
    const settings = fields.filter(
      (field) => field.section === "shop" && shopFor(field.key) === shop
    );
    return settings.length
      ? [
          {
            id: `shop:${shop.id}`,
            label: configurationText(shop.labelKey, language),
            detail: `${settings.length} ${translate("项设置", language)}`,
          },
        ]
      : [];
  });
  const searchingConfig = !!input && !input.startsWith("/");
  const configFields = fields
    .filter((field) => !configSection || field.section === configSection)
    .filter((field) => !configShop || shopFor(field.key)?.id === configShop)
    .map((field) => {
      const shop = shopFor(field.key);
      return {
        id: field.path,
        label: field.label,
        detail: [
          shop && !configShop ? configurationText(shop.labelKey, language) : "",
          formatConfigurationValue(field),
        ]
          .filter(Boolean)
          .join(" · "),
      };
    });
  const configItems: Choice[] =
    !configSection && !searchingConfig
      ? sections.map((section) => ({
          id: `section:${section.id}`,
          label: section.label,
          detail: `${section.fields.length} ${translate("项设置", language)}`,
        }))
      : configSection === "shop" && !configShop
        ? searchingConfig
          ? [...shops, ...configFields]
          : shops
        : configFields;
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
            : view === "oneoff"
              ? oneOffChoices
              : view === "profiles"
                ? Object.entries(state.profiles).map(([id, label]) => ({
                    id,
                    label,
                    detail: `${id}${id === state.profile ? " · 当前" : ""}${state.status[id]?.running ? " · 运行中" : ""}`,
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
              ? [...taskChoices, ...oneOffChoices]
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
  const headerRows = rows < 20 ? 2 : compact ? 4 : 6;
  const contentGap = view === "home" ? 0 : 1;
  const showCommandInput = (!editing && !state.busy) || !!prompt;
  // Reserve a body row, the status line and keyboard hint before sizing the
  // command menu. Otherwise small terminals hide the command Enter will run.
  const suggestionLimit = Math.max(
    1,
    Math.min(5, rows - headerRows - 1 - contentGap - (showCommandInput ? 3 : 0) - 3)
  );
  const suggestionStart = Math.max(0, suggestionIndex - suggestionLimit + 1);
  const footerRows = suggestions.length ? Math.min(suggestionLimit, suggestions.length) + 1 : 1;
  const splitLog =
    logVisible &&
    columns >= 110 &&
    view !== "logs" &&
    !prompt &&
    !editing &&
    !state.busy &&
    !installationVisible;
  // Keep the ratio across window resizes while leaving both panes usable.
  const mainColumns = splitLog
    ? Math.max(40, Math.min(columns - 31, Math.round((columns - 1) * logSplit)))
    : columns;
  const bodyHeight = Math.max(
    1,
    rows - headerRows - 1 - contentGap - (showCommandInput ? 3 : 0) - footerRows - 1
  );
  const homeTopPadding = bodyHeight >= 16 ? 1 : 0;
  const promptDetailHeight = Math.max(
    1,
    Math.min(
      bodyHeight - (prompt?.kind === "confirm" ? 2 : 1) - (secret ? 1 : 0),
      wrapTerminalText(prompt?.detail || "", Math.max(1, mainColumns - 2)).length
    )
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
    const request = ++configRequest.current;
    setAfterProfile(undefined);
    setInstallationVisible(false);
    setView(next);
    resetInput();
    setLogOffset(0);
    if (
      ["scheduler", "tasks", "oneoff", "profiles", "logs", "config"].includes(next) &&
      !workspace.snapshot.connected
    )
      await workspace.connect();
    if (next === "oneoff" && !workspace.snapshot.profile) {
      setAfterProfile("oneoff");
      setView("profiles");
      return;
    }
    if (next === "scheduler") {
      setSchedulerTask(undefined);
      await workspace.loadScheduler();
    }
    if (next === "config") {
      setConfigSection(undefined);
      setConfigShop(undefined);
      const profile = workspace.snapshot.profile;
      if (!profile) {
        // First-run connections deliberately have no implicit profile. Keep
        // the requested destination while the user chooses one.
        setAfterProfile("config");
        setView("profiles");
        return;
      }
      const data = await workspace.getConfig();
      const current = workspace.snapshot;
      if (data && request === configRequest.current && current.profile === profile)
        setConfiguration({ profile, data, staticData: current.staticData });
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
    if (command === "clear") {
      workspace.clearScreen();
      setLogOffset(0);
      return;
    }
    if (command === "home") {
      setView("home");
      return;
    }
    if (command === "help" || command === "?") {
      setView("help");
      return;
    }
    if (
      ["scheduler", "tasks", "oneoff", "profiles", "logs", "config", "language", "setup"].includes(
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
      if (workspace.snapshot.profile !== item.id) return;
      if (afterProfile) await go(afterProfile);
      else setView("home");
    }
    if (view === "tasks" || view === "oneoff") {
      setLogVisible(true);
      setLogOffset(0);
      setView(columns >= 110 ? "home" : "logs");
      await workspace.run(item.id);
    }
    if (view === "config") {
      if (item.id.startsWith("section:")) {
        setConfigSection(item.id.slice(8));
        setConfigShop(undefined);
        return;
      }
      if (item.id.startsWith("shop:")) {
        setConfigShop(item.id.slice(5));
        return;
      }
      const field = fields.find((field) => field.path === item.id);
      if (!field) return;
      if (field.readOnly) {
        setNotice(translate("此项由客户端管理", language));
        return;
      }
      const shop = field.section === "shop" ? shopFor(field.key) : undefined;
      if (shop) {
        setConfigSection("shop");
        setConfigShop(shop.id);
      }
      setEditing({
        field,
        save: async (value) => {
          const parsed = parseConfigurationValue(field, value);
          requireSaved(await workspace.setConfig(field.path, parsed));
          const profile = workspace.snapshot.profile;
          const next = await workspace.getConfig();
          const current = workspace.snapshot;
          if (next && profile && current.profile === profile)
            setConfiguration({ profile, data: next, staticData: current.staticData });
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
      if (!prompt && !state.busy && key.ctrl && text === "r") {
        void operation(() => workspace.reload());
        return;
      }
      // The typed editor owns other keys; reload remains a whole-interface action.
      if (editing && !prompt) return;
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
          if (configShop) setConfigShop(undefined);
          else setConfigSection(undefined);
          setSelected(0);
          return;
        }
        if (!prompt && !state.busy && !input && view === "scheduler" && schedulerTask) {
          setSchedulerTask(undefined);
          setSelected(0);
          return;
        }
        if (!prompt && !state.busy && !input && view === "oneoff") {
          setView("tasks");
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
        const index = VIEWS.findIndex(([id]) => id === (view === "oneoff" ? "tasks" : view));
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
          setActivityOffset((n) => Math.max(0, Math.min(activity.length - 1, n - delta)));
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
    { isActive: true }
  );

  const promptTitle = prompt?.title || "";
  const navView = view === "oneoff" ? "tasks" : view;
  const tabWidth = ([id, label]: [View, string]) =>
    displayWidth(translate(label, language)) + (navView === id ? 4 : 2);
  const currentTab = Math.max(
    0,
    VIEWS.findIndex(([id]) => id === navView)
  );
  let firstTab = 0;
  while (
    firstTab < currentTab &&
    VIEWS.slice(firstTab, currentTab + 1).reduce((sum, tab) => sum + tabWidth(tab), 0) > columns - 2
  )
    firstTab++;
  let lastTab = firstTab;
  let visibleTabWidth = 0;
  while (lastTab < VIEWS.length && visibleTabWidth + tabWidth(VIEWS[lastTab]) <= columns - 2) {
    visibleTabWidth += tabWidth(VIEWS[lastTab]);
    lastTab++;
  }
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
  const currentStatus = state.status[state.profile || ""];
  const activeTask = currentStatus?.running ? currentStatus.current_task : undefined;
  if (columns < 24 || rows < 12)
    return (
      <LanguageContext.Provider value={language}>
        <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
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
      <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
        <Welcome state={state} columns={columns} compact={compact} minimal={rows < 20} />
        <Box paddingX={1} height={1} flexShrink={0} overflow="hidden">
          {VIEWS.slice(firstTab, lastTab).map(([id, label]) => (
            <HitBox
              key={id}
              paddingRight={2}
              width={displayWidth(translate(label, language)) + (navView === id ? 4 : 2)}
              flexShrink={0}
              height={1}
              onPress={() => {
                if (!prompt && !editing && !state.busy) void operation(() => go(id));
              }}
            >
              <Text
                color={navView === id ? ACCENT : MUTED}
                backgroundColor={navView === id ? SELECTED : undefined}
                bold={navView === id}
                wrap="truncate"
              >
                {navView === id ? "▸ " : ""}
                {label}
              </Text>
            </HitBox>
          ))}
        </Box>
        {contentGap > 0 && <Box height={contentGap} flexShrink={0} />}
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
              <Box
                flexDirection="column"
                paddingX={1}
                height={bodyHeight}
                justifyContent="flex-end"
              >
                <Text color={NOTICE} bold wrap="truncate">
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
                    height={promptDetailHeight}
                  />
                )}
                {secret && <Text color={MUTED}>凭据仅在本次进程中使用。</Text>}
              </Box>
            ) : editing ? null : state.installation && (installationBusy || installationVisible) ? (
              <InstallationPanel
                progress={state.installation}
                language={language}
                title={state.busy || state.activity.at(-1)?.title}
                failed={!!latestError}
                columns={mainColumns}
                height={bodyHeight}
              />
            ) : view === "home" ? (
              <HitBox
                height={bodyHeight}
                paddingTop={homeTopPadding}
                onWheel={(delta) =>
                  setActivityOffset((n) =>
                    Math.max(0, Math.min(Math.max(0, activity.length - 1), n - delta))
                  )
                }
              >
                <Home
                  state={state}
                  activity={activity}
                  height={bodyHeight - homeTopPadding}
                  columns={mainColumns}
                  offset={activityOffset}
                />
              </HitBox>
            ) : listing ? (
              <>
                {(view === "tasks" || view === "oneoff") && (
                  <Box height={1} paddingX={1} flexShrink={0}>
                    {(
                      [
                        ["tasks", "日常任务"],
                        ["oneoff", "一次性任务"],
                      ] as const
                    ).map(([id, label]) => (
                      <HitBox
                        key={id}
                        paddingRight={3}
                        onPress={() => {
                          if (!state.busy) void operation(() => go(id));
                        }}
                      >
                        <Text color={view === id ? ACCENT : MUTED} bold={view === id}>
                          {view === id ? "▸ " : ""}
                          {label}
                        </Text>
                      </HitBox>
                    ))}
                  </Box>
                )}
                <ChoiceList
                  title={
                    view === "scheduler"
                      ? currentSchedule?.event_name || "调度设置"
                      : view === "config"
                        ? configSection === "shop"
                          ? `${sections.find((section) => section.id === "shop")?.label} · ${
                              configShop
                                ? configurationText(
                                    CONFIG_SHOPS.find((shop) => shop.id === configShop)!.labelKey,
                                    language
                                  )
                                : translate("选择商店", language)
                            }`
                          : sections.find((section) => section.id === configSection)?.label ||
                            "配置分类"
                        : view === "language"
                          ? "选择语言"
                          : view === "setup"
                            ? "选择运行方式"
                            : view === "tasks"
                              ? "任务列表 · Enter 运行"
                              : view === "oneoff"
                                ? "一次性任务 · Enter 运行"
                                : view === "profiles"
                                  ? "配置档 · Enter 切换"
                                  : "配置 · Enter 编辑"
                  }
                  items={choices}
                  selected={selectedIndex}
                  height={
                    view === "tasks" || view === "oneoff" ? Math.max(1, bodyHeight - 1) : bodyHeight
                  }
                  columns={mainColumns}
                  onChoose={(index) => {
                    if (!state.busy) void operation(() => choose(index));
                  }}
                  onScroll={(delta) =>
                    setSelected((n) => Math.max(0, Math.min(choices.length - 1, n + delta)))
                  }
                  empty={
                    !state.connected && !["language", "setup"].includes(view)
                      ? "尚未连接 · /connect"
                      : (view === "tasks" || view === "oneoff") && !state.profile
                        ? "请先 /profiles 选择配置档"
                        : view === "profiles" && !Object.keys(state.profiles).length
                          ? "还没有配置档 · /new-profile 创建"
                          : "没有匹配项"
                  }
                />
              </>
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
              <WorkbenchHelp
                commands={COMMANDS}
                language={language}
                width={mainColumns}
                height={bodyHeight}
                active={!prompt && !state.busy}
              />
            )}
          </Box>
          {splitLog && (
            <>
              <ColumnDivider
                height={bodyHeight}
                onResize={(column) =>
                  setLogSplit(Math.max(40, Math.min(columns - 31, column)) / (columns - 1))
                }
              />
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
            </>
          )}
        </Box>
        <Box height={1} paddingX={1} flexShrink={0}>
          <ActivityText
            active={
              !prompt && !notice && !!(state.busy || activeTask) && !(!state.busy && latestError)
            }
            mode={state.connecting ? "requesting" : "tool-use"}
            color={
              notice || (!state.busy && latestError)
                ? RED
                : state.busy
                  ? NOTICE
                  : statusActivity?.tone === "success"
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
                  ? `${clean(state.busy)} · Esc 取消`
                  : activeTask
                    ? `${clean(activeTask)} · /logs 查看运行详情`
                    : statusActivity
                      ? `${statusActivity.title} · ${clean(statusActivity.detail || "")}`
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
            borderColor={prompt ? NOTICE : MUTED}
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
            {suggestions.slice(suggestionStart, suggestionStart + suggestionLimit).map((item) => (
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
                  {truncateText(
                    `${item.id === suggestions[suggestionIndex]?.id ? "❯" : " "} ${pad(item.label, Math.min(22, Math.max(12, Math.floor(columns * 0.4))))} ${translate(clean(item.detail), language)}`,
                    columns - 2
                  )}
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
                    : `${listing ? "↑↓ 选择 · Enter 打开" : "/ 命令 · ? 帮助"} · Ctrl+R 重载界面 · Shift+Tab 切换 · ${clean(state.profiles[state.profile || ""] || state.profile || "未选择配置档")}`}
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
    { stdin: terminal.input, stdout: terminal.output, exitOnCtrlC: false, maxFps: 20 }
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
