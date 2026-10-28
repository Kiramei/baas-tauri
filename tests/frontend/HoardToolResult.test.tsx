import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import HoardToolResult from "../../src/components/plugins/HoardToolResult";
import type { JsonValue } from "../../src/shared/Plugins";
import en from "../../public/locales/en.json";
import zh from "../../public/locales/zh.json";
import ja from "../../public/locales/ja.json";
import ko from "../../public/locales/ko.json";
import fr from "../../public/locales/fr.json";
import de from "../../public/locales/de.json";
import ru from "../../public/locales/ru.json";

const languages = { en, zh, ja, ko, fr, de, ru };
const warningKeys = {
  PREMIUM_PURCHASES_ARE_MANUAL: "premium",
  OVERFLOW_REQUIRES_MAIL_VERIFICATION: "overflow",
  MAIL_REQUIRES_SELECTIVE_COLLECTION: "selective",
  CAFE_CAPACITY_LOSS: "cafeCapacity",
  MAIL_IS_COLLECTED_AS_A_WHOLE: "wholeMailbox",
};
const target = "2026-10-29T00:00:00+08:00";
const plan = (overrides: Record<string, JsonValue> = {}): JsonValue => ({
  target_at: target,
  executable: true,
  available_at_target: { character_ap: 123, cafe_ap: 456, mail_ap: 789, total_ap: 1368 },
  // Execution-end balances must never replace the target-window forecast.
  summary: { character_ap: 99991, cafe_ap: 99992, mail_ap: 99993, total_ap: 299976 },
  steps: [
    { at: target, action: "ready", amount: 0, ap_after: 123, mail_ap: 789 },
    { at: target, action: "spend", amount: 120, ap_after: 3, mail_ap: 789 },
  ],
  warnings: [],
  ...overrides,
});

async function render(value: JsonValue, language: keyof typeof languages = "en") {
  const translator = createInstance();
  await translator.init({
    lng: language,
    resources: Object.fromEntries(
      Object.entries(languages).map(([key, messages]) => [key, { translation: messages }])
    ),
  });
  const markup = renderToStaticMarkup(
    <I18nextProvider i18n={translator}>
      <HoardToolResult value={value} />
    </I18nextProvider>
  );
  return { markup, primary: markup.split("<details")[0], translator };
}

describe("hoarding plan results", () => {
  test("a successful plan displays estimates rather than claiming game execution", async () => {
    const { markup, primary } = await render(plan());
    expect(primary).toContain("Plan can run automatically");
    expect(primary).toContain("has not performed any game actions");
    expect(primary).toContain("123");
    expect(primary).toContain("456");
    expect(primary).toContain("789");
    expect(primary).toContain("1,368");
    expect(primary).not.toContain("99991");
    expect(primary).not.toContain("299976");
    expect(markup).toContain("99991");
    expect(markup).toContain("Full plan data");
    expect(primary).toContain('role="region"');
    expect(primary).toContain('scope="col"');
    expect(primary).toContain("−120");
  });

  test("manual plans keep every supported warning in all seven languages", async () => {
    for (const language of Object.keys(languages) as (keyof typeof languages)[]) {
      const { primary, markup, translator } = await render(
        plan({ executable: false, warnings: Object.keys(warningKeys) }),
        language
      );
      expect(primary).toContain(translator.t("plugins.hoardPlan.manual"));
      for (const [code, key] of Object.entries(warningKeys)) {
        const message = translator.t(`plugins.hoardPlan.warnings.${key}`);
        expect(message).not.toStartWith("plugins.");
        expect(primary).toContain(message);
        expect(primary).not.toContain(code);
        expect(markup).toContain(code); // Full data preserves the source.
      }
    }
  });

  test("an interrupted plan never substitutes its partial summary for target assets", async () => {
    const { primary } = await render(
      plan({ executable: false, available_at_target: null, steps: [] })
    );
    expect(primary).toContain("not yet determined");
    expect(primary).toContain("No timeline steps");
    expect(primary).not.toContain("99991");
    expect(primary).not.toContain("1,368");
  });

  test("timestamps use the device locale and equal instants have equal displayed time", async () => {
    const { primary } = await render(plan());
    const local = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(target)
    );
    expect(primary).toContain(local);
    const { primary: utc } = await render(
      plan({
        target_at: "2026-10-28T16:00:00Z",
        steps: [{ at: "2026-10-28T16:00:00Z", action: "ready", amount: 0 }],
      })
    );
    expect(utc).toContain(local);
    expect(utc).toContain("local time zone");
  });

  test("unknown notices and steps remain visible without raw codes in the primary view", async () => {
    const { markup, primary } = await render(
      plan({
        warnings: ["A_FUTURE_WARNING", "constructor"],
        steps: [
          { action: "future_action", at: "bad-date", amount: 10 },
          { action: "toString", at: "bad-date", amount: 1 },
        ],
      })
    );
    expect(primary).toContain("cannot explain one of the plan notices");
    expect(primary).toContain("Other planned step");
    expect(primary).not.toContain("A_FUTURE_WARNING");
    expect(primary).not.toContain("future_action");
    expect(markup).toContain("A_FUTURE_WARNING");
    expect(markup).toContain("future_action");
  });

  test("start outputs and malformed plans retain the generic safe renderer", async () => {
    const { markup } = await render({ completed: true, message: "<script>bad()</script>" });
    expect(markup).not.toContain("data-hoard-plan");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("Raw JSON");
  });
});
