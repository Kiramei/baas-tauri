import { modelMessageSchema, type ModelMessage } from "ai";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRedactor } from "./redaction";

export interface Session {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  endpoint: string;
  profile?: string;
  model?: string;
  messages: ModelMessage[];
}
export type SessionSummary = Omit<Session, "messages"> & { messageCount: number };
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_BYTES = 2 * 1024 * 1024;

export function newSession(endpoint: string, profile?: string, model?: string): Session {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    title: "新会话",
    createdAt: now,
    updatedAt: now,
    endpoint,
    profile,
    model,
    messages: [],
  };
}

function validate(value: unknown): Session {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("会话格式无效");
  const session = value as Session;
  if (
    session.version !== 1 ||
    typeof session.id !== "string" ||
    !ID.test(session.id) ||
    typeof session.title !== "string" ||
    !session.title.trim() ||
    session.title.length > 160 ||
    typeof session.endpoint !== "string" ||
    !session.endpoint.trim() ||
    session.endpoint.length > 4096
  )
    throw new Error("会话元数据无效");
  const fields = [
    "version",
    "id",
    "title",
    "createdAt",
    "updatedAt",
    "endpoint",
    "profile",
    "model",
    "messages",
  ];
  if (Object.keys(session).some((key) => !fields.includes(key)))
    throw new Error("会话包含未知元数据字段");
  for (const field of ["createdAt", "updatedAt"] as const)
    if (typeof session[field] !== "string" || !Number.isFinite(Date.parse(session[field])))
      throw new Error("会话日期无效");
  for (const field of ["profile", "model"] as const)
    if (
      session[field] !== undefined &&
      (typeof session[field] !== "string" ||
        !session[field]!.trim() ||
        session[field]!.length > 256)
    )
      throw new Error(`会话 ${field} 无效`);
  if (!Array.isArray(session.messages) || session.messages.length > 1000)
    throw new Error("会话消息无效");
  const parsed = modelMessageSchema.array().safeParse(session.messages);
  if (!parsed.success) throw new Error("会话消息格式无效");
  const pending = new Map<string, string>();
  let started = false;
  for (const message of parsed.data) {
    if (message.role === "system") throw new Error("会话不接受系统指令");
    if (message.role === "user") {
      if (pending.size) throw new Error("会话存在未回答的工具调用");
      if (Array.isArray(message.content) && message.content.some((part) => part.type !== "text"))
        throw new Error("会话用户消息仅支持文本");
      started = true;
    } else {
      if (!started) throw new Error("会话必须以用户消息开始");
      if (message.role === "assistant") {
        if (pending.size) throw new Error("会话存在未回答的工具调用");
        if (Array.isArray(message.content))
          for (const part of message.content) {
            if (part.type === "tool-call") {
              if (!part.toolCallId || !part.toolName || pending.has(part.toolCallId))
                throw new Error("会话工具调用 ID 无效或重复");
              pending.set(part.toolCallId, part.toolName);
            } else if (part.type !== "text" && part.type !== "reasoning")
              throw new Error("会话助手消息仅支持文本和本地工具调用");
          }
      } else
        for (const part of message.content) {
          if (part.type !== "tool-result" || pending.get(part.toolCallId) !== part.toolName)
            throw new Error("会话包含孤立或不匹配的工具结果");
          if (
            !["text", "json", "error-text", "error-json", "execution-denied"].includes(
              part.output.type
            )
          )
            throw new Error("会话工具结果仅支持文本或 JSON");
          pending.delete(part.toolCallId);
        }
    }
  }
  if (pending.size) throw new Error("会话存在未回答的工具调用");
  return { ...session, messages: parsed.data as ModelMessage[] };
}

export class SessionStore {
  private directory: string;
  constructor(
    configurationDirectory: string,
    private sanitize: (value: unknown) => unknown = createRedactor().value
  ) {
    this.directory = join(configurationDirectory, "sessions");
  }

  async save(session: Session): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(session)) > MAX_BYTES)
      throw new Error("会话超过 2 MiB，未保存");
    validate(session);
    const safe = validate(this.sanitize({ ...session, updatedAt: new Date().toISOString() }));
    const text = `${JSON.stringify(safe)}\n`;
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("会话超过 2 MiB，未保存");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${safe.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.directory, `${safe.id}.json`));
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async load(id: string): Promise<Session> {
    if (id === "latest") {
      const summaries = await this.list();
      if (!summaries.length) throw new Error("没有可恢复的会话");
      id = summaries[0].id;
    }
    if (typeof id !== "string" || !ID.test(id))
      throw new Error("会话 ID 无效，请用 sessions 查看精确 ID");
    const path = join(this.directory, `${id}.json`);
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("会话路径必须是普通文件");
    if (info.size > MAX_BYTES) throw new Error("会话文件超过 2 MiB");
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_BYTES) throw new Error("会话文件超过 2 MiB");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("会话文件不是有效 UTF-8 文本");
    }
    const session = validate(JSON.parse(text));
    if (session.id !== id) throw new Error("会话 ID 与文件名不一致");
    return validate(this.sanitize(session));
  }

  async list(): Promise<SessionSummary[]> {
    let files;
    try {
      files = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const sessions: SessionSummary[] = [];
    // A damaged session must not prevent listing or recovering healthy ones.
    for (const file of files.filter(
      (item) =>
        item.isFile() && ID.test(item.name.replace(/\.json$/, "")) && item.name.endsWith(".json")
    )) {
      try {
        const { messages, ...session } = await this.load(file.name.slice(0, -5));
        sessions.push({ ...session, messageCount: messages.length });
      } catch {
        /* Invalid sessions remain on disk for manual inspection. */
      }
    }
    return sessions.sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)
    );
  }
}
