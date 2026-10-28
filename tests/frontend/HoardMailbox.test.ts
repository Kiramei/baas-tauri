import { describe, expect, test } from "bun:test";
import {
  hoardActionInput,
  hoardPlanInputSchema,
  hoardHistory,
  hoardResultDetails,
  nextHoardMailSnapshot,
  readHoardMailSnapshot,
} from "../../src/shared/HoardMailbox";
import type { JsonValue, PluginJob, PluginSchema } from "../../src/shared/Plugins";
import { hoardSnapshot } from "./fixtures/HoardMailboxData";

describe("hoarding mailbox contracts", () => {
  test("complete inventories preserve identical letters and mailbox totals above the character cap", () => {
    const snapshot = hoardSnapshot();
    snapshot.parcels = Array.from({ length: 12 }, (_, occurrence) => ({
      ...snapshot.parcels[0],
      id: occurrence.toString(16).padStart(32, "0"),
      occurrence,
    }));
    snapshot.mailbox_count = 15;
    snapshot.total_ap = 1200;
    expect(readHoardMailSnapshot(snapshot)?.parcels).toHaveLength(12);
    expect(readHoardMailSnapshot(snapshot)?.total_ap).toBe(1200);
    expect(snapshot.parcels[0].identity).toBe(snapshot.parcels[1].identity);
  });

  test.each([
    { complete: false },
    { inventory_kind: "estimate" },
    { total_ap: 201 },
    { character_ap: 1000 },
    { character_ap: 1.5 },
    { observed_at: "2026-10-28T04:00:00" },
    { observed_at: "2026-02-30T04:00:00Z" },
    { mailbox_count: 1 },
    { mailbox_count: 201 },
    { fingerprint: "account-id" },
    { parcels: null },
  ])("incomplete or inconsistent results cannot become reusable scans: %j", (overrides) => {
    expect(readHoardMailSnapshot({ ...hoardSnapshot(), ...overrides })).toBeNull();
  });

  test.each([
    { expires_at: "bad-date" },
    { expires_before: "2026-10-28T03:00:00Z" },
    { expires_before: "2026-10-28T04:00:00Z" },
    { expires_at: "2026-10-28T03:00:00Z", expires_before: "2026-10-28T04:00:00Z" },
    { received_at: "2026-02-30" },
    { received_at: "2026-10-28T00:00:00Z" },
    { expiry_precision: "forever" },
    { amount: 0 },
    { amount: 1.5 },
    { occurrence: -1 },
    { source: "user-entered" },
    { identity: "not-an-anonymous-sha" },
    { id: "letter-1" },
    { id: "a".repeat(33) },
  ])("invalid parcel metadata cannot masquerade as verified mail: %j", (overrides) => {
    const snapshot = hoardSnapshot();
    snapshot.parcels[0] = { ...snapshot.parcels[0], ...overrides } as (typeof snapshot.parcels)[0];
    expect(readHoardMailSnapshot(snapshot)).toBeNull();
  });

  test("all host timer precisions are accepted without inventing a new expiry", () => {
    for (const precision of ["day", "hour", "minute", "second", "under-hour"] as const) {
      const snapshot = hoardSnapshot();
      snapshot.parcels[0].expiry_precision = precision;
      snapshot.parcels[0].expiry_uncertain = true;
      expect(readHoardMailSnapshot(snapshot)?.parcels[0].expires_at).toBe(snapshot.observed_at);
    }
    const snapshot = hoardSnapshot();
    snapshot.parcels[1].id = snapshot.parcels[0].id;
    expect(readHoardMailSnapshot(snapshot)).toBeNull();
    expect(
      readHoardMailSnapshot({ ...hoardSnapshot(), mailbox_count: 0, total_ap: 0, parcels: [] })
    ).not.toBeNull();
  });

  test("compact public scans keep all 200 letters and hide opaque tokens in readable details", () => {
    const snapshot = hoardSnapshot();
    snapshot.parcels = Array.from({ length: 200 }, (_, occurrence) => {
      const { identity: _identity, source: _source, ...parcel } = snapshot.parcels[0];
      void _identity;
      void _source;
      return { ...parcel, id: occurrence.toString(16).padStart(32, "0"), occurrence };
    });
    snapshot.mailbox_count = 200;
    snapshot.total_ap = 20000;
    expect(readHoardMailSnapshot(snapshot)?.parcels).toHaveLength(200);
    snapshot.parcels.push({ ...snapshot.parcels[0], id: "f".repeat(32), occurrence: 200 });
    snapshot.mailbox_count = 201;
    snapshot.total_ap += 100;
    expect(readHoardMailSnapshot(snapshot)).toBeNull();
    snapshot.parcels.pop();
    snapshot.mailbox_count = 200;
    snapshot.total_ap -= 100;
    const details = hoardResultDetails({
      mailbox: snapshot,
      steps: [{ mail_id: "opaque-token", amount: 100 }],
    });
    const serialized = JSON.stringify(details);
    for (const key of ['"id"', '"identity"', '"fingerprint"', '"mail_id"', "opaque-token"])
      expect(serialized).not.toContain(key);
    expect(serialized).toContain('"amount":100');
    expect(
      hoardHistory({ steps_total: 100, steps_offset: 36, history_truncated: true }, 64)
    ).toEqual({ shown: 64, total: 100, start: 37, truncated: true });
  });

  test("snapshot input is explicit, plan-only and never a large editable schema", () => {
    const schema: PluginSchema = {
      type: "object",
      properties: {
        mailbox_snapshot: { type: "object", properties: { fingerprint: { type: "string" } } },
        note: { type: "string" },
      },
      required: ["mailbox_snapshot", "note"],
    };
    const visible = hoardPlanInputSchema(schema);
    expect(Object.keys(visible.properties ?? {})).toEqual(["note"]);
    expect(visible.required).toEqual(["note"]);
    expect(schema.required).toEqual(["mailbox_snapshot", "note"]);
    const snapshot = hoardSnapshot();
    expect(hoardActionInput("plan", {}, snapshot, false)).toEqual({});
    expect(hoardActionInput("plan", {}, snapshot, true)).toEqual({ mailbox_snapshot: snapshot });
    expect(hoardActionInput("plan", {}, null, true)).toEqual({});
    for (const action of ["start", "scan_mail"])
      expect(hoardActionInput(action, { mailbox_snapshot: snapshot }, snapshot, true)).toEqual({});
  });

  test("device operations invalidate cached scans; failed and malformed scans cannot revive one", () => {
    const snapshot = hoardSnapshot();
    const job = (action_id: string, state: PluginJob["state"], result?: JsonValue): PluginJob => ({
      id: "job",
      plugin_id: "baas.hoard-ap",
      action_id,
      config_id: "one",
      state,
      result,
      created_at: 0,
      updated_at: 0,
    });
    expect(nextHoardMailSnapshot(null, job("scan_mail", "succeeded", snapshot))).toEqual(snapshot);
    expect(nextHoardMailSnapshot(snapshot, job("plan", "succeeded", {}))).toBe(snapshot);
    for (const state of ["queued", "running", "failed", "cancelled"] as const) {
      expect(nextHoardMailSnapshot(snapshot, job("scan_mail", state))).toBeNull();
      expect(nextHoardMailSnapshot(snapshot, job("start", state))).toBeNull();
    }
    expect(nextHoardMailSnapshot(snapshot, job("start", "succeeded", {}))).toBeNull();
    expect(
      nextHoardMailSnapshot(
        snapshot,
        job("scan_mail", "succeeded", { ...snapshot, complete: false })
      )
    ).toBeNull();
  });
});
