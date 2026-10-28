import type { JsonValue, PluginJob, PluginSchema } from "./Plugins";

export interface HoardMailParcel extends Record<string, JsonValue> {
  id: string;
  amount: number;
  expires_at: string;
  expires_before: string;
  expiry_precision: "day" | "hour" | "minute" | "second" | "under-hour";
  received_at: string;
  occurrence: number;
}

export interface HoardMailSnapshot extends Record<string, JsonValue> {
  kind: "hoard_mail_scan";
  inventory_kind: "verified";
  character_ap: number;
  complete: true;
  observed_at: string;
  mailbox_count: number;
  total_ap: number;
  fingerprint: string;
  parcels: HoardMailParcel[];
}

export const hoardRecord = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (
  value: JsonValue | undefined,
  maximum = Number.MAX_SAFE_INTEGER
): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const sha = (value: JsonValue | undefined) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const mailDigest = (value: JsonValue | undefined): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(value);
const calendarDate = (value: JsonValue | undefined): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};
const instant = (value: JsonValue | undefined): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    value
  ) &&
  calendarDate(value.slice(0, 10)) &&
  Number.isFinite(Date.parse(value));

/** Only complete, internally consistent host scans may be offered for reuse. */
export function readHoardMailSnapshot(value: JsonValue | undefined): HoardMailSnapshot | null {
  if (
    !hoardRecord(value) ||
    value.kind !== "hoard_mail_scan" ||
    value.inventory_kind !== "verified" ||
    value.complete !== true ||
    !integer(value.character_ap, 999) ||
    !integer(value.mailbox_count, 200) ||
    !integer(value.total_ap) ||
    !instant(value.observed_at) ||
    !sha(value.fingerprint) ||
    !Array.isArray(value.parcels) ||
    value.parcels.length > 200 ||
    value.parcels.length > value.mailbox_count
  )
    return null;
  const ids = new Set<string>();
  let total = 0;
  for (const parcel of value.parcels) {
    if (
      !hoardRecord(parcel) ||
      !mailDigest(parcel.id) ||
      ids.has(parcel.id) ||
      (parcel.identity !== undefined && !mailDigest(parcel.identity)) ||
      !integer(parcel.amount, 999) ||
      parcel.amount === 0 ||
      !instant(parcel.expires_at) ||
      !instant(parcel.expires_before) ||
      Date.parse(parcel.expires_at) >= Date.parse(parcel.expires_before) ||
      Date.parse(parcel.expires_before) <= Date.parse(value.observed_at) ||
      !["day", "hour", "minute", "second", "under-hour"].includes(
        String(parcel.expiry_precision)
      ) ||
      !calendarDate(parcel.received_at) ||
      (parcel.source !== undefined && parcel.source !== "mailbox-ocr") ||
      !integer(parcel.occurrence)
    )
      return null;
    ids.add(parcel.id);
    total += Number(parcel.amount);
  }
  return total === value.total_ap ? (value as HoardMailSnapshot) : null;
}

/** Large host snapshots have a dedicated chooser, never a schema/JSON editor. */
export function hoardPlanInputSchema(schema: PluginSchema): PluginSchema {
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties ?? {}).filter(([key]) => key !== "mailbox_snapshot")
    ),
    required: schema.required?.filter((key) => key !== "mailbox_snapshot"),
  };
}

export function hoardActionInput(
  actionId: string,
  values: JsonValue,
  snapshot: HoardMailSnapshot | null,
  selected: boolean
): JsonValue {
  const input = hoardRecord(values) ? { ...values } : {};
  delete input.mailbox_snapshot;
  if (actionId === "plan" && selected && snapshot) input.mailbox_snapshot = snapshot;
  return input;
}

/** Device actions invalidate the previous inventory even when they later fail. */
export function nextHoardMailSnapshot(
  previous: HoardMailSnapshot | null,
  job: PluginJob
): HoardMailSnapshot | null {
  if (job.plugin_id !== "baas.hoard-ap" || !["scan_mail", "start"].includes(job.action_id))
    return previous;
  if (job.action_id === "scan_mail" && job.state === "succeeded")
    return readHoardMailSnapshot(job.result);
  return null;
}

export function hoardFormatters(locale: string) {
  const numbers = new Intl.NumberFormat(locale);
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
  return {
    number: (value: JsonValue | undefined) =>
      integer(value) ? numbers.format(Number(value)) : "—",
    time: (value: JsonValue | undefined) => (instant(value) ? dates.format(new Date(value)) : "—"),
  };
}

/** Opaque matching tokens belong to the host, not the readable result or its details. */
export function hoardResultDetails(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(hoardResultDetails);
  if (!hoardRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["id", "identity", "fingerprint", "mail_id"].includes(key))
      .map(([key, item]) => [key, hoardResultDetails(item)])
  );
}

export function hoardHistory(value: Record<string, JsonValue>, shown: number) {
  const total =
    integer(value.steps_total) && value.steps_total >= shown ? value.steps_total : shown;
  const offset =
    integer(value.steps_offset) && value.steps_offset + shown <= total ? value.steps_offset : 0;
  return {
    shown,
    total,
    start: offset + 1,
    truncated: value.history_truncated === true || total > shown || offset > 0,
  };
}
