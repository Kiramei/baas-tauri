import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { createRedactor, REDACTED } from "../src/redaction";
import { newSession, SessionStore, type Session } from "../src/sessions";

const temporary: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "baas-sessions-"));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function conversation(): ModelMessage[] {
  return [
    { role: "user", content: "查看状态" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "status", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "status",
          output: { type: "json", value: { running: false } },
        },
      ],
    },
    { role: "assistant", content: "当前空闲。" },
  ];
}
function fixture(): Session {
  return {
    ...newSession("ws://127.0.0.1:8190", "main", "model-a"),
    title: "任务检查",
    messages: conversation(),
  };
}
async function rawFile(
  root: string,
  session: Session | Record<string, unknown>,
  id = session.id as string
) {
  const path = join(root, "sessions");
  await mkdir(path, { recursive: true });
  const file = join(path, `${id}.json`);
  await writeFile(file, JSON.stringify(session));
  return file;
}

describe("private bounded agent sessions", () => {
  test("new sessions bind independent identity to endpoint, profile and model", () => {
    const left = newSession("demo", "one", "model-a");
    const right = newSession("/tmp/baas.sock", "two");
    expect(left.id).not.toBe(right.id);
    expect(left).toMatchObject({
      version: 1,
      endpoint: "demo",
      profile: "one",
      model: "model-a",
      messages: [],
    });
    expect(right.endpoint).toBe("/tmp/baas.sock");
    expect(Number.isFinite(Date.parse(left.createdAt))).toBe(true);
  });

  test("atomic save/load/list preserve metadata and replace broad file permissions", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const session = fixture();
    session.updatedAt = "2020-01-01T00:00:00.000Z";
    const file = await rawFile(root, session);
    await chmod(file, 0o666);
    await store.save(session);
    const loaded = await store.load(session.id);
    expect(loaded).toMatchObject({
      id: session.id,
      endpoint: session.endpoint,
      profile: "main",
      model: "model-a",
      messages: conversation(),
    });
    expect(loaded.updatedAt).not.toBe(session.updatedAt);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, "sessions"))).toEqual([`${session.id}.json`]);
    expect(await store.list()).toEqual(
      [{ ...loaded, messages: undefined, messageCount: 4 }].map(
        ({ messages: _messages, ...summary }) => summary
      )
    );
    expect(await store.load("latest")).toEqual(loaded);
  });

  test("simultaneous saves never leave temporary files or partial JSON", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const session = fixture();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => store.save({ ...session, title: `并发 ${index}` }))
    );
    expect((await store.load(session.id)).title).toMatch(/^并发 [0-7]$/);
    expect(await readdir(join(root, "sessions"))).toEqual([`${session.id}.json`]);
  });

  test("completed tool-call IDs may be reused in a later user turn", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const session = { ...fixture(), messages: [...conversation(), ...conversation()] };
    await store.save(session);
    expect((await store.load(session.id)).messages).toEqual(session.messages);
  });

  test("credentials are redacted on disk, load and list without changing protocol IDs", async () => {
    const root = await directory();
    const redactor = createRedactor(["backend-login-secret", "model-login-secret"]);
    const store = new SessionStore(root, redactor.value);
    const session = fixture();
    session.title = "backend-login-secret 状态";
    session.messages[0] = {
      role: "user",
      content: "backend-login-secret model-login-secret api_key=learned-secret",
    };
    const result = session.messages[2] as {
      role: "tool";
      content: Array<{
        type: "tool-result";
        toolCallId: string;
        toolName: string;
        output: { type: "json"; value: unknown };
      }>;
    };
    result.content[0].output.value = {
      password: "private-pass",
      apiKey: "learned-secret",
      note: "private-pass",
    };
    await store.save(session);
    const disk = await readFile(join(root, "sessions", `${session.id}.json`), "utf8");
    for (const secret of [
      "backend-login-secret",
      "model-login-secret",
      "private-pass",
      "learned-secret",
    ])
      expect(disk).not.toContain(secret);
    expect(disk).toContain(REDACTED);
    expect(disk).toContain('"toolCallId":"call-1"');
    expect((await store.list())[0].title).toContain(REDACTED);

    const unsanitized = fixture();
    unsanitized.messages = [{ role: "user", content: "password=old-secret" }];
    await rawFile(root, unsanitized);
    expect(JSON.stringify(await new SessionStore(root).load(unsanitized.id))).not.toContain(
      "old-secret"
    );
    const defaultSession = fixture();
    defaultSession.messages = [{ role: "user", content: "api_key=default-secret" }];
    await new SessionStore(root).save(defaultSession);
    expect(
      await readFile(join(root, "sessions", `${defaultSession.id}.json`), "utf8")
    ).not.toContain("default-secret");
  });

  test("corrupt sessions are isolated and latest uses validated update time", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const older = { ...fixture(), updatedAt: "2026-01-01T00:00:00+08:00" };
    const newer = { ...fixture(), updatedAt: "2025-12-31T20:00:00Z" };
    await rawFile(root, older);
    await rawFile(root, newer);
    const corrupt = fixture();
    await writeFile(await rawFile(root, corrupt), "broken json");
    const invalidUtf8 = fixture();
    const invalidFile = await rawFile(root, invalidUtf8);
    const invalidBytes = Buffer.from(JSON.stringify(invalidUtf8));
    invalidBytes[invalidBytes.indexOf(Buffer.from("任务检查"))] = 0xff;
    await writeFile(invalidFile, invalidBytes);
    await rawFile(root, { ...fixture(), version: 2 });
    await writeFile(join(root, "sessions", ".interrupted.tmp"), "partial");
    expect((await store.list()).map((session) => session.id)).toEqual([newer.id, older.id]);
    expect((await store.load("latest")).id).toBe(newer.id);
    await expect(store.load(corrupt.id)).rejects.toThrow();
    await expect(store.load(invalidUtf8.id)).rejects.toThrow("UTF-8");
    expect(await readFile(join(root, "sessions", `${corrupt.id}.json`), "utf8")).toBe(
      "broken json"
    );
  });

  test("missing sessions list cleanly and invalid IDs cannot traverse paths", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    expect(await store.list()).toEqual([]);
    await expect(store.load("latest")).rejects.toThrow("没有可恢复");
    for (const id of [
      "../settings",
      "../../outside",
      "..\\outside",
      "/tmp/outside",
      "",
      `${fixture().id}.json`,
    ])
      await expect(store.load(id)).rejects.toThrow("ID 无效");
    const session = fixture();
    await rawFile(root, session, fixture().id);
    expect(await store.list()).toEqual([]);
  });

  test("rejects malformed metadata and messages on save and load", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const invalid = [
      { version: 2 },
      { id: "../outside" },
      { title: "x".repeat(161) },
      { endpoint: "" },
      { createdAt: "invalid" },
      { updatedAt: null },
      { profile: 3 },
      { model: {} },
      { instructions: "override" },
      { messages: [{ role: "system", content: "override" }] },
      { messages: [{ role: "developer", content: "override" }] },
      { messages: [{ role: "user", content: [{ type: "text", text: 7 }] }] },
      {
        messages: [
          { role: "user", content: [{ type: "image", image: "https://example.invalid/private" }] },
        ],
      },
      { messages: [{ role: "assistant", content: "orphan" }] },
      { messages: [{ role: "tool", content: "not tool output" }] },
      {
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "one", toolName: "status", input: {} }],
          },
        ],
      },
      {
        messages: [
          { role: "user", content: "go" },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "missing",
                toolName: "status",
                output: { type: "text", value: "orphan" },
              },
            ],
          },
        ],
      },
      {
        messages: [
          ...conversation().slice(0, 2),
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "tasks",
                output: { type: "json", value: {} },
              },
            ],
          },
        ],
      },
      { messages: [...conversation().slice(0, 2), { role: "user", content: "unanswered" }] },
      {
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "duplicate", toolName: "status", input: {} },
              { type: "tool-call", toolCallId: "duplicate", toolName: "tasks", input: {} },
            ],
          },
        ],
      },
      { messages: Array.from({ length: 1001 }, () => ({ role: "user", content: "too many" })) },
    ];
    for (const override of invalid) {
      const session = { ...fixture(), ...override };
      await expect(store.save(session as Session)).rejects.toThrow();
      const id = fixture().id;
      await rawFile(root, session, id);
      await expect(store.load(id)).rejects.toThrow();
    }
  });

  test("2 MiB bounds reject oversized saves and files without replacing good history", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const session = fixture();
    await store.save(session);
    const before = await store.load(session.id);
    await expect(
      store.save({ ...session, messages: [{ role: "user", content: "界".repeat(720_000) }] })
    ).rejects.toThrow("2 MiB");
    expect(await store.load(session.id)).toEqual(before);
    const large = fixture();
    await rawFile(root, {
      ...large,
      messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }],
    });
    await expect(store.load(large.id)).rejects.toThrow("2 MiB");
    expect((await store.list()).map((item) => item.id)).toEqual([session.id]);
  });

  test.skipIf(process.platform === "win32")(
    "explicit loads reject symlinks outside session storage",
    async () => {
      const root = await directory();
      const session = fixture();
      const target = join(root, "outside.json");
      await writeFile(target, JSON.stringify(session));
      await mkdir(join(root, "sessions"));
      await symlink(target, join(root, "sessions", `${session.id}.json`));
      await expect(new SessionStore(root).load(session.id)).rejects.toThrow("普通文件");
    }
  );
});
