import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import HoardToolResult from "../../src/components/plugins/HoardToolResult";
import type { JsonValue } from "../../src/shared/Plugins";
import { hoardSnapshot } from "./fixtures/HoardMailboxData";
import en from "../../public/locales/en.json";
import zh from "../../public/locales/zh.json";
import ja from "../../public/locales/ja.json";
import ko from "../../public/locales/ko.json";
import fr from "../../public/locales/fr.json";
import de from "../../public/locales/de.json";
import ru from "../../public/locales/ru.json";

const languages = { en, zh, ja, ko, fr, de, ru };
async function render(value: JsonValue, language: keyof typeof languages = "en") {
  const translator = createInstance();
  await translator.init({
    lng: language,
    resources: Object.fromEntries(
      Object.entries(languages).map(([key, translation]) => [key, { translation }])
    ),
  });
  const markup = renderToStaticMarkup(
    <I18nextProvider i18n={translator}>
      <HoardToolResult value={value} />
    </I18nextProvider>
  );
  return { markup, primary: markup.split("<details")[0], t: translator.t };
}

describe("verified hoarding results", () => {
  test("complete scans show separate letter counts, AP totals and conservative expiry windows in seven languages", async () => {
    for (const language of Object.keys(languages) as (keyof typeof languages)[]) {
      const { primary, t } = await render(hoardSnapshot(), language);
      expect(primary).toContain("data-hoard-mail");
      expect(primary).toContain(t("plugins.hoardMail.title"));
      expect(primary).toContain(t("plugins.hoardMail.urgent"));
      expect(primary).toContain(t("plugins.hoardMail.complete"));
      expect(primary).toContain(t("plugins.hoardMail.expiryHint"));
      expect(primary).toContain('scope="col"');
      expect(primary).toContain('role="region"');
      expect(primary).toContain("789");
      expect(primary).toContain("200");
      expect(primary.match(/2026-10-28/g)).toHaveLength(2);
      expect(primary).not.toContain("mailbox-ocr");
      expect(primary).not.toContain("expires_at");
      expect(primary).not.toContain("1 hour remaining");
    }
  });

  test("execution displays actual balances and only verified actions, keeping initial predictions out of the primary view", async () => {
    const mailbox = hoardSnapshot();
    const value = {
      kind: "hoard_execution",
      inventory_kind: "verified",
      completed: true,
      actual_ap: 789,
      actual_mail_ap: 200,
      actual_total_ap: 989,
      mailbox,
      steps_total: 100,
      steps_offset: 99,
      history_truncated: true,
      plan: {
        steps_omitted: true,
        available_at_target: { total_ap: 77777 },
        steps: [{ action: "unexecuted_forecast", amount: 88888 }],
      },
      steps: [
        {
          action: "mail",
          at: mailbox.observed_at,
          verified: true,
          amount: 10,
          ap_before: 779,
          ap_after: 789,
          mail_ap: 200,
        },
        { action: "future_source", verified: false, amount: 66666 },
      ],
      completed_sources: [],
    };
    const { primary, markup } = await render(value);
    expect(primary).toContain("data-hoard-execution");
    expect(primary).toContain("Verified execution result");
    expect(primary).toContain("Executed action");
    expect(primary).not.toContain("Planned action");
    expect(primary).not.toContain("has not claimed any rewards");
    expect(primary).toContain("989");
    expect(primary).not.toContain("77777");
    expect(primary).not.toContain("88888");
    expect(primary).not.toContain("66666");
    expect(primary).not.toContain("future_source");
    expect(markup).toContain("Initial plan (forecast)");
    expect(primary).toContain("latest 1 of 100 verified actions");
    expect(markup).toContain("initial timeline is omitted");
    expect(markup).toContain("77777");
    expect(markup).toContain("66666");
    expect(markup).not.toContain("a".repeat(64));
    expect(markup).not.toContain("b".repeat(64));
    const inconsistent = await render({ ...value, actual_total_ap: 99999 });
    expect(inconsistent.markup).not.toContain("data-hoard-execution");
    expect(inconsistent.markup).not.toContain("a".repeat(64));
  });

  test("new plan warnings and inventory provenance stay localized without promoting forecasts to verified execution", async () => {
    const warnings = [
      "MAILBOX_SCAN_REQUIRED",
      "MAILBOX_SNAPSHOT_REVALIDATED_ON_START",
      "SOURCE_DELIVERY_WILL_BE_VERIFIED",
      "CLUB_MAIL_WILL_BE_VERIFIED",
      "MAIL_EXPIRY_ESTIMATED",
      "PREMIUM_PURCHASES_ARE_MANUAL",
    ];
    for (const language of Object.keys(languages) as (keyof typeof languages)[]) {
      const { primary, t } = await render(
        {
          executable: false,
          steps: [
            {
              action: "mail",
              at: hoardSnapshot().observed_at,
              verification: "scan_required",
              amount: 100,
            },
          ],
          warnings,
          inventory: {
            provenance: "provided_snapshot",
            verified_mail_ap: 200,
            estimated_mail_ap: 0,
            estimated_overflow_ap: 123,
            pending_source_mail_ap: 10,
          },
        },
        language
      );
      expect(primary).toContain(t("plugins.hoardPlan.inventory.provided"));
      expect(primary).toContain(t("plugins.hoardPlan.inventory.overflow"));
      expect(primary).toContain(t("plugins.hoardPlan.inventory.scanStep"));
      expect(primary).not.toContain("data-hoard-execution");
      for (const code of warnings) expect(primary).not.toContain(code);
      expect(primary).not.toContain("plugins.hoard");
    }
  });
});
