import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import PluginSchemaForm from "../../src/components/plugins/PluginSchemaForm";
import PluginResultView from "../../src/components/plugins/PluginResultView";
import en from "../../public/locales/en.json";
import zh from "../../public/locales/zh.json";

describe("host-owned plugin rendering", () => {
  test("localized schema titles and descriptions render as text with associated controls", async () => {
    const translator = createInstance();
    await translator.init({
      lng: "zh",
      fallbackLng: "en",
      resources: { en: { translation: en }, zh: { translation: zh } },
    });
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={translator}>
        <PluginSchemaForm
          schema={{
            type: "object",
            title: { zh: "设置", en: "Settings" },
            properties: {
              count: {
                type: "integer",
                title: { zh: "数量", en: "Count" },
                description: { zh: "计算数量", en: "Item count" },
              },
              note: { type: "string", title: { zh: "<script>bad()</script>", en: "Note" } },
            },
          }}
          value={{ count: 3 }}
          onChange={() => {}}
          onInvalid={() => {}}
        />
      </I18nextProvider>
    );
    expect(markup).toContain("数量");
    expect(markup).toContain("计算数量");
    expect(markup).toContain("for=");
    expect(markup).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
  });
  test("record arrays become accessible host tables and raw HTML remains escaped", async () => {
    const translator = createInstance();
    await translator.init({ lng: "en", resources: { en: { translation: en } } });
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={translator}>
        <PluginResultView
          value={{
            totals: { energy: 120 },
            schedule: [
              { day: 1, note: '<img src=x onerror="bad()">' },
              { day: 2, note: "ready" },
            ],
          }}
        />
      </I18nextProvider>
    );
    expect(markup).toContain("<table");
    expect(markup).toContain('scope="col"');
    expect(markup).toContain("day");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("Raw JSON");
  });
  test("result object labels and table columns use localized output schema titles", async () => {
    const translator = createInstance();
    await translator.init({ lng: "zh", resources: { zh: { translation: zh } } });
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={translator}>
        <PluginResultView
          value={{ budget_total: 200, daily_rows: [{ energy: 120 }] }}
          schema={{
            type: "object",
            properties: {
              budget_total: { type: "number", title: { en: "Budget total", zh: "预算总额" } },
              daily_rows: {
                type: "array",
                title: { zh: "每日计划" },
                items: {
                  type: "object",
                  properties: { energy: { type: "integer", title: { zh: "体力" } } },
                },
              },
            },
          }}
        />
      </I18nextProvider>
    );
    expect(markup).toContain("预算总额");
    expect(markup).toContain("每日计划");
    expect(markup).toContain("体力");
    expect(markup).toContain('aria-label="每日计划"');
  });
});
