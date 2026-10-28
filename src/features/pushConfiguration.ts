export interface PushConfigValues {
  push_after_error: boolean;
  push_after_completion: boolean;
  push_json: string;
  push_serverchan: string;
  push_feishu: string;
  push_wecom: string;
  push_telegram_bot_token: string;
  push_telegram_chat_id: string;
  push_telegram_proxy: string;
  push_telegram_api: string;
}

const EXTENDED_PUSH_FIELDS = [
  "push_feishu",
  "push_wecom",
  "push_telegram_bot_token",
  "push_telegram_chat_id",
  "push_telegram_proxy",
  "push_telegram_api",
] as const;

/** A snapshot's own fields define which newer settings this script can understand. */
export function supportsPushField(
  settings: Partial<PushConfigValues> | undefined,
  field: keyof PushConfigValues
): boolean {
  return (
    !EXTENDED_PUSH_FIELDS.some((extended) => extended === field) ||
    Object.hasOwn(settings ?? {}, field)
  );
}

/** Never inject newer keys into an older script's strict Config dataclass. */
export function serializePushConfig(
  draft: PushConfigValues,
  settings: Partial<PushConfigValues> | undefined
): Partial<PushConfigValues> {
  const values: Partial<PushConfigValues> = { ...draft };
  for (const field of EXTENDED_PUSH_FIELDS) {
    if (!supportsPushField(settings, field)) delete values[field];
  }
  return values;
}

/** Older script versions can omit channels; opening the editor must not write defaults. */
export function normalizePushConfig(settings?: Partial<PushConfigValues>): PushConfigValues {
  return {
    push_after_error: settings?.push_after_error ?? false,
    push_after_completion: settings?.push_after_completion ?? false,
    push_json: settings?.push_json ?? "",
    push_serverchan: settings?.push_serverchan ?? "",
    push_feishu: settings?.push_feishu ?? "",
    push_wecom: settings?.push_wecom ?? "",
    push_telegram_bot_token: settings?.push_telegram_bot_token ?? "",
    push_telegram_chat_id: settings?.push_telegram_chat_id ?? "",
    push_telegram_proxy: settings?.push_telegram_proxy ?? "",
    push_telegram_api: settings?.push_telegram_api ?? "",
  };
}

/** This describes saved credentials only; it makes no claim about network connectivity. */
export function hasIncompleteTelegramCredentials(
  settings: Pick<PushConfigValues, "push_telegram_bot_token" | "push_telegram_chat_id">
): boolean {
  return Boolean(settings.push_telegram_bot_token) !== Boolean(settings.push_telegram_chat_id);
}
