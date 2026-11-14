import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { HitBox, wrapTerminalText } from "./terminal-components";
import { translate } from "./i18n";

interface HelpCommand {
  id: string;
  label: string;
  detail: string;
}

interface CommandUsage {
  syntax?: string;
  example?: string;
  explanation?: string;
}

/** Supplement the live command menu, so newly added commands still appear in help. */
const USAGE: Record<string, CommandUsage> = {
  run: {
    syntax: "/run [<task-id>]",
    example: "/run mail · /run start_normal_task",
    explanation: "只运行指定任务一次；不带参数时打开任务列表。提交前按提示确认。",
  },
  oneoff: {
    explanation: "打开普通、困难、剧情及活动的一次性任务列表；选择后单独运行，不加入日常调度。",
  },
  start: {
    explanation: "立即启动当前配置档的日常调度，按已启用任务的顺序和时间运行，无需再次确认。",
  },
  reload: {
    explanation:
      "像客户端重载一样重建界面、重读设置并回到主页；后台任务继续运行，未保存的编辑会清除。",
  },
  scheduler: {
    explanation: "修改任务的启用状态、执行时间、间隔和前后置任务；保存后生效。",
  },
  tasks: {
    explanation: "查看日常任务；选择一项并确认后，只运行这一项。切到一次性任务可查看推图和剧情。",
  },
  profiles: {
    explanation: "查看和切换配置档；之后的运行、配置和调度操作使用选中的配置档。",
  },
  "new-profile": {
    explanation: "按向导输入名称和服务器，创建并选中配置档。",
  },
  stop: {
    explanation: "请求停止当前配置档正在运行的任务或调度；提交前按提示确认。",
  },
  logs: {
    syntax: "/logs [<count>]",
    example: "/logs · /logs 50",
    explanation: "不带参数打开实时日志；带数量读取最近的日志。滚轮或 PageUp/PageDown 查看历史。",
  },
  config: {
    syntax: "/config [get [<path>] | set <path> <JSON>]",
    example:
      "/config get /cafe_reward_affection_pat_round\n/config set /cafe_reward_affection_pat_round 5",
    explanation: "不带参数打开配置编辑器；get 读取字段，set 写入 JSON 值。路径以 / 开头。",
  },
  connect: {
    syntax: "/connect [<address>]",
    example: "/connect · /connect ws://127.0.0.1:8190",
    explanation: "不带参数连接已保存的服务；指定地址则切换服务，登录 Key 按提示输入。",
  },
  install: {
    syntax: "/install [stable|dev]",
    example: "/install",
    explanation: "安装本地 Python、BAAS 服务版后端和依赖。首次安装默认使用 stable 通道。",
  },
  uninstall: {
    explanation: "卸载本地后端程序，保留配置和用户数据。",
  },
  clear: {
    explanation: "清除当前显示的活动和日志，不断开连接或删除数据。",
  },
  local: {
    explanation: "启动已安装的本地后端并连接，完成后进入主页。",
  },
  update: {
    explanation: "检查并更新本地后端与资源；运行中的任务需要先停止。",
  },
  packs: {
    explanation: "查看已加载的指令包命令；输入命令名称以执行。",
  },
  help: {
    syntax: "/help · ?",
  },
  home: {
    syntax: "/home",
  },
  quit: {
    syntax: "/quit · /exit",
  },
};

const EXTRA_COMMANDS: HelpCommand[] = [
  {
    id: "use",
    label: "/use <profile-id-or-name>",
    detail: "按配置档 ID 或完整名称切换；名称包含空格时加引号。",
  },
  {
    id: "pack",
    label: "/pack <command-name>",
    detail: "执行指定指令包命令；命令名可在 /packs 中查看。",
  },
  { id: "check-update", label: "/check-update", detail: "仅检查本地后端和资源更新，显示结果。" },
  { id: "logout", label: "/logout", detail: "断开当前连接，并清除本次会话中的登录 Key。" },
  { id: "setup", label: "/setup", detail: "打开运行方式向导，选择安装本地环境或连接已有服务。" },
  {
    id: "profile",
    label: "/profile create <name> <server>",
    detail: "使用名称和服务器创建配置档；也可以用 /new-profile 向导选择服务器。",
  },
];
const EXTRA_EXAMPLES: Record<string, string> = {
  use: "/use my-profile",
  pack: "/pack daily",
};
const SHORTCUTS = [
  "PageUp / PageDown：翻页阅读帮助或日志；鼠标滚轮也可滚动。",
  "↑↓：在列表中选择；在命令输入框中查找历史。Enter：执行命令或确认选择。",
  "Tab：补全命令。Shift+Tab：切换顶部页面。Esc：返回或取消当前操作。",
  "Ctrl+T：任务。Ctrl+P：配置档。Ctrl+L：日志。Ctrl+R：重载界面。",
  "配置编辑：Ctrl+S 保存，Esc 放弃当前编辑；表格中 Enter 编辑单元格，+/- 调整次数。",
  "优先级列表：↑↓ 选择，←→ 上下移动，Space 添加或移除，/ 搜索，Ctrl+S 保存。",
  "Ctrl+A / Ctrl+E：输入光标到行首或行尾。Ctrl+U / Ctrl+K：删除光标前或后的内容。",
  "Ctrl+C：取消当前操作；输入框为空且空闲时退出。Ctrl+D：退出工作台。",
];

interface HelpLine {
  text: string;
  accent?: boolean;
}

/** Local pagination leaves the workspace command input available while reading. */
export function WorkbenchHelp({
  commands,
  language,
  width,
  height,
  active = true,
}: {
  commands: readonly HelpCommand[];
  language: string;
  width: number;
  height: number;
  active?: boolean;
}) {
  const t = (value: string) => translate(value, language);
  const [scrollOffset, setScrollOffset] = useState(0);
  const padding = width > 2 ? 1 : 0;
  const innerWidth = Math.max(1, width - padding * 2);
  const headerVisible = height >= 3;
  const footerVisible = height >= 4;
  const pageHeight = Math.max(1, height - Number(headerVisible) - Number(footerVisible));
  const lines = useMemo(() => {
    const tr = (value: string) => translate(value, language);
    const content: HelpLine[] = [];
    const add = (text: string, accent = false) =>
      content.push(...wrapTerminalText(text, innerWidth).map((text) => ({ text, accent })));
    add(tr("输入命令后按 Enter；下方输入框可随时使用。"));
    add(tr("<...> 表示必填参数，[...] 表示可选参数；示例中的 ID 请换成自己的。"));
    add("");
    const first = ["run", "oneoff", "start", "reload"];
    const ordered = [
      ...first.flatMap((id) => commands.filter((command) => command.id === id)),
      ...commands.filter((command) => !first.includes(command.id)),
    ];
    for (const command of ordered) {
      const usage = USAGE[command.id];
      add(usage?.syntax ?? command.label, true);
      add(tr(usage?.explanation ?? command.detail));
      add(`${tr("示例")}  ${usage?.example ?? command.label}`);
      add("");
    }
    add(tr("更多命令"), true);
    for (const command of EXTRA_COMMANDS) {
      add(command.label, true);
      add(tr(command.detail));
      if (EXTRA_EXAMPLES[command.id]) add(`${tr("示例")}  ${EXTRA_EXAMPLES[command.id]}`);
      add("");
    }
    add(tr("快捷键"), true);
    for (const shortcut of SHORTCUTS) {
      add(tr(shortcut));
      add("");
    }
    return content;
  }, [commands, language, innerWidth]);
  const maximum = Math.max(0, lines.length - pageHeight);
  const offset = Math.max(0, Math.min(scrollOffset, maximum));
  const move = (delta: number) => {
    if (active)
      setScrollOffset((previous) =>
        Math.max(0, Math.min(maximum, Math.min(previous, maximum) + delta))
      );
  };
  useInput(
    (_input, key) => {
      if (key.pageUp) move(-pageHeight);
      else if (key.pageDown) move(pageHeight);
    },
    { isActive: active }
  );
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={padding} overflow="hidden">
      {headerVisible && (
        <Text bold color="#70d7e5" wrap="truncate">
          {t("命令说明与快捷键")}
        </Text>
      )}
      <HitBox
        height={pageHeight}
        flexShrink={0}
        flexDirection="column"
        onWheel={(delta) => move(delta * 3)}
        overflow="hidden"
      >
        {lines.slice(offset, offset + pageHeight).map((line, index) => (
          <Text
            key={offset + index}
            color={line.accent ? "#70d7e5" : undefined}
            bold={line.accent}
            wrap="truncate"
          >
            {line.text || " "}
          </Text>
        ))}
      </HitBox>
      {footerVisible && (
        <Box height={1} flexShrink={0}>
          <HitBox onPress={() => move(-pageHeight)}>
            <Text color={offset ? "#70d7e5" : "#89969f"}>PgUp</Text>
          </HitBox>
          <Text color="#89969f"> / </Text>
          <HitBox onPress={() => move(pageHeight)}>
            <Text color={offset < maximum ? "#70d7e5" : "#89969f"}>PgDn</Text>
          </HitBox>
          <Text
            color="#89969f"
            wrap="truncate"
          >{` · ${offset + 1}–${Math.min(lines.length, offset + pageHeight)}/${lines.length} · ${t("滚轮翻阅")}`}</Text>
        </Box>
      )}
    </Box>
  );
}
