"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { Terminal } from "@xterm/xterm";
import { ChevronRight, Maximize2, Minimize2, Pause, Play, RotateCcw } from "lucide-react";
import {
  demoReducer,
  demoRows,
  demoSteps,
  demoText,
  initialDemo,
  supportedDemoCommands,
  type DemoAction,
  type DemoKey,
  type DemoLocale,
  type DemoScenario,
  type DemoState,
} from "@/lib/baasx-terminal-demo";
import "@xterm/xterm/css/xterm.css";
import styles from "./BaasxTerminalDemo.module.css";

const RESET = "\x1b[0m",
  WHITE = "\x1b[1;38;2;255;255;255m",
  CYAN = "\x1b[38;2;112;215;229m",
  BLUE = "\x1b[38;2;168;184;255m",
  GREEN = "\x1b[38;2;152;207;158m",
  MUTED = "\x1b[38;2;137;150;159m",
  SELECTED = "\x1b[48;2;32;63;73m";
const HOME_MARK = [" ▄▄▄▄▄  ▄▄", " █   █▄▄▀▀", " █▄▄▄█  █ ", "   ▀▀▀▀▀▀ "];
const STARS = ["·", "✢", "*", "✶", "✻", "✽", "✽", "✻", "✶", "*", "✢", "·"];
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const NAV = [
  ["home", "总览", "Overview"],
  ["tasks", "任务", "Tasks"],
  ["scheduler", "调度", "Scheduler"],
  ["profiles", "配置档", "Profiles"],
  ["logs", "日志", "Logs"],
  ["config", "配置", "Configuration"],
] as const;
const SCENARIOS: Array<[DemoScenario, string, string]> = [
  ["quickstart", "快速体验", "Quick start"],
  ["configuration", "配置与优先级", "Configuration"],
  ["scheduler", "任务调度", "Scheduler"],
  ["packs", "指令包", "Command packs"],
];
type Hit = {
  x: number;
  y: number;
  width: number;
  height?: number;
  kind?: "divider" | "input";
  command?: string;
  key?: DemoKey;
  index?: number;
  open?: boolean;
  suggestion?: number;
};
const widthOf = (value: string) =>
  [...segmenter.segment(value)].reduce(
    (sum, { segment }) =>
      sum +
      (/^[\p{Mark}]+$/u.test(segment)
        ? 0
        : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(
              segment
            )
          ? 2
          : 1),
    0
  );
function fitText(value: string, width: number) {
  let result = "",
    used = 0;
  for (const { segment } of segmenter.segment(value)) {
    const cells = widthOf(segment);
    if (used + cells > width) break;
    result += segment;
    used += cells;
  }
  return result;
}
const pageTab = (page: string) =>
  ["counts", "priority"].includes(page)
    ? "config"
    : page === "schedule"
      ? "scheduler"
      : page === "oneoff"
        ? "tasks"
        : page;
const cleanMessage = (value: string) => value.replace(/^DEMO · /, "");
function suggestionsFor(value: string) {
  if (!value.startsWith("/")) return [];
  const choices = value.startsWith("/run ")
    ? [
        "collect_reward",
        "cafe",
        "mail",
        "start_normal_task",
        "start_main_story",
        "start_explore_activity_story",
      ].map((id) => `/run ${id}`)
    : value.startsWith("/pack ")
      ? ["briefing", "connection-check", "daily", "daily-wait"].map((id) => `/pack ${id}`)
      : value.startsWith("/use ")
        ? ["/use sensei-demo"]
        : supportedDemoCommands;
  return choices.filter((command) => command.startsWith(value));
}

/** Terminal cells, input, mouse targets and the accessible transcript share one layout. */
function terminalFrame(
  state: DemoState,
  columns: number,
  rows: number,
  input: string,
  cursor: number,
  suggestion: number,
  frame: number,
  reduced: boolean,
  splitRatio: number,
  scroll: number
) {
  const t = (zh: string, en: string) => demoText(state.locale, zh, en);
  const screen = Array.from({ length: rows }, () => Array<string>(columns).fill(" "));
  const output: string[] = [
    "\x1b[?25l\x1b[H",
    Array.from({ length: rows }, () => "\x1b[2K").join("\r\n"),
  ];
  const hits: Hit[] = [];
  const write = (
    x: number,
    y: number,
    value: string,
    color = RESET,
    background = "",
    available = columns - x
  ) => {
    if (y < 0 || y >= rows || x < 0 || x >= columns) return;
    const text = fitText(value, Math.max(0, Math.min(available, columns - x)));
    output.push(`\x1b[${y + 1};${x + 1}H${color}${background}${text}${RESET}`);
    let at = x;
    for (const { segment } of segmenter.segment(text)) {
      const cells = widthOf(segment);
      screen[y][at] = segment;
      if (cells === 2) screen[y][at + 1] = "";
      at += cells;
    }
  };
  const editing = ["counts", "priority", "schedule"].includes(state.page);
  const minimal = rows < 20,
    compact = columns < 64 || rows < 24;
  const header = minimal ? 2 : compact ? 4 : 6;
  const profile = `${state.profile} · ${t("已连接", "Connected")}`;
  const enabled = state.schedule.filter((task) => task.enabled).length;
  const activity = state.running
    ? `${t("正在执行", "Running")} · ${state.running.id} · ${state.running.tick}/${state.running.total}`
    : `${t("调度", "Schedule")} · ${enabled}/${state.schedule.length} ${t("已启用", "enabled")} · ${t("待执行", "pending")} ${enabled}`;
  const next = `${t("下次执行", "Next run")} · collect_reward · ${t("待执行", "pending")}`;
  if (minimal) {
    write(1, 0, "▣ BAASX", WHITE);
    write(10, 0, `· ${state.profile}`, MUTED);
    write(1, 1, state.running ? activity : profile, state.running ? CYAN : GREEN);
  } else if (compact) {
    write(1, 0, "▣ BAASX", WHITE);
    write(10, 0, "v0.1.0", MUTED);
    write(1, 1, profile, GREEN);
    write(1, 2, activity, state.running ? CYAN : MUTED);
    write(1, 3, next, MUTED);
  } else {
    HOME_MARK.forEach((line, index) =>
      write(2, index + 1, line, index < 2 ? "\x1b[38;2;67;196;201m" : "\x1b[38;2;148;227;227m")
    );
    write(14, 1, "BAASX", WHITE);
    write(20, 1, "v0.1.0", MUTED);
    write(14, 2, profile, GREEN);
    write(14, 3, activity, state.running ? CYAN : MUTED);
    write(14, 4, next, MUTED);
  }
  const activeTab = pageTab(state.page);
  const currentTab = Math.max(
    0,
    NAV.findIndex(([id]) => id === activeTab)
  );
  const tabWidth = (index: number) =>
    widthOf(NAV[index][state.locale === "zh" ? 1 : 2]) + (NAV[index][0] === activeTab ? 4 : 2);
  let first = 0;
  while (
    first < currentTab &&
    NAV.slice(first, currentTab + 1).reduce((sum, _, index) => sum + tabWidth(first + index), 0) >
      columns - 2
  )
    first++;
  let navX = 1;
  for (let index = first; index < NAV.length; index++) {
    const [id, zh, en] = NAV[index],
      width = tabWidth(index);
    if (navX + width > columns - 1) break;
    const selected = id === activeTab;
    write(
      navX,
      header,
      `${selected ? "▸ " : ""}${t(zh, en)}  `,
      selected ? CYAN : MUTED,
      selected ? SELECTED : ""
    );
    if (!editing && !state.pending) hits.push({ x: navX, y: header, width, command: `/${id}` });
    navX += width;
  }
  const choices = !state.pending && state.editValue === undefined ? suggestionsFor(input) : [];
  const menuLimit = Math.min(5, choices.length, Math.max(1, rows - header - 9));
  const footerRows = menuLimit ? menuLimit + 1 : 1;
  const statusY = rows - footerRows - 4;
  const bodyTop = header + (state.page === "home" ? 1 : 2);
  const bodyHeight = Math.max(1, statusY - bodyTop);
  const split =
    columns >= 110 &&
    !editing &&
    !state.pending &&
    state.page !== "logs" &&
    (state.logs.length > 0 || !!state.running);
  const divider = split
    ? Math.max(40, Math.min(columns - 31, Math.round((columns - 1) * splitRatio)))
    : -1;
  const mainWidth = split ? divider : columns;
  let content = demoRows(state).map(cleanMessage);
  if (state.page === "home" && !state.pending)
    content = content.filter(
      (line) => !line.includes("教学模型") && !line.includes("teaching model")
    );
  const selectedLine = Math.max(
    0,
    content.findIndex((line) => line.startsWith("❯"))
  );
  const offset =
    state.page === "logs" && !state.pending
      ? Math.max(0, content.length - bodyHeight - scroll)
      : state.page === "help"
        ? Math.max(0, Math.min(scroll, content.length - bodyHeight))
        : Math.max(
            0,
            Math.min(selectedLine - Math.floor(bodyHeight / 2), content.length - bodyHeight)
          );
  let itemIndex = -1;
  for (let index = 0; index < content.length; index++) {
    const line = content[index],
      item = /^(?:❯ | {2})/.test(line);
    if (item) itemIndex++;
    if (index < offset || index >= offset + bodyHeight) continue;
    const y = bodyTop + index - offset,
      focused = line.startsWith("❯");
    if (state.pending && line.includes("[Enter")) {
      const yes = state.cancelSelected
          ? t("  确认", "  Confirm")
          : t("❯ 确认 [Enter]", "❯ Confirm [Enter]"),
        no = state.cancelSelected
          ? t("❯ 取消 [Enter/Esc]", "❯ Cancel [Enter/Esc]")
          : t("取消 [Esc]", "Cancel [Esc]");
      const noX = Math.min(mainWidth - widthOf(no) - 1, widthOf(yes) + 5);
      write(1, y, yes, state.cancelSelected ? MUTED : CYAN, state.cancelSelected ? "" : SELECTED);
      write(noX, y, no, state.cancelSelected ? CYAN : MUTED, state.cancelSelected ? SELECTED : "");
      hits.push(
        { x: 1, y, width: widthOf(yes), key: "enter" },
        { x: noX, y, width: widthOf(no), key: "escape" }
      );
      continue;
    }
    const display = focused
      ? fitText(line, mainWidth - 2).padEnd(mainWidth - 2 - widthOf(line) + line.length, " ")
      : line;
    write(
      1,
      y,
      display,
      focused ? CYAN : index === 0 && state.page !== "logs" ? CYAN : RESET,
      focused ? SELECTED : "",
      mainWidth - 2
    );
    if (item && !state.pending && state.editValue === undefined) {
      hits.push({
        x: 1,
        y,
        width: mainWidth - 2,
        index: itemIndex,
        open: !["counts", "priority"].includes(state.page),
      });
      if (state.page === "counts") {
        for (const [token, key] of [
          ["[-]", "minus"],
          ["[+]", "plus"],
        ] as const) {
          const at = line.indexOf(token);
          if (at >= 0)
            hits.push({ x: 1 + widthOf(line.slice(0, at)), y, width: 3, index: itemIndex, key });
        }
      }
    }
  }
  if (editing && !state.pending && state.editValue === undefined) {
    const label = t("保存 [Ctrl+S]", "Save [Ctrl+S]");
    const y = Math.min(statusY - 1, bodyTop + Math.min(content.length + 1, bodyHeight - 1));
    write(1, y, label, GREEN);
    hits.push({ x: 1, y, width: widthOf(label), key: "save" });
    if (state.page === "priority") {
      const up = t("← 上移", "← Move up"),
        down = t("→ 下移", "→ Move down");
      let x = widthOf(label) + 4;
      write(x, y, up, CYAN);
      hits.push({ x, y, width: widthOf(up), key: "left" });
      x += widthOf(up) + 3;
      write(x, y, down, CYAN);
      hits.push({ x, y, width: widthOf(down), key: "right" });
    }
  }
  if (split) {
    for (let y = bodyTop; y < statusY; y++) write(divider, y, "│", MUTED);
    hits.push({ x: divider, y: bodyTop, width: 1, height: bodyHeight, kind: "divider" });
    write(divider + 2, bodyTop, t("运行日志 ●", "Run logs ●"), CYAN);
    const logRows = state.logs.length ? state.logs : [t("等待日志…", "Waiting for logs…")];
    logRows
      .slice(-Math.max(1, bodyHeight - 2))
      .forEach((line, index) =>
        write(
          divider + 2,
          bodyTop + 2 + index,
          cleanMessage(line),
          MUTED,
          "",
          columns - divider - 3
        )
      );
  }
  const busy = state.running
    ? `${reduced ? "●" : STARS[frame % STARS.length]} ${state.running.id} · ${t("/logs 查看运行详情", "/logs for details")}`
    : "";
  const notice = cleanMessage(state.notice);
  write(
    1,
    statusY,
    state.running && notice
      ? `${reduced ? "●" : STARS[frame % STARS.length]} ${notice}`
      : notice || busy,
    state.running ? CYAN : BLUE
  );
  write(0, statusY + 1, "─".repeat(columns), MUTED);
  const commandY = statusY + 2;
  write(1, commandY, "❯", CYAN);
  const value = state.editValue ?? input,
    at = state.editValue === undefined ? cursor : value.length;
  let before = value.slice(0, at);
  while (widthOf(before) > columns - 8)
    before = [...segmenter.segment(before)]
      .slice(1)
      .map(({ segment }) => segment)
      .join("");
  write(3, commandY, before, RESET);
  const cursorX = 3 + widthOf(before);
  write(cursorX, commandY, value[at] || " ", WHITE, "\x1b[7m");
  if (value) write(cursorX + 1, commandY, value.slice(at + 1), RESET);
  else
    write(
      4,
      commandY,
      t(
        "输入 / 查看操作，或输入 tasks、start 等命令",
        "Type / for commands, or enter tasks, start…"
      ),
      MUTED
    );
  hits.push({ x: 1, y: commandY, width: columns - 2, kind: "input" });
  write(0, statusY + 3, "─".repeat(columns), MUTED);
  if (menuLimit) {
    const menuStart = Math.max(0, Math.min(suggestion - menuLimit + 1, choices.length - menuLimit));
    choices.slice(menuStart, menuStart + menuLimit).forEach((command, index) => {
      const selected = index + menuStart === suggestion;
      const y = statusY + 4 + index;
      write(
        1,
        y,
        `${selected ? "❯" : " "} ${command}`,
        selected ? CYAN : MUTED,
        selected ? SELECTED : ""
      );
      hits.push({ x: 1, y, width: columns - 2, suggestion: index + menuStart });
    });
    write(
      1,
      rows - 1,
      t(
        "↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 清空",
        "↑↓ choose · Tab complete · Enter run · Esc clear"
      ),
      MUTED
    );
  } else
    write(
      1,
      rows - 1,
      state.pending
        ? t("Enter 确认 · Esc 取消", "Enter confirm · Esc cancel")
        : editing
          ? t(
              "↑↓ 选择 · Enter 编辑 · Ctrl+S 保存 · Esc 返回",
              "↑↓ select · Enter edit · Ctrl+S save · Esc back"
            )
          : t(
              "/ 命令 · ? 帮助 · Shift+Tab 切换 · Sensei Demo",
              "/ commands · ? help · Shift+Tab switch · Sensei Demo"
            ),
      MUTED
    );
  return {
    ansi: output.join(""),
    text: screen.map((line) => line.join("").trimEnd()).join("\n"),
    hits,
    divider,
    bodyHeight,
    choices,
  };
}

export function BaasxTerminalDemo({
  locale,
  scenario = "quickstart",
}: {
  locale: DemoLocale;
  scenario?: DemoScenario;
}) {
  const id = useId();
  const t = (zh: string, en: string) => demoText(locale, zh, en);
  const [activeScenario, setActiveScenario] = useState(scenario);
  const [state, dispatch] = useReducer(demoReducer, undefined, () => initialDemo(locale, scenario));
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [suggestion, setSuggestion] = useState(0);
  const [loaded, setLoaded] = useState(false),
    [ready, setReady] = useState(false),
    [loadError, setLoadError] = useState(false);
  const [visible, setVisible] = useState(false),
    [pageVisible, setPageVisible] = useState(true),
    [reduced, setReduced] = useState(true);
  const [playing, setPlaying] = useState(false),
    [paused, setPaused] = useState(false),
    [guideIndex, setGuideIndex] = useState(0),
    [guideDirty, setGuideDirty] = useState(false);
  const [frame, setFrame] = useState(0),
    [splitRatio, setSplitRatio] = useState(0.56),
    [scroll, setScroll] = useState(0),
    [expanded, setExpanded] = useState(false);
  const [geometry, setGeometry] = useState({ columns: 80, rows: 32 });
  const section = useRef<HTMLElement>(null),
    host = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null);
  const stateRef = useRef(state),
    inputRef = useRef({ text: "", cursor: 0 }),
    suggestionRef = useRef(0),
    numberRef = useRef("");
  const replaceNumber = useRef(true),
    inputHandler = useRef<(data: string) => void>(() => {}),
    mouseHandler = useRef<(hit: Hit) => void>(() => {});
  const steps = useMemo(() => demoSteps(activeScenario), [activeScenario]);
  const step = steps[Math.max(0, guideIndex - 1)];
  const scene = useMemo(
    () =>
      terminalFrame(
        state,
        geometry.columns,
        geometry.rows,
        input,
        cursor,
        suggestion,
        frame,
        reduced,
        splitRatio,
        scroll
      ),
    [state, geometry, input, cursor, suggestion, frame, reduced, splitRatio, scroll]
  );
  const sceneRef = useRef(scene);
  const interrupt = useCallback(() => {
    setPlaying(false);
    setPaused(false);
    setGuideDirty(true);
  }, []);
  const manual = useCallback(
    (action: DemoAction) => {
      interrupt();
      dispatch(action);
    },
    [interrupt]
  );
  const changeInput = useCallback((value: string, position = value.length) => {
    // eslint-disable-next-line no-control-regex -- User text cannot inject terminal controls.
    const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 300);
    inputRef.current = { text: clean, cursor: Math.min(position, clean.length) };
    setInput(clean);
    setCursor(inputRef.current.cursor);
    setSuggestion(0);
    suggestionRef.current = 0;
  }, []);
  const submit = useCallback(
    (value: string) => {
      if (value.trim()) manual({ type: "command", value });
      changeInput("");
      setScroll(0);
    },
    [manual, changeInput]
  );
  const focusTerminal = () => terminal.current?.focus();
  const reset = () => {
    dispatch({ type: "reset", locale, scenario: activeScenario });
    changeInput("");
    setPlaying(false);
    setPaused(false);
    setGuideDirty(false);
    setGuideIndex(0);
    setScroll(0);
  };
  const advance = useCallback(() => {
    const index = guideDirty ? 0 : guideIndex;
    if (index >= steps.length) {
      setPlaying(false);
      return;
    }
    if (guideDirty) dispatch({ type: "reset", locale, scenario: activeScenario });
    dispatch(steps[index].action);
    changeInput("");
    setScroll(0);
    setGuideDirty(false);
    setPaused(false);
    setGuideIndex(index + 1);
    if (index + 1 >= steps.length) setPlaying(false);
  }, [guideDirty, guideIndex, steps, locale, activeScenario, changeInput]);
  useEffect(() => setActiveScenario(scenario), [scenario]);
  useEffect(() => {
    dispatch({ type: "reset", locale, scenario: activeScenario });
    setGuideIndex(0);
    setGuideDirty(false);
    setPlaying(false);
    setPaused(false);
    setScroll(0);
    changeInput("");
  }, [locale, activeScenario, changeInput]);
  useEffect(() => {
    const node = section.current;
    if (!node) return;
    if (!("IntersectionObserver" in window)) {
      setLoaded(true);
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
        if (entry.isIntersecting) setLoaded(true);
      },
      { rootMargin: "160px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(preference.matches),
      visibility = () => setPageVisible(document.visibilityState !== "hidden");
    motion();
    visibility();
    preference.addEventListener("change", motion);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      preference.removeEventListener("change", motion);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useLayoutEffect(() => {
    if (state.editValue !== undefined && stateRef.current.editValue === undefined)
      replaceNumber.current = true;
    if (state.editValue !== undefined) numberRef.current = state.editValue;
    stateRef.current = state;
    sceneRef.current = scene;
    if (terminal.current) terminal.current.write(scene.ansi);
  }, [state, scene]);

  useEffect(() => {
    inputHandler.current = (data) => {
      interrupt();
      const current = stateRef.current,
        buffer = inputRef.current,
        choices = suggestionsFor(buffer.text);
      const selectSuggestion = (index: number) => {
        suggestionRef.current = Math.max(0, Math.min(choices.length - 1, index));
        setSuggestion(suggestionRef.current);
      };
      const keys: Record<string, DemoKey> = {
        "\x1b[A": "up",
        "\x1b[B": "down",
        "\x1b[D": "left",
        "\x1b[C": "right",
        "\x13": "save",
      };
      if (data === "\t" && choices.length) {
        const value = choices[suggestionRef.current] || choices[0];
        changeInput(value + (["/run", "/pack", "/use"].includes(value) ? " " : ""));
        return;
      }
      if (data === "\x1b[Z") {
        const index = Math.max(
          0,
          NAV.findIndex(([page]) => page === pageTab(current.page))
        );
        submit(`/${NAV[(index + 1) % NAV.length][0]}`);
        return;
      }
      if (data === "\x1b[5~" || data === "\x1b[6~") {
        const delta = (data === "\x1b[6~" ? 1 : -1) * Math.max(1, sceneRef.current.bodyHeight - 1);
        setScroll((value) => Math.max(0, value + (current.page === "logs" ? -delta : delta)));
        return;
      }
      if (data === "\x1b" || data === "\x03") {
        if (buffer.text) changeInput("");
        else manual({ type: "key", key: "escape" });
        return;
      }
      if (data === "\r") {
        if (current.pending || current.editValue !== undefined)
          manual({ type: "key", key: "enter" });
        else if (buffer.text.trim())
          submit(choices.length ? choices[suggestionRef.current] || buffer.text : buffer.text);
        else manual({ type: "key", key: "enter" });
        setScroll(0);
        return;
      }
      if (keys[data]) {
        const key = keys[data];
        if (choices.length && !current.pending && (key === "up" || key === "down")) {
          selectSuggestion(suggestionRef.current + (key === "down" ? 1 : -1));
          return;
        }
        if (buffer.text && (key === "left" || key === "right")) {
          const position = Math.max(
            0,
            Math.min(buffer.text.length, buffer.cursor + (key === "right" ? 1 : -1))
          );
          inputRef.current.cursor = position;
          setCursor(position);
          return;
        }
        if (["logs", "help"].includes(current.page) && (key === "up" || key === "down")) {
          const direction = key === "down" ? 1 : -1;
          setScroll((value) =>
            Math.max(0, value + (current.page === "logs" ? -direction : direction))
          );
          return;
        }
        manual({ type: "key", key });
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (current.editValue !== undefined) {
          replaceNumber.current = false;
          numberRef.current = numberRef.current.slice(0, -1);
          manual({ type: "value", value: numberRef.current });
        } else if (buffer.cursor > 0)
          changeInput(
            buffer.text.slice(0, buffer.cursor - 1) + buffer.text.slice(buffer.cursor),
            buffer.cursor - 1
          );
        return;
      }
      if (data.startsWith("\x1b")) return;
      if (current.pending) {
        if (data.toLowerCase() === "n") manual({ type: "key", key: "escape" });
        else if (data.toLowerCase() === "y") {
          if (current.cancelSelected) manual({ type: "key", key: "left" });
          manual({ type: "key", key: "enter" });
        }
        return;
      }
      if (current.editValue !== undefined) {
        const candidate = (replaceNumber.current ? "" : numberRef.current) + data;
        if (/^-?\d*$/.test(candidate)) {
          numberRef.current = candidate;
          replaceNumber.current = false;
          manual({ type: "value", value: candidate });
        }
        return;
      }
      if (!buffer.text && ["+", "-", " ", "<", ">"].includes(data)) {
        manual({
          type: "key",
          key:
            data === "+"
              ? "plus"
              : data === "-"
                ? "minus"
                : data === "<"
                  ? "left"
                  : data === ">"
                    ? "right"
                    : "space",
        });
        return;
      }
      if (!buffer.text && data === "?") {
        submit("/help");
        return;
      }
      changeInput(
        buffer.text.slice(0, buffer.cursor) + data + buffer.text.slice(buffer.cursor),
        buffer.cursor + data.length
      );
    };
    mouseHandler.current = (hit) => {
      if (hit.kind === "input") return;
      if (hit.command) {
        submit(hit.command);
        return;
      }
      if (hit.suggestion !== undefined) {
        const value = sceneRef.current.choices[hit.suggestion];
        if (value) submit(value);
        return;
      }
      if (hit.index !== undefined) {
        const delta = hit.index - stateRef.current.selected;
        for (let i = 0; i < Math.abs(delta); i++)
          manual({ type: "key", key: delta > 0 ? "down" : "up" });
      }
      if (hit.key) {
        if (hit.key === "enter" && stateRef.current.pending && stateRef.current.cancelSelected)
          manual({ type: "key", key: "left" });
        manual({ type: "key", key: hit.key });
      } else if (hit.open) {
        manual({ type: "key", key: "enter" });
        setScroll(0);
      }
    };
  }, [changeInput, manual, submit, interrupt]);

  useEffect(() => {
    if (!loaded || !host.current) return;
    let disposed = false,
      cleanup = () => {};
    const node = host.current;
    void (async () => {
      try {
        const [{ Terminal: Xterm }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (disposed) return;
        const term = new Xterm({
          cols: 80,
          rows: 32,
          fontSize: node.clientWidth < 540 ? 13 : 12,
          lineHeight: 1.35,
          fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
          cursorBlink: false,
          scrollback: 0,
          convertEol: true,
          screenReaderMode: false,
          smoothScrollDuration: 0,
          theme: {
            background: "#20242c",
            foreground: "#dce8f2",
            cursor: "#70d7e5",
            selectionBackground: "#284353",
            black: "#20242c",
            brightBlack: "#89969f",
            white: "#ffffff",
            brightWhite: "#ffffff",
            cyan: "#70d7e5",
            brightCyan: "#a5f3fc",
            blue: "#a8b8ff",
            brightBlue: "#c7d2fe",
            yellow: "#a8b8ff",
            brightYellow: "#c7d2fe",
          },
        });
        cleanup = () => {
          terminal.current = null;
          term.dispose();
        };
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(node);
        terminal.current = term;
        term.textarea?.setAttribute(
          "aria-label",
          demoText(locale, "BAASX 离线演示终端输入", "BAASX offline demo terminal input")
        );
        term.attachCustomKeyEventHandler((event) => {
          if (event.key === "Tab") {
            if (event.shiftKey || suggestionsFor(inputRef.current.text).length) {
              if (event.type === "keydown") {
                event.preventDefault();
                inputHandler.current(event.shiftKey ? "\x1b[Z" : "\t");
              }
              return false;
            }
            return false;
          }
          if (
            (event.ctrlKey || event.metaKey) &&
            ["r", "s", "t", "p", "l"].includes(event.key.toLowerCase())
          ) {
            if (event.type === "keydown") {
              event.preventDefault();
              const key = event.key.toLowerCase();
              if (key === "s") inputHandler.current("\x13");
              else
                submit(
                  (
                    { r: "/reload", t: "/tasks", p: "/profiles", l: "/logs" } as Record<
                      string,
                      string
                    >
                  )[key]
                );
            }
            return false;
          }
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "c" &&
            term.hasSelection()
          )
            return false;
          return true;
        });
        term.attachCustomWheelEventHandler((event) => {
          if (
            event.ctrlKey ||
            window.matchMedia("(pointer: coarse)").matches ||
            document.activeElement !== term.textarea
          )
            return false;
          const page = stateRef.current.page;
          if (page === "help" || page === "logs") {
            event.preventDefault();
            const direction = event.deltaY > 0 ? 3 : -3;
            setScroll((value) => Math.max(0, value + (page === "logs" ? -direction : direction)));
            return false;
          }
          return false;
        });
        const subscription = term.onData((data) => inputHandler.current(data));
        const point = (event: PointerEvent) => {
          const bounds = node.querySelector(".xterm-screen")?.getBoundingClientRect();
          return bounds && bounds.width && bounds.height
            ? {
                x: Math.floor(((event.clientX - bounds.left) / bounds.width) * term.cols),
                y: Math.floor(((event.clientY - bounds.top) / bounds.height) * term.rows),
              }
            : undefined;
        };
        let dragging: number | undefined;
        const down = (event: PointerEvent) => {
          if (event.button !== 0) return;
          term.focus();
          const at = point(event);
          if (!at) return;
          const hit = [...sceneRef.current.hits]
            .reverse()
            .find(
              (item) =>
                at.x >= item.x &&
                at.x < item.x + item.width &&
                at.y >= item.y &&
                at.y < item.y + (item.height ?? 1)
            );
          if (!hit) return;
          if (hit.kind === "divider") {
            event.preventDefault();
            dragging = event.pointerId;
            node.setPointerCapture(event.pointerId);
            interrupt();
          } else mouseHandler.current(hit);
        };
        const move = (event: PointerEvent) => {
          const at = point(event);
          if (!at) return;
          if (dragging !== undefined) {
            event.preventDefault();
            setSplitRatio(Math.max(40, Math.min(term.cols - 31, at.x)) / (term.cols - 1));
            return;
          }
          node.style.cursor = sceneRef.current.divider === at.x ? "col-resize" : "text";
        };
        const up = (event: PointerEvent) => {
          if (dragging === undefined) return;
          dragging = undefined;
          if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
        };
        node.addEventListener("pointerdown", down);
        node.addEventListener("pointermove", move);
        node.addEventListener("pointerup", up);
        node.addEventListener("pointercancel", up);
        let scheduled = 0;
        const resize = () => {
          cancelAnimationFrame(scheduled);
          scheduled = requestAnimationFrame(() => {
            if (disposed || !node.clientWidth || !node.clientHeight) return;
            const fontSize = node.clientWidth < 540 ? 13 : 12;
            if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
            fit.fit();
            setGeometry({ columns: term.cols, rows: term.rows });
          });
        };
        const observer = new ResizeObserver(resize);
        observer.observe(node);
        resize();
        void document.fonts.ready.then(() => {
          if (!disposed) resize();
        });
        setReady(true);
        cleanup = () => {
          cancelAnimationFrame(scheduled);
          observer.disconnect();
          subscription.dispose();
          node.removeEventListener("pointerdown", down);
          node.removeEventListener("pointermove", move);
          node.removeEventListener("pointerup", up);
          node.removeEventListener("pointercancel", up);
          terminal.current = null;
          term.dispose();
        };
      } catch {
        cleanup();
        if (!disposed) setLoadError(true);
      }
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [loaded, locale, submit, interrupt]);
  useEffect(() => {
    if (!playing || !visible || !pageVisible) return;
    const timer = window.setTimeout(advance, reduced ? 2600 : 1900);
    return () => window.clearTimeout(timer);
  }, [playing, visible, pageVisible, advance, reduced]);
  useEffect(() => {
    if (!state.running || paused || !visible || !pageVisible) return;
    const timer = window.setInterval(() => dispatch({ type: "tick" }), 1500);
    return () => window.clearInterval(timer);
  }, [!!state.running, paused, visible, pageVisible]);
  useEffect(() => {
    if (!state.running || paused || reduced || !visible || !pageVisible) return;
    const timer = window.setInterval(() => setFrame((value) => value + 1), 120);
    return () => window.clearInterval(timer);
  }, [!!state.running, paused, reduced, visible, pageVisible]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.activeElement !== terminal.current?.textarea)
        setExpanded(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [expanded]);

  return (
    <section
      ref={section}
      className={`${styles.demo} ${expanded ? styles.expanded : ""}`}
      aria-label={t("BAASX 交互式终端教程", "BAASX interactive terminal tutorial")}
      data-baasx-demo={scenario}
      data-scenario={activeScenario}
      data-page={state.page}
      data-running={state.running ? "true" : "false"}
      data-playing={playing ? "true" : "false"}
      data-cols={geometry.columns}
      data-rows={geometry.rows}
      data-split={splitRatio}
      data-divider-column={scene.divider}
    >
      <div className={styles.toolbar}>
        <span className={styles.engine}>
          <span className={styles.badge}>DEMO</span>
        </span>
        <label className={styles.scenarioLabel} htmlFor={`${id}-scenario`}>
          {t("场景", "Scene")}
        </label>
        <select
          id={`${id}-scenario`}
          value={activeScenario}
          onChange={(event) => setActiveScenario(event.target.value as DemoScenario)}
        >
          {SCENARIOS.map(([value, zh, en]) => (
            <option value={value} key={value}>
              {t(zh, en)}
            </option>
          ))}
        </select>
        <div className={styles.tools}>
          <button
            type="button"
            disabled={guideIndex >= steps.length && !guideDirty}
            onClick={() => {
              setPlaying(false);
              advance();
            }}
            title={t("演示下一步", "Show next step")}
            aria-label={t("演示下一步", "Show next step")}
          >
            <ChevronRight size={16} aria-hidden="true" />
            <span>{t("下一步", "Next")}</span>
          </button>
          <button
            type="button"
            aria-pressed={playing}
            aria-label={
              playing
                ? t("暂停演示", "Pause demo")
                : paused
                  ? t("继续演示", "Resume demo")
                  : t("自动演示", "Play walkthrough")
            }
            onClick={() => {
              if (playing) {
                setPlaying(false);
                setPaused(true);
                return;
              }
              if (guideIndex >= steps.length || guideDirty) {
                dispatch({ type: "reset", locale, scenario: activeScenario });
                setGuideIndex(0);
                setGuideDirty(false);
                changeInput("");
              }
              setPaused(false);
              setPlaying(true);
            }}
          >
            {playing ? (
              <Pause size={15} aria-hidden="true" />
            ) : (
              <Play size={15} aria-hidden="true" />
            )}
            <span>
              {playing ? t("暂停", "Pause") : paused ? t("继续", "Resume") : t("演示", "Play")}
            </span>
          </button>
          <button
            type="button"
            onClick={reset}
            aria-label={t("重置", "Reset")}
            title={t("重置", "Reset")}
          >
            <RotateCcw size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-label={
              expanded ? t("退出大屏", "Exit expanded view") : t("展开终端", "Expand terminal")
            }
            title={
              expanded ? t("退出大屏", "Exit expanded view") : t("展开终端", "Expand terminal")
            }
          >
            {expanded ? (
              <Minimize2 size={15} aria-hidden="true" />
            ) : (
              <Maximize2 size={15} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      <div className={styles.terminalWrap}>
        <div ref={host} className={styles.terminal} data-testid="baasx-terminal" />
        {!ready && (
          <div className={styles.loading}>
            {loadError
              ? t(
                  "终端加载失败，请刷新后重试。文字备用视图仍可读取。",
                  "Terminal loading failed. Reload to retry; the text fallback remains available."
                )
              : t("正在打开终端…", "Opening terminal…")}
          </div>
        )}
      </div>
      <div className={styles.guide}>
        <p>
          <span className={styles.stepCount}>
            {guideIndex}/{steps.length}
          </span>
          <strong>
            {guideIndex
              ? step.title[locale === "zh" ? 0 : 1]
              : t(
                  "点击终端，直接输入 /help 开始体验。",
                  "Click the terminal and type /help to begin."
                )}
          </strong>
          <span className={styles.description}>
            {guideIndex
              ? step.description[locale === "zh" ? 0 : 1]
              : t(
                  "Tab 补全 · 鼠标点击页签和列表 · 宽屏日志分界线可拖动",
                  "Tab completes · Click tabs and rows · Drag the log divider in wide views"
                )}
          </span>
        </p>
        <output className={styles.screenReader} aria-live="polite" aria-atomic="true">
          {state.notice ||
            (state.pending
              ? t(
                  "等待确认，Enter 确认，Esc 取消。",
                  "Confirmation pending: Enter confirms, Esc cancels."
                )
              : demoRows(state).find((line) => line.startsWith("❯")) || state.page)}
        </output>
        <div className={styles.detailsRow}>
          <details className={styles.touchTools}>
            <summary>{t("触屏快捷键", "Touch keys")}</summary>
            <div className={styles.touchButtons}>
              {(
                [
                  ["up", "↑"],
                  ["down", "↓"],
                  ["left", "←"],
                  ["right", "→"],
                  ["enter", "Enter"],
                  ["escape", "Esc"],
                  ["plus", "+"],
                  ["minus", "−"],
                  ["space", "Space"],
                  ["save", "Ctrl+S"],
                ] as Array<[DemoKey, string]>
              ).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => {
                    manual({ type: "key", key });
                    focusTerminal();
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  submit("/help");
                  focusTerminal();
                }}
              >
                /help
              </button>
              <button
                type="button"
                onClick={() => {
                  changeInput("/");
                  focusTerminal();
                }}
              >
                /
              </button>
            </div>
          </details>
          <details className={styles.textView}>
            <summary>{t("文字备用视图", "Text fallback")}</summary>
            <pre data-testid="baasx-transcript">
              {["BAASX · DEMO", ...demoRows(state), state.notice].filter(Boolean).join("\n")}
            </pre>
            <pre data-testid="baasx-screen-text" hidden>
              {scene.text}
            </pre>
            <p>{supportedDemoCommands.join(" · ")}</p>
          </details>
          <span className={styles.scope}>
            {t(
              "离线演示，不连接设备或修改真实配置。",
              "Offline demo; no devices or real configuration."
            )}
          </span>
        </div>
      </div>
    </section>
  );
}
