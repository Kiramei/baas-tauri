import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ModelMessage } from "ai";
import {
  AGENT_LIMITS,
  AgentLimitError,
  listModels,
  runAgent,
  type ActionDefinition,
  type AgentEvent,
} from "../src/agent";
import { REDACTED } from "../src/redaction";

type Call = { name: string; args: unknown; raw?: string };
type Step = { text?: string[]; calls?: Call[]; hold?: boolean; status?: number; error?: string };
type RequestBody = {
  messages: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
  [key: string]: unknown;
};

const actions: ActionDefinition[] = [
  {
    name: "status",
    description: "Read the backend status",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    mutating: false,
  },
  {
    name: "config_set",
    description: "Change a setting",
    mutating: true,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, value: { type: "boolean" } },
      required: ["path", "value"],
      additionalProperties: false,
    },
  },
];

async function provider(steps: Step[]) {
  const requests: RequestBody[] = [];
  const authorizations: Array<string | undefined> = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      assert.equal(request.url, "/v1/chat/completions");
      authorizations.push(request.headers.authorization);
      requests.push(JSON.parse(body) as RequestBody);
      writeStep(response, steps[Math.min(requests.length - 1, steps.length - 1)], requests.length);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    config: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" },
    requests,
    authorizations,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function writeStep(response: ServerResponse, step: Step, number: number) {
  if (step.status) {
    response.writeHead(step.status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: step.error ?? "Provider failed" } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: unknown, reason: string | null = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: `response-${number}`,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: reason }],
      })}\n\n`
    );
  send({ role: "assistant" });
  for (const text of step.text ?? []) send({ content: text });
  for (const [index, call] of (step.calls ?? []).entries()) {
    send({
      tool_calls: [
        {
          index,
          id: `call-${number}-${index}`,
          type: "function",
          function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.args) },
        },
      ],
    });
  }
  if (step.hold) return;
  send({}, step.calls?.length ? "tool_calls" : "stop");
  response.end("data: [DONE]\n\n");
}

test("agent streams a real tool loop and approves a mutation after reading state", async () => {
  const mock = await provider([
    { calls: [{ name: "status", args: {} }] },
    { calls: [{ name: "config_set", args: { path: "/enabled", value: true } }] },
    { text: ["已", "更新。"] },
  ]);
  const order: string[] = [];
  const events: AgentEvent[] = [];
  try {
    const result = await runAgent({
      prompt: "查看状态，然后启用调度",
      config: { ...mock.config, apiKey: "test-key" },
      actions,
      execute: async (name, args) => {
        order.push(name);
        return name === "status" ? { enabled: false } : { enabled: args.value };
      },
      approve: async (name, args) => {
        order.push(`approve:${name}`);
        assert.equal(args.path, "/enabled");
        return true;
      },
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.text, "已更新。");
    assert.deepEqual(order, ["status", "approve:config_set", "config_set"]);
    assert.deepEqual(
      result.history.map((message) => message.role),
      ["user", "assistant", "tool", "assistant", "tool", "assistant"]
    );
    assert.ok(
      mock.requests[1].messages.some(
        (message) => message.role === "tool" && message.content.includes('"enabled":false')
      )
    );
    assert.ok(
      mock.requests[2].messages.some(
        (message) => message.role === "tool" && message.content.includes('"enabled":true')
      )
    );
    assert.ok(mock.authorizations.every((value) => value === "Bearer test-key"));
    assert.ok(mock.requests.every((request) => request.max_tokens === 4096));
    assert.equal(
      events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text)
        .join(""),
      "已更新。"
    );
    assert.equal(events.filter((event) => event.type === "approval-required").length, 1);
    assert.equal(events.at(-1)?.type, "finish");
  } finally {
    mock.close();
  }
});

test("denial reaches the model without submitting a mutation", async () => {
  const mock = await provider([
    { calls: [{ name: "config_set", args: { path: "/enabled", value: true } }] },
    { text: ["操作已取消。"] },
  ]);
  let executions = 0;
  const events: AgentEvent[] = [];
  try {
    const result = await runAgent({
      prompt: "启用调度",
      config: mock.config,
      actions,
      execute: async () => {
        executions++;
      },
      approve: async () => false,
      onEvent: (event) => events.push(event),
    });
    assert.equal(executions, 0);
    assert.equal(result.text, "操作已取消。");
    assert.ok(events.some((event) => event.type === "tool-denied"));
    assert.ok(
      mock.requests[1].messages.some(
        (message) => message.role === "tool" && message.content.includes('"denied":true')
      )
    );
    assert.ok(
      mock.authorizations.every((value) => value === undefined),
      "local providers do not require a fabricated API key"
    );
  } finally {
    mock.close();
  }
});

test("parallel model calls still approve and execute serially", async () => {
  const mock = await provider([
    {
      calls: [
        { name: "status", args: {} },
        { name: "config_set", args: { path: "/enabled", value: true } },
        { name: "status", args: {} },
      ],
    },
    { text: ["完成"] },
  ]);
  const order: string[] = [];
  let active = 0;
  let maximum = 0;
  try {
    await runAgent({
      prompt: "读取并修改",
      config: mock.config,
      actions,
      execute: async (name) => {
        maximum = Math.max(maximum, ++active);
        order.push(`start:${name}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${name}`);
        active--;
        return { ok: true };
      },
      approve: async (name) => {
        order.push(`approve:${name}`);
        return true;
      },
    });
    assert.equal(maximum, 1);
    assert.deepEqual(order, [
      "start:status",
      "end:status",
      "approve:config_set",
      "start:config_set",
      "end:config_set",
      "start:status",
      "end:status",
    ]);
  } finally {
    mock.close();
  }
});

for (const [label, call] of [
  ["unknown tool", { name: "shell", args: {} }],
  ["prototype name", { name: "__proto__", args: {} }],
  ["malformed JSON", { name: "status", args: {}, raw: "{broken" }],
  ["schema mismatch", { name: "config_set", args: { path: "/enabled", value: "yes" } }],
  ["extra parameters", { name: "status", args: { shell: "unsafe" } }],
] satisfies Array<[string, Call]>) {
  test(`rejects ${label} before reaching backend or approval`, async () => {
    const mock = await provider([{ calls: [call] }, { text: ["无法执行。"] }]);
    let executions = 0;
    let approvals = 0;
    const events: AgentEvent[] = [];
    try {
      await runAgent({
        prompt: "执行",
        config: mock.config,
        actions,
        execute: async () => {
          executions++;
        },
        approve: async () => {
          approvals++;
          return true;
        },
        onEvent: (event) => events.push(event),
      });
      assert.equal(executions, 0);
      assert.equal(approvals, 0);
      assert.ok(events.some((event) => event.type === "tool-error"));
    } finally {
      mock.close();
    }
  });
}

test("cancelled signals and missing model configuration fail before network access", async () => {
  const base = { prompt: "hello", actions, execute: async () => null, approve: async () => true };
  await assert.rejects(runAgent({ ...base, config: {} }), /explicit model/);
  const controller = new AbortController();
  controller.abort(new DOMException("Cancelled by user", "AbortError"));
  await assert.rejects(runAgent({ ...base, config: {}, signal: controller.signal }), {
    name: "AbortError",
  });
});

test("cancellation interrupts an outstanding approval and prevents queued mutations", async () => {
  const mock = await provider([
    {
      calls: [
        { name: "config_set", args: { path: "/enabled", value: true } },
        { name: "config_set", args: { path: "/enabled", value: false } },
      ],
    },
  ]);
  const controller = new AbortController();
  let executions = 0;
  let approvals = 0;
  try {
    await assert.rejects(
      runAgent({
        prompt: "修改",
        config: mock.config,
        actions,
        signal: controller.signal,
        execute: async () => {
          executions++;
        },
        approve: async () => {
          approvals++;
          controller.abort(new DOMException("Cancelled by user", "AbortError"));
          return new Promise<boolean>(() => undefined);
        },
      }),
      { name: "AbortError" }
    );
    assert.equal(approvals, 1);
    assert.equal(executions, 0);
  } finally {
    mock.close();
  }
});

test("cancellation interrupts a stalled provider stream", async () => {
  const mock = await provider([{ text: ["开始读取".repeat(40)], hold: true }]);
  const controller = new AbortController();
  try {
    await assert.rejects(
      runAgent({
        prompt: "读取",
        config: mock.config,
        actions,
        signal: controller.signal,
        execute: async () => null,
        approve: async () => true,
        onEvent: (event) => {
          if (event.type === "text-delta")
            controller.abort(new DOMException("Cancelled", "AbortError"));
        },
      }),
      { name: "AbortError" }
    );
  } finally {
    mock.close();
  }
});

test("tool output is bounded before entering model history", async () => {
  const mock = await provider([
    { calls: [{ name: "status", args: {} }] },
    { text: ["结果过长。"] },
  ]);
  try {
    await runAgent({
      prompt: "读取",
      config: mock.config,
      actions,
      execute: async () => ({ data: "x".repeat(20_000) }),
      approve: async () => true,
    });
    const tool = mock.requests[1].messages.find((message) => message.role === "tool");
    assert.ok(tool);
    const output = JSON.parse(tool.content) as { truncated: boolean; preview: string };
    assert.equal(output.truncated, true);
    assert.equal(output.preview.length, AGENT_LIMITS.toolOutputCharacters);
  } finally {
    mock.close();
  }
});

test("backend failures are tool results and do not claim success", async () => {
  const mock = await provider([
    { calls: [{ name: "status", args: {} }] },
    { text: ["后端不可用。"] },
  ]);
  const events: AgentEvent[] = [];
  try {
    await runAgent({
      prompt: "读取",
      config: mock.config,
      actions,
      execute: async () => {
        throw new Error("Backend offline");
      },
      approve: async () => true,
      onEvent: (event) => events.push(event),
    });
    assert.ok(
      mock.requests[1].messages.some(
        (message) => message.role === "tool" && message.content.includes("Backend offline")
      )
    );
    assert.ok(
      events.some((event) => event.type === "tool-error" && event.error === "Backend offline")
    );
  } finally {
    mock.close();
  }
});

test("loop step bound stops a model that keeps requesting tools", async () => {
  const mock = await provider([{ calls: [{ name: "status", args: {} }] }]);
  let executions = 0;
  try {
    await assert.rejects(
      runAgent({
        prompt: "重复读取",
        config: mock.config,
        actions,
        execute: async () => {
          executions++;
          return { ok: true };
        },
        approve: async () => true,
      }),
      AgentLimitError
    );
    assert.equal(mock.requests.length, AGENT_LIMITS.steps);
    assert.equal(executions, AGENT_LIMITS.steps);
  } finally {
    mock.close();
  }
});

test("tool-call bound stops a single oversized batch", async () => {
  const mock = await provider([
    {
      calls: Array.from({ length: AGENT_LIMITS.toolCalls + 1 }, () => ({
        name: "status",
        args: {},
      })),
    },
  ]);
  let executions = 0;
  try {
    await assert.rejects(
      runAgent({
        prompt: "读取",
        config: mock.config,
        actions,
        execute: async () => {
          executions++;
          return {};
        },
        approve: async () => true,
      }),
      AgentLimitError
    );
    assert.ok(executions <= AGENT_LIMITS.toolCalls);
  } finally {
    mock.close();
  }
});

test("tool-call bound also counts unknown tools", async () => {
  const mock = await provider([
    {
      calls: Array.from({ length: AGENT_LIMITS.toolCalls + 1 }, () => ({
        name: "unknown_tool",
        args: {},
      })),
    },
  ]);
  try {
    await assert.rejects(
      runAgent({
        prompt: "读取",
        config: mock.config,
        actions,
        execute: async () => {
          assert.fail("Unknown tools must not execute");
        },
        approve: async () => true,
      }),
      AgentLimitError
    );
  } finally {
    mock.close();
  }
});

test("streamed model output and tool arguments have hard size bounds", async () => {
  for (const step of [
    { text: ["x".repeat(AGENT_LIMITS.modelOutputCharacters + 1)] },
    {
      calls: [
        {
          name: "config_set",
          args: { path: "x".repeat(AGENT_LIMITS.argumentCharacters + 1), value: true },
        },
      ],
    },
  ]) {
    const mock = await provider([step]);
    let executions = 0;
    try {
      await assert.rejects(
        runAgent({
          prompt: "读取",
          config: mock.config,
          actions,
          execute: async () => {
            executions++;
          },
          approve: async () => true,
        }),
        AgentLimitError
      );
      assert.equal(executions, 0);
    } finally {
      mock.close();
    }
  }
});

test("history drops whole old turns and preserves tool-call/result pairs", async () => {
  const mock = await provider([{ text: ["当前回答"] }]);
  const history: ModelMessage[] = [];
  for (let index = 0; index < AGENT_LIMITS.historyTurns + 1; index++) {
    history.push(
      { role: "user", content: `previous-${index}` },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: `old-${index}`, toolName: "status", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `old-${index}`,
            toolName: "status",
            output: { type: "json", value: {} },
          },
        ],
      },
      { role: "assistant", content: "ok" }
    );
  }
  try {
    const result = await runAgent({
      prompt: "当前请求",
      config: mock.config,
      actions,
      history,
      execute: async () => null,
      approve: async () => true,
    });
    assert.equal(
      result.history.filter((message) => message.role === "user").length,
      AGENT_LIMITS.historyTurns
    );
    assert.equal(result.history[0].role, "user");
    for (const [index, message] of result.history.entries()) {
      if (message.role === "tool") assert.equal(result.history[index - 1].role, "assistant");
    }
    assert.ok(JSON.stringify(result.history).length <= AGENT_LIMITS.historyCharacters);
  } finally {
    mock.close();
  }
});

test("invalid and duplicate registered tool names fail before making requests", async () => {
  const base = {
    prompt: "读取",
    config: { model: "test-model", baseUrl: "http://127.0.0.1:1/v1" },
    execute: async () => null,
    approve: async () => true,
  };
  await assert.rejects(
    runAgent({ ...base, actions: [{ ...actions[0], name: "constructor" }] }),
    /Invalid agent tool name/
  );
  await assert.rejects(
    runAgent({ ...base, actions: [actions[0], actions[0]] }),
    /Duplicate agent tool/
  );
});

const credentialActions: ActionDefinition[] = [
  {
    ...actions[1],
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, value: {} },
      required: ["path", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "config_get",
    description: "Read configuration",
    mutating: false,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
  },
];

test("credential reads are redacted from provider context, tool events and returned history", async () => {
  const mock = await provider([
    { calls: [{ name: "config_get", args: {} }] },
    { calls: [{ name: "config_get", args: { path: "/push_telegram_bot_token" } }] },
    { text: ["凭据已隐藏。"] },
  ]);
  const events: AgentEvent[] = [];
  try {
    const result = await runAgent({
      prompt: "检查推送配置",
      config: mock.config,
      actions: credentialActions,
      execute: async (_name, args) =>
        args.path
          ? "telegram-private-value"
          : {
              name: "夏莱",
              api_key: "configuration-private-value",
              nested: { push_telegram_bot_token: "telegram-private-value" },
            },
      approve: async () => true,
      onEvent: (event) => events.push(event),
    });
    for (const serialized of [
      JSON.stringify(mock.requests.slice(1)),
      JSON.stringify(result.history),
      JSON.stringify(events),
    ]) {
      assert.ok(!serialized.includes("configuration-private-value"));
      assert.ok(!serialized.includes("telegram-private-value"));
      assert.ok(serialized.includes(REDACTED));
    }
  } finally {
    mock.close();
  }
});

test("credential writes execute raw arguments but scrub approval events, context and persisted history", async () => {
  const privateValue = "new-credential-private-value";
  const mock = await provider([
    { calls: [{ name: "config_set", args: { path: "/password", value: privateValue } }] },
    { text: ["设置已更新。", privateValue.slice(0, 12), privateValue.slice(12)] },
  ]);
  const events: AgentEvent[] = [];
  let executed = "";
  try {
    const result = await runAgent({
      prompt: "更新凭据",
      config: mock.config,
      actions: credentialActions,
      approve: async (_name, args) => {
        assert.equal(args.value, privateValue);
        return true;
      },
      execute: async (_name, args) => {
        executed = String(args.value);
        return { saved: true, value: args.value };
      },
      onEvent: (event) => events.push(event),
    });
    assert.equal(executed, privateValue);
    assert.ok(!JSON.stringify(mock.requests[1]).includes(privateValue));
    assert.ok(!JSON.stringify(result.history).includes(privateValue));
    assert.ok(!JSON.stringify(events).includes(privateValue));
    assert.ok(!result.text.includes(privateValue));
    const approval = events.find((event) => event.type === "approval-required");
    assert.ok(approval && approval.type === "approval-required");
    assert.equal(approval.args.value, REDACTED);
  } finally {
    mock.close();
  }
});

test("schema-invalid credential calls cannot leak values through SDK error events", async () => {
  const privateValue = "invalid-schema-private-value";
  const mock = await provider([
    { calls: [{ name: "config_set", args: { path: "/password", value: privateValue } }] },
    { text: ["参数类型有误。"] },
  ]);
  const events: AgentEvent[] = [];
  try {
    const result = await runAgent({
      prompt: "修改",
      config: mock.config,
      actions,
      execute: async () => {
        assert.fail("Invalid call executed");
      },
      approve: async () => {
        assert.fail("Invalid call requested approval");
      },
      onEvent: (event) => events.push(event),
    });
    assert.ok(!JSON.stringify(events).includes(privateValue));
    assert.ok(!JSON.stringify(result.history).includes(privateValue));
    assert.ok(!JSON.stringify(mock.requests[1]).includes(privateValue));
  } finally {
    mock.close();
  }
});

test("denied mutations cannot be retried with changed arguments during the same turn", async () => {
  const mock = await provider([
    {
      calls: [
        { name: "config_set", args: { path: "/one", value: true } },
        { name: "config_set", args: { path: "/two", value: false } },
      ],
    },
    { calls: [{ name: "config_set", args: { path: "/alternative", value: true } }] },
    { text: ["修改已取消。"] },
  ]);
  let approvals = 0;
  let executions = 0;
  try {
    await runAgent({
      prompt: "修改配置",
      config: mock.config,
      actions,
      execute: async () => {
        executions++;
      },
      approve: async () => {
        approvals++;
        return false;
      },
    });
    assert.equal(approvals, 1);
    assert.equal(executions, 0);
  } finally {
    mock.close();
  }
});

test("redaction placeholders can never overwrite real configuration", async () => {
  const mock = await provider([
    { calls: [{ name: "config_set", args: { path: "/password", value: REDACTED } }] },
    { text: ["请用直接配置命令设置凭据。"] },
  ]);
  let approvals = 0;
  let executions = 0;
  try {
    await runAgent({
      prompt: "修改凭据",
      config: mock.config,
      actions: credentialActions,
      execute: async () => {
        executions++;
      },
      approve: async () => {
        approvals++;
        return true;
      },
    });
    assert.equal(approvals, 0);
    assert.equal(executions, 0);
    assert.ok(
      mock.requests[1].messages.some(
        (message) =>
          message.role === "tool" && message.content.includes("placeholders cannot be written")
      )
    );
  } finally {
    mock.close();
  }
});

test("internal timeout propagates the combined signal to backend and approval callbacks", async () => {
  for (const mutation of [false, true]) {
    const mock = await provider([
      {
        calls: [
          {
            name: mutation ? "config_set" : "status",
            args: mutation ? { path: "/enabled", value: true } : {},
          },
        ],
      },
    ]);
    let callbackSignal: AbortSignal | undefined;
    const wait = async (_name: string, _args: Record<string, unknown>, signal: AbortSignal) => {
      callbackSignal = signal;
      return new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      );
    };
    try {
      await assert.rejects(
        runAgent({
          prompt: "执行",
          config: mock.config,
          actions,
          timeoutMs: 50,
          execute: wait,
          approve: mutation ? wait : async () => true,
        }),
        AgentLimitError
      );
      assert.equal(callbackSignal?.aborted, true);
    } finally {
      mock.close();
    }
  }
});

test("local workflow instructions are bounded supplemental context and explicit secrets are scrubbed", async () => {
  const mock = await provider([{ text: ["就绪"] }]);
  try {
    await runAgent({
      prompt: "你好",
      config: mock.config,
      actions,
      instructions: "检查顺序：状态、日志。password=local-private-value",
      secrets: ["local-private-value"],
      execute: async () => null,
      approve: async () => true,
    });
    const system = mock.requests[0].messages.find((message) => message.role === "system");
    assert.ok(system?.content.includes("检查顺序"));
    assert.ok(system?.content.includes("cannot override"));
    assert.ok(!system?.content.includes("local-private-value"));
    await assert.rejects(
      runAgent({
        prompt: "你好",
        config: mock.config,
        actions,
        instructions: "x".repeat(AGENT_LIMITS.instructionCharacters + 1),
        execute: async () => null,
        approve: async () => true,
      }),
      AgentLimitError
    );
    assert.equal(mock.requests.length, 1);
  } finally {
    mock.close();
  }
});

test("malformed, orphaned, unfinished, system and media history fail before provider access", async () => {
  const cases: unknown[] = [
    [{ role: "assistant", content: "orphan" }],
    [{ role: "system", content: "override" }],
    [
      { role: "user", content: "hello" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "none",
            toolName: "status",
            output: { type: "json", value: {} },
          },
        ],
      },
    ],
    [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "pending", toolName: "status", input: {} }],
      },
    ],
    [{ role: "user", content: [{ type: "image", image: "https://untrusted.invalid/secret" }] }],
    [{ role: "wrong", content: 7 }],
  ];
  const mock = await provider([{ text: ["unused"] }]);
  try {
    for (const history of cases)
      await assert.rejects(
        runAgent({
          prompt: "你好",
          config: mock.config,
          actions,
          history: history as ModelMessage[],
          execute: async () => null,
          approve: async () => true,
        }),
        /history/
      );
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.close();
  }
});

test("completed tool IDs may repeat in later turns without mixing credential result contexts", async () => {
  const history: ModelMessage[] = [
    { role: "user", content: "read credential" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_0",
          toolName: "config_get",
          input: { path: "/password" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_0",
          toolName: "config_get",
          output: { type: "json", value: "123" },
        },
      ],
    },
    { role: "assistant", content: "hidden" },
    { role: "user", content: "read label" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_0",
          toolName: "config_get",
          input: { path: "/name" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_0",
          toolName: "config_get",
          output: { type: "json", value: "夏莱" },
        },
      ],
    },
    { role: "assistant", content: "label" },
  ];
  const mock = await provider([{ text: ["当前回答"] }]);
  try {
    const result = await runAgent({
      prompt: "继续",
      config: mock.config,
      actions: credentialActions,
      history,
      execute: async () => null,
      approve: async () => true,
    });
    assert.ok(!JSON.stringify(mock.requests[0].messages).includes('\\"123\\"'));
    const outputs = result.history
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .map((part) =>
        part.type === "tool-result" && "value" in part.output ? part.output.value : null
      );
    assert.deepEqual(outputs, [REDACTED, "夏莱"]);
  } finally {
    mock.close();
  }
});

test("empty provider responses fail clearly instead of appearing successful", async () => {
  const mock = await provider([{}]);
  try {
    await assert.rejects(
      runAgent({
        prompt: "你好",
        config: mock.config,
        actions,
        execute: async () => null,
        approve: async () => true,
      }),
      /empty response/
    );
  } finally {
    mock.close();
  }
});

async function modelServer(
  payload: unknown,
  options: { status?: number; raw?: string; hold?: boolean; declaredSize?: number } = {}
) {
  const requests: Array<{ url?: string; method?: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
    });
    response.writeHead(options.status ?? 200, {
      "content-type": "application/json",
      ...(options.declaredSize ? { "content-length": String(options.declaredSize) } : {}),
    });
    if (options.hold) {
      response.flushHeaders();
      return;
    }
    response.end(options.raw ?? JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    config: { baseUrl: `http://127.0.0.1:${address.port}/v1/` },
    requests,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test("model discovery requests the configured authenticated /models endpoint and keeps all unique IDs", async () => {
  const mock = await modelServer({
    object: "list",
    data: [
      { id: "provider/new-model", owned_by: "local" },
      { id: "other-model" },
      { id: "provider/new-model", owned_by: "duplicate" },
    ],
  });
  try {
    assert.deepEqual(await listModels({ ...mock.config, apiKey: "local-provider-key" }), [
      { id: "provider/new-model", ownedBy: "local" },
      { id: "other-model" },
    ]);
    assert.deepEqual(mock.requests, [
      { url: "/v1/models", method: "GET", authorization: "Bearer local-provider-key" },
    ]);
  } finally {
    mock.close();
  }
});

test("model discovery validates malformed, paginated and control-character model listings", async () => {
  for (const payload of [
    { models: [] },
    { data: [{ id: "bad\nmodel" }] },
    { data: [{ id: "" }] },
    { data: [{ id: "model", owned_by: {} }] },
    { data: [], has_more: true },
  ]) {
    const mock = await modelServer(payload);
    try {
      await assert.rejects(listModels(mock.config), /Model listing|model list|provider returned/);
    } finally {
      mock.close();
    }
  }
});

test("model discovery bounds the response and never echoes provider error bodies", async () => {
  for (const options of [
    { declaredSize: AGENT_LIMITS.modelListBytes + 1 },
    { raw: "x".repeat(AGENT_LIMITS.modelListBytes + 1) },
    { raw: "invalid-json-private-value" },
    { status: 401, raw: "provider-private-response" },
  ]) {
    const mock = await modelServer({}, options);
    try {
      await assert.rejects(
        listModels(mock.config),
        (error) => error instanceof Error && !error.message.includes("private")
      );
    } finally {
      mock.close();
    }
  }
});

test("model discovery honors external cancellation even while response bytes are stalled", async () => {
  const mock = await modelServer({}, { hold: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Cancelled", "AbortError")), 25);
  try {
    await assert.rejects(listModels(mock.config, controller.signal), { name: "AbortError" });
  } finally {
    clearTimeout(timer);
    mock.close();
  }
});

test("model discovery rejects cross-origin redirects before forwarding provider credentials", async () => {
  const target = await modelServer({ data: [{ id: "must-not-be-requested" }] });
  const privateKey = "redirect-provider-private-key";
  const receivedKeys: Array<string | undefined> = [];
  const redirector = createServer((request, response) => {
    receivedKeys.push(request.headers.authorization);
    response.writeHead(302, { location: `${target.config.baseUrl}models` });
    response.end();
  });
  redirector.listen(0, "127.0.0.1");
  await once(redirector, "listening");
  const address = redirector.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      listModels({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: privateKey }),
      (error) => error instanceof Error && !error.message.includes(privateKey)
    );
    assert.deepEqual(receivedKeys, [`Bearer ${privateKey}`]);
    assert.equal(
      target.requests.length,
      0,
      "redirect target must receive no request or Authorization header"
    );
  } finally {
    redirector.closeAllConnections();
    redirector.close();
    target.close();
  }
});

async function cli(
  args: string[],
  environment: Record<string, string> = {},
  onSpawn?: (child: ChildProcess) => void,
  configurationDirectory?: string
) {
  const directory = configurationDirectory ?? (await mkdtemp(join(tmpdir(), "baas-agent-cli-")));
  const env = { ...process.env };
  for (const name of [
    "BAAS_SERVER",
    "BAAS_KEY",
    "BAAS_PROFILE",
    "BAAS_MODEL",
    "BAAS_AI_MODEL",
    "BAAS_AI_API_KEY",
    "BAAS_AI_BASE_URL",
    "BAAS_PIPE",
    "BAAS_CLI_HOME",
  ])
    delete env[name];
  const child = spawn(process.execPath, ["cli/src/index.ts", "--config-home", directory, ...args], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    onSpawn?.(child);
    const [code, signal] = (await once(child, "close")) as [number | null, string | null];
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(timer);
    child.kill();
    if (!configurationDirectory) await rm(directory, { recursive: true, force: true });
  }
}

test("CLI JSON agent preserves accepted-only results and binds the selected profile", async () => {
  const mock = await provider([
    { calls: [{ name: "scheduler_start", args: {} }] },
    { calls: [{ name: "status", args: {} }] },
    { text: ["调度已提交，尚未完成。"] },
  ]);
  try {
    const result = await cli(
      ["--demo", "--json", "--yes", "--profile", "sensei-jp", "-p", "启动当前配置的调度"],
      {
        BAAS_AI_MODEL: mock.config.model,
        BAAS_AI_BASE_URL: mock.config.baseUrl,
      }
    );
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      text: string;
      model: string;
      tools: AgentEvent[];
    };
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(output.model, "test-model");
    assert.equal(output.text, "调度已提交，尚未完成。");
    const started = output.tools.find(
      (event) => event.type === "tool-result" && event.name === "scheduler_start"
    );
    assert.ok(started && started.type === "tool-result");
    const submission = started.result as {
      accepted: boolean;
      completed: boolean;
      result: { config_id: string; status: string };
    };
    assert.equal(submission.accepted, true);
    assert.equal(submission.completed, false);
    assert.equal(submission.result.config_id, "sensei-jp");
    assert.ok(["started", "accepted"].includes(submission.result.status));
    assert.ok(
      mock.requests[2].messages.some(
        (message) =>
          message.role === "tool" && message.content.includes('"sensei-jp":{"running":true')
      )
    );
    assert.ok(!result.stdout.includes("\x1b"));
  } finally {
    mock.close();
  }
});

test("CLI noninteractive agent cannot mutate without --yes", async () => {
  const mock = await provider([
    { calls: [{ name: "scheduler_start", args: {} }] },
    { calls: [{ name: "status", args: {} }] },
    { text: ["缺少批准，调度未启动。"] },
  ]);
  try {
    const result = await cli([
      "--demo",
      "--json",
      "--model",
      mock.config.model,
      "--ai-url",
      mock.config.baseUrl,
      "-p",
      "启动调度",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { tools: AgentEvent[] };
    assert.ok(
      output.tools.some(
        (event) =>
          event.type === "tool-error" &&
          event.name === "scheduler_start" &&
          event.error.includes("--yes")
      )
    );
    const status = output.tools.find(
      (event) => event.type === "tool-result" && event.name === "status"
    );
    assert.ok(status && status.type === "tool-result");
    assert.ok(
      Object.values(status.result as Record<string, { running: boolean }>).every(
        (item) => !item.running
      )
    );
  } finally {
    mock.close();
  }
});

test("CLI read-only mode hides mutations and rejects hallucinated mutation calls", async () => {
  const mock = await provider([
    { calls: [{ name: "scheduler_start", args: { profile: "sensei-cn" } }] },
    { calls: [{ name: "status", args: {} }] },
    { text: ["只读模式，未启动。"] },
  ]);
  try {
    const result = await cli([
      "--demo",
      "--json",
      "--read-only",
      "--model",
      mock.config.model,
      "--ai-url",
      mock.config.baseUrl,
      "-p",
      "启动调度",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { tools: AgentEvent[] };
    const definitions = mock.requests[0].tools as Array<{ function: { name: string } }>;
    assert.ok(
      !definitions.some((tool) =>
        ["scheduler_start", "scheduler_stop", "task_run", "config_set"].includes(tool.function.name)
      )
    );
    assert.ok(
      output.tools.some((event) => event.type === "tool-error" && event.name === "scheduler_start")
    );
    const status = output.tools.find(
      (event) => event.type === "tool-result" && event.name === "status"
    );
    assert.ok(status && status.type === "tool-result");
    assert.ok(
      Object.values(status.result as Record<string, { running: boolean }>).every(
        (item) => !item.running
      )
    );
  } finally {
    mock.close();
  }
});

test("CLI renders streaming text without color in noninteractive mode", async () => {
  const mock = await provider([{ text: ["阿罗娜", "已就绪。"] }]);
  try {
    const result = await cli([
      "--demo",
      "--no-color",
      "--model",
      mock.config.model,
      "--ai-url",
      mock.config.baseUrl,
      "-p",
      "你好",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "阿罗娜已就绪。");
    assert.ok(!result.stdout.includes("\x1b"));
  } finally {
    mock.close();
  }
});

test("CLI missing model configuration returns one JSON error document", async () => {
  const result = await cli(["--demo", "--json", "-p", "读取状态"]);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout) as { error: string };
  assert.ok(output.error.includes("BAAS_AI_MODEL"));
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("CLI provider errors return one JSON error without SDK diagnostic logging", async () => {
  const mock = await provider([{ status: 401, error: "Invalid provider credentials" }]);
  try {
    const result = await cli([
      "--demo",
      "--json",
      "--model",
      mock.config.model,
      "--ai-url",
      mock.config.baseUrl,
      "-p",
      "读取状态",
    ]);
    assert.equal(result.code, 1);
    assert.equal(typeof (JSON.parse(result.stdout) as { error: string }).error, "string");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(result.stderr, "");
  } finally {
    mock.close();
  }
});

test("CLI persisted conversations and resumed provider context never contain credential writes", async () => {
  const privateValue = "persisted-conversation-private-value";
  const directory = await mkdtemp(join(tmpdir(), "baas-agent-session-"));
  const mock = await provider([
    { calls: [{ name: "config_set", args: { path: "/name", value: { api_key: privateValue } } }] },
    { text: ["配置已更新。"] },
    { text: ["已恢复此前的对话。"] },
  ]);
  const base = ["--demo", "--json", "--model", mock.config.model, "--ai-url", mock.config.baseUrl];
  try {
    const first = await cli([...base, "--yes", "-p", "保存演示测试配置"], {}, undefined, directory);
    assert.equal(first.code, 0, first.stderr);
    const output = JSON.parse(first.stdout) as { session_id: string };
    assert.equal(typeof output.session_id, "string");
    const stored = await readFile(join(directory, "sessions", `${output.session_id}.json`), "utf8");
    assert.ok(!stored.includes(privateValue));
    assert.ok(stored.includes(REDACTED));
    assert.ok(!first.stdout.includes(privateValue));
    const second = await cli(
      [...base, "--resume", output.session_id, "-p", "回顾上次对话"],
      {},
      undefined,
      directory
    );
    assert.equal(second.code, 0, second.stderr);
    assert.equal(
      (JSON.parse(second.stdout) as { session_id: string }).session_id,
      output.session_id
    );
    assert.ok(mock.requests[2].messages.length > 2, "resumed model request contains prior turns");
    assert.ok(!JSON.stringify(mock.requests[2]).includes(privateValue));
    assert.ok(!second.stdout.includes(privateValue));
    const listed = await cli([...base, "sessions"], {}, undefined, directory);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal((JSON.parse(listed.stdout) as Array<{ id: string }>)[0].id, output.session_id);
    const metadata = await cli([...base, "resume", "latest"], {}, undefined, directory);
    assert.equal(metadata.code, 0, metadata.stderr);
    assert.equal(
      (JSON.parse(metadata.stdout) as { session_id: string }).session_id,
      output.session_id
    );
    const fresh = await cli(
      [...base, "--resume", output.session_id, "new"],
      {},
      undefined,
      directory
    );
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.notEqual(
      (JSON.parse(fresh.stdout) as { session_id: string }).session_id,
      output.session_id
    );
    const profileMismatch = await cli(
      [...base, "--profile", "sensei-jp", "--resume", output.session_id, "-p", "继续"],
      {},
      undefined,
      directory
    );
    assert.equal(profileMismatch.code, 1);
    assert.ok((JSON.parse(profileMismatch.stdout) as { error: string }).error.includes("配置档"));
    const endpointMismatch = await cli(
      ["--json", "--server", "ws://127.0.0.1:9999", "--resume", output.session_id, "-p", "继续"],
      {},
      undefined,
      directory
    );
    assert.equal(endpointMismatch.code, 1);
    assert.ok(
      (JSON.parse(endpointMismatch.stdout) as { error: string }).error.includes("另一后端")
    );
    assert.equal(
      mock.requests.length,
      3,
      "session management and binding failures never call the model"
    );
  } finally {
    mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI --no-session keeps the conversation out of persistent session storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baas-agent-no-session-"));
  const mock = await provider([{ text: ["临时对话"] }]);
  try {
    const result = await cli(
      [
        "--demo",
        "--json",
        "--no-session",
        "--model",
        mock.config.model,
        "--ai-url",
        mock.config.baseUrl,
        "-p",
        "你好",
      ],
      {},
      undefined,
      directory
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { session_id?: string }).session_id, undefined);
    await assert.rejects(readdir(join(directory, "sessions")), { code: "ENOENT" });
  } finally {
    mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI loads global BAAS.md and explicit instructions as redacted model context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baas-agent-instructions-"));
  const extra = join(directory, "workflow.md");
  await writeFile(
    join(directory, "BAAS.md"),
    "测试约定：先查看状态。password=instruction-private-value\n"
  );
  await writeFile(extra, "补充流程：再读取日志。\n");
  const mock = await provider([{ text: ["已理解流程。"] }]);
  try {
    const result = await cli(
      [
        "--demo",
        "--json",
        "--no-session",
        "--instructions",
        extra,
        "--model",
        mock.config.model,
        "--ai-url",
        mock.config.baseUrl,
        "-p",
        "开始",
      ],
      {},
      undefined,
      directory
    );
    assert.equal(result.code, 0, result.stderr);
    const system = mock.requests[0].messages.find((message) => message.role === "system");
    assert.ok(system?.content.includes("先查看状态"));
    assert.ok(system?.content.includes("再读取日志"));
    assert.ok(!system?.content.includes("instruction-private-value"));
  } finally {
    mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI models works without selecting a model and returns one clean JSON document", async () => {
  const mock = await modelServer({ data: [{ id: "local/current-model", owned_by: "local" }] });
  try {
    const result = await cli(["--json", "--ai-url", mock.config.baseUrl, "models"], {
      BAAS_AI_API_KEY: "provider-listing-private-key",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{ id: "local/current-model", ownedBy: "local" }]);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.ok(!result.stdout.includes("provider-listing-private-key"));
    assert.equal(mock.requests[0].authorization, "Bearer provider-listing-private-key");
  } finally {
    mock.close();
  }
});

test(
  "CLI SIGINT cancels a stalled model with exit code 130 and clean JSON",
  { skip: process.platform === "win32" },
  async () => {
    const mock = await provider([{ text: ["正在读取"], hold: true }]);
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const result = await cli(
        [
          "--demo",
          "--json",
          "--model",
          mock.config.model,
          "--ai-url",
          mock.config.baseUrl,
          "-p",
          "读取状态",
        ],
        {},
        (child) => {
          timer = setInterval(() => {
            if (mock.requests.length) {
              clearInterval(timer);
              child.kill("SIGINT");
            }
          }, 5);
        }
      );
      assert.equal(result.code, 130, result.stderr);
      assert.equal(typeof (JSON.parse(result.stdout) as { error: string }).error, "string");
      assert.equal(result.stdout.trim().split("\n").length, 1);
    } finally {
      if (timer) clearInterval(timer);
      mock.close();
    }
  }
);
