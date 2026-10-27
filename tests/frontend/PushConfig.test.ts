import { describe, expect, test } from "bun:test";
import {
  hasIncompleteTelegramCredentials,
  normalizePushConfig,
  serializePushConfig,
  supportsPushField,
  type PushConfigValues,
} from "../../src/features/pushConfiguration";
import {
  ConfigurationHistory,
  type ConfigurationValues,
} from "../../src/shared/ConfigurationHistory";

function fixture() {
  const writes: { profileId: string; patch: ConfigurationValues }[] = [];
  const history = new ConfigurationHistory({
    persist: (profileId, patch) => writes.push({ profileId, patch }),
    schedule: () => null,
    cancel: () => {},
  });
  return { history, writes };
}

describe("notification channel configuration", () => {
  test("older scripts retain legacy controls without receiving unsupported channel keys", () => {
    const source = {
      push_after_error: true,
      push_after_completion: false,
      push_json: "https://notify.invalid/hook",
      push_serverchan: "existing-key-fixture",
    };
    const initial = normalizePushConfig(source);
    expect(supportsPushField(source, "push_json")).toBe(true);
    expect(supportsPushField(source, "push_serverchan")).toBe(true);
    for (const key of [
      "push_feishu",
      "push_wecom",
      "push_telegram_bot_token",
      "push_telegram_chat_id",
      "push_telegram_proxy",
      "push_telegram_api",
    ] as const)
      expect(supportsPushField(source, key)).toBe(false);
    const { history, writes } = fixture();
    history.ensure("legacy", "push", initial, (value) => serializePushConfig(value, source));
    history.update("legacy", "push", {
      ...initial,
      push_after_error: false,
      push_telegram_bot_token: "unsupported-token-fixture",
      push_feishu: "https://feishu.invalid/unsupported",
    });
    history.flush("legacy");
    expect(writes).toEqual([{ profileId: "legacy", patch: { push_after_error: false } }]);
    history.undo("legacy");
    expect(writes.at(-1)).toEqual({ profileId: "legacy", patch: { push_after_error: true } });
  });

  test("mixed support follows own snapshot fields, including empty saved values", () => {
    const source = {
      push_feishu: "",
      push_telegram_bot_token: "123456:test-only-token",
      push_telegram_chat_id: "-1000000000001",
    };
    expect(supportsPushField(source, "push_feishu")).toBe(true);
    expect(supportsPushField(source, "push_telegram_bot_token")).toBe(true);
    expect(supportsPushField(source, "push_telegram_chat_id")).toBe(true);
    expect(supportsPushField(source, "push_wecom")).toBe(false);
    expect(supportsPushField(source, "push_telegram_proxy")).toBe(false);
    expect(supportsPushField(source, "push_telegram_api")).toBe(false);
    expect(
      supportsPushField(
        Object.create({ push_telegram_api: "https://inherited.invalid" }),
        "push_telegram_api"
      )
    ).toBe(false);
    const values = serializePushConfig(
      {
        ...normalizePushConfig(source),
        push_feishu: "https://feishu.invalid/new",
        push_telegram_bot_token: "",
        push_telegram_proxy: "http://unsupported.invalid:7890",
      },
      source
    );
    expect(values.push_feishu).toBe("https://feishu.invalid/new");
    expect(values.push_telegram_bot_token).toBe("");
    expect(values.push_telegram_chat_id).toBe("-1000000000001");
    expect(values).not.toHaveProperty("push_wecom");
    expect(values).not.toHaveProperty("push_telegram_proxy");
    expect(values).not.toHaveProperty("push_telegram_api");
  });

  test("current script snapshots allow every channel and explicit clearing", () => {
    const source = normalizePushConfig();
    const values = {
      ...source,
      push_feishu: "https://feishu.invalid/new",
      push_wecom: "https://wecom.invalid/new",
      push_telegram_bot_token: "123456:test-only-token",
      push_telegram_chat_id: "-1000000000001",
      push_telegram_proxy: "",
      push_telegram_api: "https://telegram.invalid",
    };
    expect(serializePushConfig(values, source)).toEqual(values);
    expect(serializePushConfig(source, values)).toEqual(source);
  });

  test("opening an older profile never writes missing channel defaults", () => {
    const legacy = { push_after_error: true, push_json: "https://notify.invalid/hook" };
    const values = normalizePushConfig(legacy);
    expect(values.push_feishu).toBe("");
    expect(values.push_wecom).toBe("");
    expect(values.push_telegram_bot_token).toBe("");
    expect(values.push_telegram_chat_id).toBe("");
    expect(values.push_telegram_proxy).toBe("");
    expect(values.push_telegram_api).toBe("");
    expect(values.push_after_completion).toBe(false);
    const { history, writes } = fixture();
    history.ensure("legacy", "push", values);
    history.flush("legacy", "push");
    expect(writes).toEqual([]);
    expect(legacy).toEqual({
      push_after_error: true,
      push_json: "https://notify.invalid/hook",
    });
  });

  test("editing one new channel preserves all other channels and profile history", () => {
    const initial = normalizePushConfig({
      push_json: "https://notify.invalid/existing",
      push_serverchan: "existing-key-fixture",
      push_feishu: "https://feishu.invalid/existing",
      push_wecom: "https://wecom.invalid/existing",
      push_telegram_bot_token: "123456:test-only-token",
      push_telegram_chat_id: "-1001234567890",
      push_telegram_proxy: "http://proxy.invalid:7890",
      push_telegram_api: "https://telegram.invalid",
    });
    const { history, writes } = fixture();
    history.ensure("first", "push", initial);
    history.ensure("second", "push", normalizePushConfig());
    history.update<PushConfigValues>("first", "push", (previous) => ({
      ...previous,
      push_wecom: "https://wecom.invalid/updated",
    }));
    history.flush("first", "push");
    expect(writes).toEqual([
      { profileId: "first", patch: { push_wecom: "https://wecom.invalid/updated" } },
    ]);
    expect(history.getDraft("second", "push", null)).toEqual(normalizePushConfig());
    expect(history.undo("first")).toBe("push");
    expect(writes.at(-1)).toEqual({
      profileId: "first",
      patch: { push_wecom: "https://wecom.invalid/existing" },
    });
    history.redo("first");
    expect(history.getDraft("first", "push", null)).toEqual({
      ...initial,
      push_wecom: "https://wecom.invalid/updated",
    });
  });

  test("partial Telegram credentials can be saved and clearing a field disables the channel", () => {
    const { history, writes } = fixture();
    const initial = normalizePushConfig();
    history.ensure("profile", "push", initial);
    expect(hasIncompleteTelegramCredentials(initial)).toBe(false);
    history.update("profile", "push", {
      ...initial,
      push_telegram_bot_token: "123456:test-only-token",
    });
    history.flush("profile");
    const partial = history.getDraft("profile", "push", initial);
    expect(hasIncompleteTelegramCredentials(partial)).toBe(true);
    expect(writes.at(-1)?.patch).toEqual({
      push_telegram_bot_token: "123456:test-only-token",
    });
    history.update("profile", "push", { ...partial, push_telegram_chat_id: "-1000000000001" });
    history.flush("profile");
    const complete = history.getDraft("profile", "push", initial);
    expect(hasIncompleteTelegramCredentials(complete)).toBe(false);
    expect(writes.at(-1)?.patch).toEqual({ push_telegram_chat_id: "-1000000000001" });
    history.update("profile", "push", { ...complete, push_telegram_bot_token: "" });
    history.flush("profile");
    expect(writes.at(-1)?.patch).toEqual({ push_telegram_bot_token: "" });
    history.undo("profile");
    expect(history.getDraft("profile", "push", initial)).toEqual(complete);
  });

  test("chat IDs and secrets retain their exact string representation", () => {
    const input = {
      push_telegram_bot_token: " 123456:fixture-token ",
      push_telegram_chat_id: "-1001234567890123456",
      push_telegram_proxy: "http://user:p%40ss@proxy.invalid:7890",
      push_telegram_api: "https://telegram.invalid/custom/",
    };
    const values = normalizePushConfig(input);
    expect(values.push_telegram_bot_token).toBe(input.push_telegram_bot_token);
    expect(values.push_telegram_chat_id).toBe(input.push_telegram_chat_id);
    expect(values.push_telegram_proxy).toBe(input.push_telegram_proxy);
    expect(values.push_telegram_api).toBe(input.push_telegram_api);
  });
});
