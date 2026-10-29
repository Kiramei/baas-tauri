import { describe, expect, test } from "bun:test";
import { help } from "../src/help";
import { LANGUAGES, translate } from "../src/i18n";

describe("seven-language CLI help", () => {
  test("every locale has translated prose and the same executable commands and flags", () => {
    const examples = [
      "init, connect [URL], login, logout, doctor, devices",
      "check-update, update",
      "profiles, use <ID>, profile create <name> <server>",
      "status, tasks, run <task>, start, stop",
      "wait [run_id], logs [count] [--follow], watch",
      "config get [/path], config set /path '<JSON>'",
      "packs, pack <name>, settings show|set|unset, reload",
    ];
    const flags = [
      "--server",
      "--pipe",
      "--profile",
      "--lang",
      "--demo",
      "--json",
      "--yes/-y",
      "--read-only",
      "--dry-run",
      "--wait",
      "--follow/-f",
      "--wait-timeout",
      "--timeout",
      "--server-key",
      "--config-home",
      "--no-color",
      "--help/-h",
      "--version/-v",
    ];
    for (const { id } of LANGUAGES) {
      const output = help(id, "9.8.7-test");
      expect(output).toStartWith(`baax 9.8.7-test · ${translate("自动化终端", id)}`);
      expect(output).toContain(translate("用法：baax [选项] [命令]", id));
      expect(output).toContain(translate("脚本和管道输入必须指定 baax 命令。", id));
      expect(output).toContain(
        translate("服务 Key 使用 BAAS_KEY 或隐藏输入，不保存到偏好文件。", id)
      );
      for (const example of examples) expect(output).toContain(example);
      for (const flag of flags) expect(output).toContain(flag);
      expect(output).toContain("1–86400");
      expect(output).toContain("300");
      expect(output).toContain(
        translate("本地任务默认等待完成（最长 24 小时）；远程等待默认 300 秒。", id)
      );
      expect(output).toContain("15000");
      expect(output).toContain("zh, en, ja, ko, de, fr, ru");
      expect(output).not.toContain("BAAS CLI");
      expect(output).not.toContain("Usage: baas ");
      expect(output).toEndWith("\n");
      expect(output).not.toContain("\u001b");
      expect(output).not.toMatch(/chat|chatbot|language model|BAAS\.md|sessions|resume/i);
    }
  });

  test("Japanese, Korean, German, French and Russian help are independent of English", () => {
    const english = help("en", "1.2.3");
    for (const language of ["ja", "ko", "de", "fr", "ru"]) {
      const output = help(language, "1.2.3");
      expect(output).not.toBe(english);
      expect(output).not.toContain("Usage:");
      expect(output).not.toContain("Scripts and piped input require");
    }
  });

  test("locale aliases normalize and an unsupported locale uses English", () => {
    expect(help("ja_JP.UTF-8", "1")).toBe(help("ja", "1"));
    expect(help("zh-Hans-CN", "1")).toBe(help("zh", "1"));
    expect(help("invalid", "1")).toBe(help("en", "1"));
  });

  test("new read-only installation and terminal exit messages are translated", () => {
    for (const { id } of LANGUAGES.filter((item) => item.id !== "zh")) {
      for (const source of [
        "退出终端",
        "当前为只读模式，不能安装运行环境",
        "安装运行环境 · 预演",
      ]) {
        expect(translate(source, id)).not.toBe(source);
      }
    }
  });
});
