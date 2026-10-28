import type { HoardMailSnapshot } from "../../../src/shared/HoardMailbox";

/** Synthetic inventory; no account identifiers, screenshots or real mailbox contents. */
export function hoardSnapshot(): HoardMailSnapshot {
  return {
    kind: "hoard_mail_scan",
    inventory_kind: "verified",
    character_ap: 789,
    complete: true,
    observed_at: "2026-10-28T04:00:00Z",
    mailbox_count: 4,
    total_ap: 200,
    fingerprint: "a".repeat(64),
    parcels: [
      {
        id: "1".repeat(32),
        identity: "b".repeat(64),
        amount: 100,
        expires_at: "2026-10-28T04:00:00Z",
        expires_before: "2026-10-28T05:00:00Z",
        expiry_precision: "under-hour",
        received_at: "2026-10-28",
        source: "mailbox-ocr",
        occurrence: 0,
      },
      {
        id: "2".repeat(64),
        identity: "b".repeat(64),
        amount: 100,
        expires_at: "2099-10-29T04:00:00Z",
        expires_before: "2099-10-30T04:00:00Z",
        expiry_precision: "day",
        received_at: "2026-10-28",
        source: "mailbox-ocr",
        occurrence: 1,
      },
    ],
  };
}
