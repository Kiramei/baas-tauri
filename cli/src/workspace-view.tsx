import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Box, Text as InkText, render, useApp, useInput, useStdin, useStdout } from "ink";
import { Workspace, type WorkspaceOptions } from "./workspace";
import { displayWidth, terminalText, truncateText } from "./ui";
import manifest from "../package.json";
import { isSensitiveField, REDACTED } from "./redaction";
import { translate, LANGUAGES } from "./i18n";

const LanguageContext = createContext("zh");
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
function installationStage(stage: string): string {
  if (stage === "main-repository") return "同步后端";
  if (stage === "cpp-repository") return "下载 OCR 组件";
  if (["uv-install", "uv-python-install", "uv-venv", "cpython-source-ranking"].includes(stage))
    return "准备 Python 环境";
  if (["uv-compile", "uv-sync", "pypi-source-ranking", "uv-cache-clean"].includes(stage))
    return "安装依赖";
  if (["launch", "backend", "ready"].includes(stage)) return "启动本地后端";
  if (stage === "complete") return "安装完成";
  return "检查环境";
}
type View =
  | "home"
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
  ["profiles", "配置档"],
  ["logs", "日志"],
  ["config", "配置"],
  ["packs", "指令包"],
];
export const COMMANDS: Choice[] = [
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
export function configChoices(config: Record<string, unknown>): Choice[] {
  const result: Choice[] = [];
  function visit(value: unknown, path: string, depth: number) {
    if (result.length >= 2000 || depth > 20) return;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value))
        visit(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1);
    } else result.push({ id: path, label: path, detail: JSON.stringify(value) ?? "null" });
  }
  visit(config, "", 0);
  return result;
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
  const label = state.profiles[state.profile || ""] || state.profile || "尚未选择配置档";
  const current = state.status[state.profile || ""];
  const status = state.connecting ? "连接中" : state.connected ? "已连接" : "未连接";
  const color = state.connected ? GREEN : AMBER;
  const onboarding = state.chooseLanguage || state.setupNeeded;
  if (compact)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={ACCENT} wrap="truncate">
          ◈ BAAS <Text color={MUTED}>v{manifest.version} · 夏莱工作台</Text>
        </Text>
        <Text wrap="truncate">
          <Text color={color}>● {status}</Text> {clean(label)}
          {state.demo ? " · DEMO" : ""}
        </Text>
        <Text color={MUTED} wrap="truncate">
          {clean(state.endpoint)}
        </Text>
      </Box>
    );
  const leftWidth = Math.min(38, Math.floor(columns * 0.4));
  const recent = state.activity.slice(-2);
  const heading = `╭─ BAAS v${manifest.version} `;
  return (
    <Box flexDirection="column">
      <Text color={ACCENT}>
        ╭─ BAAS <Text color={MUTED}>v{manifest.version}</Text>
        {" " + "─".repeat(Math.max(0, columns - displayWidth(heading) - 1))}╮
      </Text>
      <Box
        borderStyle="single"
        borderColor={ACCENT}
        borderTop={false}
        borderBottom={false}
        height={10}
      >
        <Box
          width={leftWidth}
          flexShrink={0}
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          paddingX={1}
        >
          <Text bold wrap="truncate">
            欢迎回来，老师。
          </Text>
          <Text color={ACCENT}>{"    ▄▄▄▄▄    "}</Text>
          <Text color={ACCENT}>{"   ▀     ▀   "}</Text>
          <Text color={ACCENT}>{" ▐██ ▄ ▄ ██▌ "}</Text>
          <Text color={ACCENT}>{"  ▀███████▀  "}</Text>
          <Text color={ACCENT}>{"   ▀▀   ▀▀   "}</Text>
          <Text wrap="truncate">{clean(label)}</Text>
          <Text color={color} wrap="truncate">
            ● {status} <Text color={MUTED}>{state.demo ? "演示环境" : "BAAS SERVICE"}</Text>
          </Text>
          <Text color={MUTED} wrap="truncate">
            {clean(state.endpoint)}
          </Text>
        </Box>
        <Box
          flexGrow={1}
          flexDirection="column"
          paddingX={2}
          borderStyle="single"
          borderColor={MUTED}
          borderRight={false}
          borderTop={false}
          borderBottom={false}
        >
          <Text bold color={ACCENT} wrap="truncate">
            {onboarding ? "首次设置" : "今日的事务，交给 BAAS。"}
          </Text>
          {onboarding ? (
            <>
              <Text>选择语言</Text>
              <Text>安装本地环境</Text>
              <Text>选择配置档</Text>
            </>
          ) : (
            <>
              <Text wrap="truncate">
                <Text color={ACCENT}>/tasks</Text> 浏览任务，选择后直接运行
              </Text>
              <Text wrap="truncate">
                <Text color={ACCENT}>/profiles</Text> 切换配置档与服务器
              </Text>
              <Text wrap="truncate">
                <Text color={ACCENT}>/start</Text> 按已有配置启动日常调度
              </Text>
            </>
          )}
          <Text color={MUTED}>{"─".repeat(Math.max(0, columns - leftWidth - 7))}</Text>
          <Text bold color={ACCENT}>
            {current?.running ? "正在执行" : "最近动态"}
          </Text>
          {current?.running && (
            <Text color={GREEN} wrap="truncate">
              ● {clean(current.current_task || "调度运行中")}
            </Text>
          )}
          {recent.length ? (
            recent.map((item) => (
              <Text key={item.id} color={item.tone === "error" ? RED : MUTED} wrap="truncate">
                {clean(item.title)}
              </Text>
            ))
          ) : (
            <Text color={MUTED}>还没有运行记录。输入 / 查看可用操作。</Text>
          )}
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
}: {
  items: Choice[];
  selected: number;
  height: number;
  columns: number;
  title: string;
  empty: string;
}) {
  const language = useContext(LanguageContext);
  const limit = Math.max(1, height - 2);
  const offset = Math.max(0, Math.min(selected - Math.floor(limit / 2), items.length - limit));
  const labelWidth = Math.min(32, Math.floor(columns * 0.4));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={ACCENT}>
        {title} <Text color={MUTED}>{items.length ? `${selected + 1} / ${items.length}` : ""}</Text>
      </Text>
      {!items.length && <Text color={MUTED}>{empty}</Text>}
      {items.slice(offset, offset + limit).map((item, index) => {
        const focused = index + offset === selected;
        return (
          <Text
            key={item.id}
            backgroundColor={focused ? SELECTED : undefined}
            color={focused ? ACCENT : undefined}
          >
            {truncateText(
              `${focused ? "❯" : " "} ${pad(translate(clean(item.label), language), labelWidth)}  ${translate(clean(item.detail), language)}`,
              columns - 3
            )}
          </Text>
        );
      })}
    </Box>
  );
}

function Home({ state, height, columns }: { state: Snapshot; height: number; columns: number }) {
  const current = state.status[state.profile || ""];
  const count = Math.max(0, Math.floor((height - 3) / 2));
  const rows = count ? state.activity.slice(-count) : [];
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
  const [editing, setEditing] = useState<Choice>();
  const [notice, setNotice] = useState("");
  const [logOffset, setLogOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const latestError = state.activity.at(-1)?.tone === "error" ? state.activity.at(-1) : undefined;
  const prompt = state.prompt;
  const compact = columns < 74 || rows < 32;
  const language = state.language || "zh";
  const listing = ["tasks", "profiles", "packs", "config", "language", "setup"].includes(view);
  const secret =
    prompt?.kind === "secret" ||
    Boolean(
      editing && (editing.detail.includes(REDACTED) || editing.id.split("/").some(isSensitiveField))
    );
  const resetInput = (value = "", sensitive = false) => {
    setInput(value);
    setInputSensitive(sensitive);
    setCursor(chars(value).length);
    setSelected(0);
    setSuggested(0);
    setNotice("");
  };
  useEffect(() => workspace.subscribe((snapshot) => setState(snapshot)), [workspace]);
  useEffect(() => {
    if (state.busy || Object.values(state.status).some((item) => item.running)) {
      const timer = setInterval(() => setTick((n) => n + 1), 120);
      return () => clearInterval(timer);
    }
  }, [state.busy, state.status]);
  useEffect(() => {
    resetInput(prompt?.initial || "");
  }, [prompt?.id, prompt?.title, prompt?.kind]);
  useEffect(() => {
    setConfig({});
    setEditing(undefined);
    setSelected(0);
  }, [state.profile]);

  const taskChoices = Object.entries(state.tasks).map(([id, task]) => ({
    id,
    label: String(task.event_name || task.name || task.display_name || id),
    detail: `${id} · ${task.enabled === false || task.enable === false ? "未启用调度" : "已配置"}${task.next_tick ? ` · ${task.next_tick}` : ""}`,
  }));
  const baseChoices: Choice[] =
    view === "language"
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
              ? state.packs.map((p) => ({ id: p.name, label: `/${p.name}`, detail: p.description }))
              : view === "config"
                ? configChoices(config)
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
  const bodyHeight = Math.max(1, rows - 1 - (compact ? 3 : 12) - 2 - 3 - footerRows - 1);
  const operation = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      setNotice(clean((error as Error).message));
    }
  };
  const go = async (next: View) => {
    setView(next);
    resetInput();
    setLogOffset(0);
    if (["tasks", "profiles", "logs", "config"].includes(next) && !workspace.snapshot.connected)
      await workspace.connect();
    if (next === "config" && workspace.snapshot.profile) {
      const data = await workspace.getConfig();
      if (data) setConfig(data);
    }
  };
  const submitCommand = async (line: string) => {
    const command = line.trim().replace(/^\//, "");
    if (!command) return;
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
    if (["tasks", "profiles", "logs", "config", "packs", "language", "setup"].includes(command)) {
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
    setView("home");
    await workspace.execute(command);
  };
  const choose = async () => {
    const item = choices[selectedIndex];
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
      setView("home");
      await workspace.run(item.id);
    }
    if (view === "packs") {
      setView("home");
      await workspace.execute(`pack ${item.id}`);
    }
    if (view === "config") {
      setEditing(item);
      resetInput(
        item.detail.includes(REDACTED) ? "" : item.detail,
        item.detail.includes(REDACTED) || item.id.split("/").some(isSensitiveField)
      );
    }
  };
  useInput((text, key) => {
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
      if (prompt || state.busy) workspace.cancel();
      else if (editing) setEditing(undefined);
      else if (!input) setView("home");
      resetInput();
      return;
    }
    if (state.busy && !prompt) return;
    if (prompt?.kind === "confirm") {
      if (key.return) workspace.answerPrompt(input.toLowerCase() === "y");
      else if (text.toLowerCase() === "y" || text.toLowerCase() === "n")
        resetInput(text.toLowerCase());
      else if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)
        resetInput(input === "y" ? "n" : "y");
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
      else if (view === "logs" && !prompt)
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
      if (view === "logs") setLogOffset((n) => Math.max(0, Math.min(state.logs.length, n - delta)));
      else setSelected((n) => Math.max(0, Math.min(choices.length - 1, n + delta)));
      return;
    }
    if (key.return) {
      if (prompt) {
        workspace.answerPrompt(input);
        resetInput();
        return;
      }
      if (editing) {
        let value: unknown;
        try {
          value = JSON.parse(input);
        } catch {
          setNotice('请输入有效 JSON，例如 true、42 或 "文本"');
          return;
        }
        const path = editing.id;
        setEditing(undefined);
        resetInput();
        void operation(async () => {
          await workspace.setConfig(path, value);
          const data = await workspace.getConfig();
          if (data) setConfig(data);
        });
        return;
      }
      if (suggestions.length) {
        void operation(() => submitCommand(suggestions[suggestionIndex].label));
        return;
      }
      if (listing && !input.startsWith("/")) {
        void operation(choose);
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
  });

  const promptTitle = prompt?.title || (editing ? `修改 ${editing.id} · 输入 JSON` : "");
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
  const logRows = Math.max(1, bodyHeight - 2);
  const shownLogs = state.logs.slice(
    Math.max(0, state.logs.length - logOffset - logRows),
    Math.max(0, state.logs.length - logOffset)
  );
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
          <Text wrap="truncate">
            {VIEWS.map(([id, label], index) => (
              <Text key={id} color={view === id ? ACCENT : MUTED} bold={view === id}>
                {index ? "   " : ""}
                {view === id ? "▸ " : ""}
                {label}
              </Text>
            ))}
          </Text>
        </Box>
        <Box height={bodyHeight} flexShrink={0} overflow="hidden" flexDirection="column">
          {promptTitle ? (
            <Box flexDirection="column" paddingX={1}>
              <Text color={AMBER} bold>
                {clean(promptTitle)}
              </Text>
              {prompt?.kind === "confirm" && (
                <Text wrap="truncate">
                  <Text color={input === "y" ? GREEN : MUTED}>
                    {input === "y" ? "❯" : " "} 确认执行 [y]
                  </Text>
                  {"     "}
                  <Text color={input !== "y" ? ACCENT : MUTED}>
                    {input !== "y" ? "❯" : " "} 取消 [n]
                  </Text>
                </Text>
              )}
              {prompt?.detail && (
                <Box height={Math.max(1, bodyHeight - 2)} overflow="hidden" flexShrink={0}>
                  <Text>{terminalText(prompt.detail).slice(0, 4000)}</Text>
                </Box>
              )}
              {secret && <Text color={MUTED}>凭据仅在本次进程中使用。</Text>}
            </Box>
          ) : state.installation && state.busy ? (
            <Box paddingX={1} flexDirection="column">
              <Text bold color={ACCENT}>
                首次设置
              </Text>
              <Text color={AMBER}>{installationStage(state.installation.stage)}</Text>
              {state.installation.lines.slice(-Math.max(1, bodyHeight - 3)).map((line, index) => (
                <Text key={index} color={MUTED} wrap="truncate">
                  {clean(line)}
                </Text>
              ))}
            </Box>
          ) : view === "home" ? (
            <Home state={state} height={bodyHeight} columns={columns} />
          ) : listing ? (
            <ChoiceList
              title={
                view === "language"
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
              columns={columns}
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
            <Box flexDirection="column" paddingX={1}>
              <Text color={ACCENT} bold>
                运行日志{" "}
                <Text color={MUTED}>
                  {logOffset ? `已暂停跟随 · 向下滚动恢复 (${logOffset})` : "● 实时跟随"}
                </Text>
              </Text>
              {shownLogs.length ? (
                shownLogs.map((entry, index) => (
                  <Text
                    key={index}
                    color={String(entry.level).includes("ERROR") ? RED : undefined}
                    wrap="truncate"
                  >
                    {clean(entry.time).slice(11, 19)}{" "}
                    <Text color={MUTED}>{clean(entry.level)}</Text> {clean(entry.message)}
                  </Text>
                ))
              ) : (
                <Text color={MUTED}>等待日志…</Text>
              )}
            </Box>
          ) : (
            <Box flexDirection="column" paddingX={1}>
              <Text bold color={ACCENT}>
                BAAS 操作指南
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
        <Box height={1} paddingX={1} flexShrink={0}>
          <Text color={notice || latestError ? RED : state.busy ? AMBER : MUTED} wrap="truncate">
            {notice ||
              (!state.busy && latestError
                ? `${latestError.title} · ${latestError.detail || ""}`
                : "") ||
              (state.busy
                ? `${["✦", "✧", "⋆", "✧"][tick % 4]} ${clean(state.busy)} · Esc 取消`
                : activeTask
                  ? `● ${clean(activeTask)} · /logs 查看运行详情`
                  : state.demo
                    ? "DEMO · 所有操作仅作用于内存演示"
                    : state.readOnly
                      ? "只读模式 · 可浏览与监控"
                      : state.dryRun
                        ? "预览模式 · 修改不会提交"
                        : "")}
          </Text>
        </Box>
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
        {suggestions.length ? (
          <Box flexDirection="column" paddingX={1}>
            {suggestions
              .slice(Math.max(0, suggestionIndex - 4), Math.max(0, suggestionIndex - 4) + 5)
              .map((item) => (
                <Text
                  key={item.id}
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
  const workspace = await Workspace.create(options);
  const app = render(<WorkspaceView workspace={workspace} />, { exitOnCtrlC: false, maxFps: 20 });
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
  }
}
