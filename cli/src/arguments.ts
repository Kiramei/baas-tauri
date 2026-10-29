import { parseArgs } from "node:util";

export function parseArguments(args: string[]) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      demo: { type: "boolean" },
      json: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "read-only": { type: "boolean" },
      "dry-run": { type: "boolean" },
      wait: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      "wait-timeout": { type: "string" },
      resume: { type: "string" },
      "no-session": { type: "boolean" },
      instructions: { type: "string" },
      "no-color": { type: "boolean" },
      server: { type: "string" },
      pipe: { type: "string" },
      profile: { type: "string" },
      "server-key": { type: "string" },
      timeout: { type: "string" },
      model: { type: "string" },
      "ai-url": { type: "string" },
      "config-home": { type: "string" },
      print: { type: "string", short: "p" },
    },
  });
  const timeout = Number(parsed.values.timeout ?? 15000);
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 300000) {
    throw new Error("--timeout 必须是 100 到 300000 之间的毫秒数");
  }
  if (parsed.values.server && parsed.values.pipe)
    throw new Error("--server 和 --pipe 只能选择一种连接方式");
  if (parsed.values.yes && parsed.values["read-only"])
    throw new Error("--yes 和 --read-only 不能同时使用");
  const waitTimeoutMs = Number(parsed.values["wait-timeout"] ?? 300) * 1000;
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 1000 || waitTimeoutMs > 86400000)
    throw new Error("--wait-timeout 必须是 1–86400 之间的秒数");
  if (parsed.values.resume && parsed.values["no-session"])
    throw new Error("--resume 和 --no-session 不能同时使用");
  return { ...parsed, timeout, waitTimeoutMs };
}

/** Small shell-style tokenizer: quotes are for arguments, never shell evaluation. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "",
    quote = "",
    escaped = false,
    started = false;
  for (const char of line.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote || escaped) throw new Error("引号或转义未结束");
  if (started) tokens.push(current);
  return tokens;
}
