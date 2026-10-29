import { LANGUAGES, translate } from "./i18n";

/** Scriptable commands remain literal across languages so examples can be copied. */
export function help(language: string, version: string): string {
  const t = (source: string) => translate(source, language);
  const commands = [
    "init, connect [URL], login, logout, doctor, devices",
    "check-update, update",
    "profiles, use <ID>, profile create <name> <server>",
    "status, tasks, run <task>, start, stop",
    "wait [run_id], logs [count] [--follow], watch",
    "config get [/path], config set /path '<JSON>'",
    "packs, pack <name>, settings show|set|unset, reload",
  ].join("\n");
  const flags = [
    "--server <URL> | --pipe <path>, --profile <ID>, --lang <code>",
    "--json, --yes/-y, --read-only, --dry-run, --wait, --follow/-f",
    "--wait-timeout <seconds> (1–86400)",
    `--timeout <milliseconds> (${t("默认")} 15000), --server-key <public-key>`,
    "--config-home <directory>, --no-color, --help/-h, --version/-v",
  ].join("\n");
  return [
    `baasx ${version} · ${t("自动化终端")}`,
    "",
    t("用法：baasx [选项] [命令]"),
    t("无参数打开 baasx 交互工作台；--demo 使用内存演示环境。"),
    "",
    t("命令"),
    commands,
    "",
    t("选项"),
    flags,
    "",
    `${t("可用语言")}: ${LANGUAGES.map((item) => item.id).join(", ")}`,
    t("本地任务默认等待完成（最长 24 小时）；远程等待默认 300 秒。"),
    t("服务 Key 使用 BAAS_KEY 或隐藏输入，不保存到偏好文件。"),
    t("脚本和管道输入必须指定 baasx 命令。"),
    "",
  ].join("\n");
}
