import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { detectLanguage, LANGUAGES, translate } from "../src/i18n";
import zh from "../locales/zh.json";
import en from "../locales/en.json";
import ja from "../locales/ja.json";
import ko from "../locales/ko.json";
import de from "../locales/de.json";
import fr from "../locales/fr.json";
import ru from "../locales/ru.json";

const catalogs: Record<string, Record<string, string>> = { zh, en, ja, ko, de, fr, ru };
const core = [
  "总览",
  "任务",
  "配置档",
  "日志",
  "配置",
  "指令包",
  "语言",
  "选择语言",
  "欢迎回来，老师。",
  "今日的事务，交给 BAAS。",
  "首次设置",
  "选择运行方式",
  "安装本地环境",
  "连接已有服务",
  "自动安装 Python",
  "后端与运行依赖",
  "使用已有 BAAS 服务地址",
  "安装目录",
  "开始安装",
  "正在安装运行环境",
  "启动本地后端",
  "安装完成",
  "确认提交 BAAS 操作",
  "确认执行 [y]",
  "取消 [n]",
  "服务地址",
  "BAAS 登录 Key",
  "连接中",
  "已连接",
  "未连接",
  "Esc 取消",
  "Enter 确认",
  "↑↓ 选择",
  "Shift+Tab 切换页",
  "Ctrl+C 取消当前操作；空闲时退出",
  "配置分类",
  "编辑条目",
  "添加条目",
  "请输入有效数字",
  "调度设置",
  "下次执行时间",
  "新增任务默认状态",
  "选择下载源",
  "清理缓存",
  "检查并更新本地后端",
  "待执行",
  "队列",
  "步骤",
  "耗时",
  "进行中",
  "已完成",
  "失败",
  "等待中",
  "已跳过",
  "滚轮查看步骤 · 点击展开日志 · Esc 取消",
  "暂无日志",
  "安装进度",
  "更新进度",
  "baasx 工作台",
  "baasx 操作指南",
];

describe("CLI language selection", () => {
  test("offers the same seven languages as the desktop", () => {
    expect(LANGUAGES.map((item) => item.id)).toEqual(["zh", "en", "ja", "ko", "de", "fr", "ru"]);
    expect(new Set(LANGUAGES.map((item) => item.label)).size).toBe(7);
  });

  test("respects explicit, environment, saved, then system locale precedence", () => {
    expect(detectLanguage("ja", "ko", { BAAS_LANG: "de", LC_ALL: "fr_FR.UTF-8" })).toBe("ja");
    expect(detectLanguage(undefined, "ko", { BAAS_LANG: "de", LC_ALL: "fr_FR.UTF-8" })).toBe("de");
    expect(detectLanguage(undefined, "ko", { LC_ALL: "fr_FR.UTF-8", LANG: "ru_RU" })).toBe("ko");
    expect(
      detectLanguage(undefined, undefined, {
        LC_ALL: "fr_FR.UTF-8",
        LC_MESSAGES: "de_DE",
        LANG: "ru_RU",
      })
    ).toBe("fr");
    expect(detectLanguage(undefined, undefined, { LC_MESSAGES: "de_DE", LANG: "ru_RU" })).toBe(
      "de"
    );
    expect(detectLanguage(undefined, undefined, { LANG: "ru_RU.UTF-8" })).toBe("ru");
  });

  test("normalizes locale variants and uses English when no supported choice exists", () => {
    expect(detectLanguage(" ZH-hans-CN ", undefined, {})).toBe("zh");
    expect(detectLanguage("ja_JP.UTF-8", undefined, {})).toBe("ja");
    expect(detectLanguage("invalid", "fr", { BAAS_LANG: "unsupported" })).toBe("fr");
    expect(detectLanguage(undefined, undefined, { LC_ALL: "C.UTF-8", LANG: "ja_JP" })).toBe("en");
    expect(detectLanguage(undefined, undefined, { LANG: "POSIX" })).toBe("en");
    expect(detectLanguage(undefined, undefined, {})).toBe("en");
    expect(detectLanguage(undefined, undefined, { LANG: "es_ES" })).toBe("en");
  });
});

describe("source-key translations", () => {
  test("all workbench, typed editor, scheduling and runtime UI strings are covered", () => {
    const missing = new Set<string>();
    for (const file of [
      "workspace-view.tsx",
      "field-editor.tsx",
      "scheduler.ts",
      "workspace.ts",
      "runtime.ts",
      "installation.ts",
      "installation-view.tsx",
    ]) {
      const filename = new URL(`../src/${file}`, import.meta.url);
      const source = ts.createSourceFile(
        filename.pathname,
        readFileSync(filename, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isStringLiteral(node) ||
          ts.isJsxText(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)
        ) {
          const text = node.text.trim().replace(/\s+/g, " ");
          if (/[\p{Script=Han}]/u.test(text) && translate(text, "en") === text)
            missing.add(`${file}: ${text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect([...missing]).toEqual([]);
  });

  test("all seven independent catalogs cover every source key and preserve placeholders", () => {
    const keys = Object.keys(zh).sort();
    expect(keys.length).toBeGreaterThan(200);
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const language of LANGUAGES) {
      const catalog = catalogs[language.id];
      expect(Object.keys(catalog).sort()).toEqual(keys);
      for (const key of keys) {
        expect(catalog[key].trim().length).toBeGreaterThan(0);
        expect(placeholders(catalog[key])).toEqual(placeholders(key));
      }
    }
  });

  test("core menus, welcome, confirmations and installation have real translations in every locale", () => {
    for (const language of LANGUAGES.filter((item) => item.id !== "zh")) {
      for (const source of core) {
        expect(catalogs[language.id][source]).toBeDefined();
        expect(translate(source, language.id)).toBe(catalogs[language.id][source]);
        expect(translate(source, language.id)).not.toBe(source);
      }
    }
    for (const language of ["ja", "ko", "de", "fr", "ru"]) {
      expect(translate("首次设置", language)).not.toBe(translate("首次设置", "en"));
      expect(translate("安装本地环境", language)).not.toBe(translate("安装本地环境", "en"));
      expect(translate("欢迎回来，老师。", language)).not.toBe(translate("欢迎回来，老师。", "en"));
    }
  });

  test("keeps Chinese source text and unknown backend data unchanged", () => {
    const log = "后端返回自定义数据：设备 XYZ /value=123";
    for (const language of LANGUAGES) {
      expect(translate(log, language.id)).toBe(log);
      expect(translate("device_01 /config/name", language.id)).toBe("device_01 /config/name");
    }
    expect(translate("任务 mail · 已完成", "zh")).toBe("任务 mail · 已完成");
  });

  test("translates split JSX strings, decorations, whitespace and composed shortcuts", () => {
    expect(translate("  任务  ", "en")).toBe("  Tasks  ");
    expect(translate("● 已连接", "en")).toBe("● Connected");
    expect(translate(" · 夏莱工作台", "en")).toBe(" · Schale workspace");
    expect(translate("↑↓ 选择 · Enter 确认 · Esc 返回", "en")).toBe(
      "↑↓ select · Enter confirm · Esc back"
    );
    expect(translate("连接中\n安装完成", "fr")).toBe("Connexion en cours\nInstallation terminée");
    expect(translate("/connect 连接服务 → /profiles 选择配置档 → /tasks 执行任务", "en")).toBe(
      "/connect connect service → /profiles choose profile → /tasks run task"
    );
  });

  test("dynamic activity and form templates preserve task IDs, paths and numbers", () => {
    expect(translate("运行任务 task_42 · 已提交", "en")).toBe("Run task task_42 · Submitted");
    expect(translate("任务 task_42 · 已完成", "de")).toBe("Aufgabe task_42 · Abgeschlossen");
    expect(translate("修改 /settings/name · 输入 JSON", "en")).toBe(
      "Edit /settings/name · Enter JSON"
    );
    expect(translate("7 项任务 · 3 个指令", "en")).toBe("7 tasks · 3 commands");
    expect(translate("连接服务失败", "en")).toBe("Connect service failed");
    expect(translate("已载入 125 条运行日志", "en")).toBe("Loaded 125 log entries");
    expect(translate("已暂停跟随 · 向下滚动恢复 (42)", "en")).toBe(
      "Following paused · Scroll down to resume (42)"
    );
    expect(translate("/secret/$& 已更新", "en")).toBe("/secret/$& updated");
    expect(translate("未知指令：invalid。请使用 help 查看 BAAS 自动化命令。", "en")).toBe(
      "Unknown command: invalid. Use help for BAAS automation commands."
    );
  });

  test("unsupported translation locale falls back to English", () => {
    expect(translate("总览", "es")).toBe("Overview");
    expect(translate("安装完成", "ja-JP")).toBe("インストール完了");
  });

  test("schedule validation and runtime errors translate dynamic details without altering IDs", () => {
    expect(translate("优先级需要有效整数", "en")).toBe("Priority requires a valid integer");
    expect(translate("interval需要非负整数", "en")).toBe("interval requires a nonnegative integer");
    expect(translate("任务不存在：mail_1", "en")).toBe("Task not found: mail_1");
    expect(translate("调度字段不可编辑：next_tick", "en")).toBe(
      "Schedule field cannot be edited: next_tick"
    );
    expect(translate("安装组件返回的进度范围无效", "en")).toBe(
      "Runtime helper returned invalid progress range"
    );
    expect(translate("安装组件响应无效：安装组件返回的文件路径无效", "en")).toBe(
      "Invalid runtime helper response: Runtime helper returned invalid file paths"
    );
    expect(translate("安装组件退出（2）：custom backend error", "en")).toBe(
      "Runtime helper exited (2): custom backend error"
    );
    expect(translate("本地环境尚未安装完整：Python, Cpp", "en")).toBe(
      "Local runtime installation is incomplete: Python, Cpp"
    );
    for (const language of ["ja", "ko", "de", "fr", "ru"]) {
      for (const text of [
        "编辑条目",
        "调度设置",
        "当前为只读模式，不能修改调度",
        "安装组件返回的进度范围无效",
      ]) {
        expect(translate(text, language)).not.toBe(text);
        expect(translate(text, language)).not.toBe(translate(text, "en"));
      }
    }
  });
});
