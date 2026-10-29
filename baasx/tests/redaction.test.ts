import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor, isSensitiveField, REDACTED } from "../src/redaction";

test("structured credential fields and their duplicate values are scrubbed without mutation", () => {
  const redactor = createRedactor();
  const source = {
    message: "failed using credential-value",
    api_key: "credential-value",
    nested: {
      push_telegram_bot_token: "123456789:bot-token",
      password: "private-password",
      enabled: true,
    },
    serverSignPublicKey: "public-pin",
    hotkey_run: "Ctrl+Shift+R",
    access_token: "",
  };
  const result = redactor.value(source) as typeof source;
  assert.equal(result.api_key, REDACTED);
  assert.equal(result.message, `failed using ${REDACTED}`);
  assert.equal(result.nested.push_telegram_bot_token, REDACTED);
  assert.equal(result.nested.password, REDACTED);
  assert.equal(result.nested.enabled, true);
  assert.equal(result.serverSignPublicKey, "public-pin");
  assert.equal(result.hotkey_run, "Ctrl+Shift+R");
  assert.equal(result.access_token, "");
  assert.equal(source.api_key, "credential-value");
});

test("config pointer credential reads and writes are scrubbed contextually", () => {
  const redactor = createRedactor();
  const args = {
    profile: "sensei",
    path: "/notifications/push_wecom",
    value: "https://example.test/hook/my-secret",
  };
  assert.deepEqual(redactor.arguments("config_set", args), { ...args, value: REDACTED });
  assert.equal(args.value, "https://example.test/hook/my-secret");
  assert.equal(
    redactor.result("config_get", { path: "/push_telegram_bot_token" }, "a-secret-token"),
    REDACTED
  );
  assert.equal(redactor.result("config_get", { path: "/name" }, "夏莱"), "夏莱");
  assert.deepEqual(redactor.result("config_set", args, { saved: true, value: args.value }), {
    saved: true,
    value: REDACTED,
  });
  const diff = { ...args, before: "old-private-value", after: "next-private-value" };
  assert.deepEqual(redactor.arguments("config_set", diff), {
    ...diff,
    value: REDACTED,
    before: REDACTED,
    after: REDACTED,
  });
  assert.deepEqual(redactor.value({ path: "/password", value: 123456, before: 987654 }), {
    path: "/password",
    value: REDACTED,
    before: REDACTED,
  });
  assert.ok(
    !JSON.stringify(
      redactor.value({ type: "tool-call", toolName: "config_set", input: diff })
    ).includes("old-private-value")
  );
});

test("error text scrubs explicit keys, auth, URLs, assignments, private keys and webhooks", () => {
  const redactor = createRedactor(["environment-service-key", "environment-model-key"]);
  const input = [
    "environment-service-key environment-model-key",
    "Authorization: Bearer bearer-secret",
    "Bearer standalone-secret",
    "Cookie: session=secret-session; csrf=private-csrf",
    "https://username:private-password@example.test/route?token=query-secret&safe=true",
    'api_key="quoted-secret" password=unquoted-secret',
    "https://api.telegram.org/bot123456789:telegram-secret/sendMessage",
    "https://open.feishu.cn/open-apis/bot/v2/hook/feishu-secret",
    "-----BEGIN RSA PRIVATE KEY-----\nprivate-content\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const output = redactor.text(input);
  for (const secret of [
    "environment-service-key",
    "environment-model-key",
    "bearer-secret",
    "standalone-secret",
    "secret-session",
    "private-csrf",
    "private-password",
    "query-secret",
    "quoted-secret",
    "unquoted-secret",
    "telegram-secret",
    "feishu-secret",
    "private-content",
  ])
    assert.ok(!output.includes(secret), secret);
  assert.ok(output.includes("safe=true"));
  assert.ok(output.includes("example.test/route"));
});

test("split provider chunks cannot expose known secrets or credential assignments", () => {
  const redactor = createRedactor(["service-key-split-between-chunks"]);
  const source = `开始 ${"正常文本".repeat(40)} service-key-split-between-chunks\npassword=${"private".repeat(30)}\n${"尾部".repeat(60)}`;
  const stream = redactor.stream();
  let output = "";
  for (let index = 0; index < source.length; index += 3)
    output += stream.push(source.slice(index, index + 3));
  output += stream.flush();
  assert.ok(!output.includes("service-key-split-between-chunks"));
  assert.ok(!output.includes("private"));
  assert.ok(output.includes(REDACTED));
  assert.ok(output.includes("正常文本"));
  assert.ok(output.endsWith("尾部"));
});

test("redaction tolerates cyclic and deeply nested backend data", () => {
  const source: Record<string, unknown> = { token: "cycle-secret", safe: true };
  source.self = source;
  const redactor = createRedactor();
  assert.doesNotThrow(() => JSON.stringify(redactor.value(source)));
  assert.ok(!JSON.stringify(redactor.value(source)).includes("cycle-secret"));
  assert.equal(isSensitiveField("push_telegram_bot_token"), true);
  assert.equal(isSensitiveField("SecretMidnightParty"), false);
  assert.equal(isSensitiveField("max_tokens"), false);
});

test("BAAS CDK and login key variants are hidden while monthly pass settings remain usable", () => {
  const fields = [
    "CDK",
    "mirrorcCdk",
    "mirrorc_cdk",
    "mirror_cdk",
    "baas_key",
    "BAAS_KEY",
    "login_key",
    "loginKey",
    "provider_key",
    "providerKey",
  ];
  const source = Object.fromEntries(
    fields.map((field, index) => [field, `private-baas-credential-${index}`])
  );
  const redactor = createRedactor();
  const output = redactor.value({ ...source, _pass: true, monthly_pass: false });
  for (const field of fields) {
    assert.equal(isSensitiveField(field), true, field);
    assert.equal((output as Record<string, unknown>)[field], REDACTED);
    assert.equal(
      redactor.result("config_get", { path: `/${field}` }, "private-single-read"),
      REDACTED
    );
  }
  assert.equal(isSensitiveField("_pass"), false);
  assert.equal(isSensitiveField("monthly_pass"), false);
  assert.equal((output as Record<string, unknown>)._pass, true);
  assert.equal((output as Record<string, unknown>).monthly_pass, false);
});
