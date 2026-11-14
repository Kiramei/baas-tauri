import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import {
  auditUiText,
  interpolationNames,
  placeholderErrors,
} from "../../scripts/i18n-validation.mjs";
import { authPhaseText } from "../../src/shared/AuthPhaseText";
import {
  ColorPicker,
  ColorPickerInput,
  ColorPickerSwatch,
} from "../../src/components/ui/ColorPicker";

function flatten(value: Record<string, unknown>, prefix = "", result: Record<string, string> = {}) {
  for (const [name, child] of Object.entries(value)) {
    const key = name === "$self" ? prefix : prefix ? `${prefix}.${name}` : name;
    if (child && typeof child === "object") flatten(child as Record<string, unknown>, key, result);
    else result[key] = String(child);
  }
  return result;
}

describe("translation validation", () => {
  test("interpolation names may move and repeat, but cannot disappear or be renamed", () => {
    expect(interpolationNames("{{ version }} / {{- user.name}} / {{count, number}}")).toEqual([
      "count",
      "user.name",
      "version",
    ]);
    expect(
      placeholderErrors({
        en: { progress: "{{done}} of {{total}}" },
        zh: { progress: "{{total}} 中的 {{done}}，共 {{total}}" },
      })
    ).toEqual([]);
    expect(
      placeholderErrors({
        en: { progress: "{{done}} of {{total}}" },
        ja: { progress: "{{count}}" },
      })
    ).toHaveLength(1);
  });

  test("authored JSX, accessible names, notifications, aliases, and conditional text are audited", () => {
    const rows = auditUiText(
      `
      const fallback = "Waiting for the backend";
      const phases = { idle: "Idle", running: "Running" };
      const metadata = { title: "Settings title" };
      const component = <div aria-label={ready ? "Ready label" : fallback}>
        Welcome <span>{busy ? "Busy" : fallback}</span><small>{phases[phase]}</small>
      </div>;
      notice.error("Could not launch", { description: "Try again later" });
    `,
      "fixture.tsx"
    );
    expect(new Set(rows.map((row: { text: string }) => row.text))).toEqual(
      new Set([
        "Waiting for the backend",
        "Idle",
        "Running",
        "Settings title",
        "Ready label",
        "Welcome",
        "Busy",
        "Could not launch",
        "Try again later",
      ])
    );
  });

  test("protocol data, CSS, translated text, comments, and documented literal exemptions stay intact", () => {
    expect(
      auditUiText(
        `
      const unusedMetadata = { title: "settings.title" };
      // This English comment contains no UI.
      const payload = { command: "start_scheduler", status: "running" };
      const metadata = { title: t("settings.title") };
      const element = <main className="some-css-class" data-channel="stable">
        <style>{\`.example { color: red; }\`}</style>
        <span>{t("common.save")}</span><span>BAAS</span>
        {metadata.title}
      </main>;
      console.error("A developer diagnostic");
    `,
        "fixture.tsx",
        { translationKeys: new Set(["settings.title"]), allowedLiterals: { BAAS: "Product name." } }
      )
    ).toEqual([]);
    expect(
      auditUiText('<span title="settings.title">common.save</span>', "fixture.tsx", {
        translationKeys: new Set(["settings.title", "common.save"]),
      }).map((issue: { text: string }) => issue.text)
    ).toEqual(["settings.title", "common.save"]);
  });

  test("translations and color input accessible names render in every supported language", async () => {
    const catalogs: Record<string, Record<string, string>> = {};
    for (const language of ["de", "en", "fr", "ja", "ko", "ru", "zh"]) {
      const catalog = flatten(
        JSON.parse(
          readFileSync(new URL(`../../public/locales/${language}.json`, import.meta.url), "utf8")
        )
      );
      catalogs[language] = catalog;
      const translator = createInstance();
      await translator.init({
        lng: language,
        keySeparator: false,
        resources: { [language]: { translation: catalog } },
        interpolation: { escapeValue: false },
      });
      for (const phase of [
        "idle",
        "control_connecting",
        "server_verified",
        "waiting_password",
        "resuming",
        "initializing",
        "authenticating",
        "authenticated",
        "revoked",
        "future_phase",
      ]) {
        const text = authPhaseText(phase, (key) => translator.t(key));
        expect(text).not.toStartWith("connection.");
        expect(text.length).toBeGreaterThan(2);
      }
      for (const [format, keys] of [
        ["hex", ["hex", "alpha"]],
        ["rgb", ["red", "green", "blue", "alpha"]],
        ["hsl", ["hue", "saturation", "lightness", "alpha"]],
        ["hsb", ["hue", "saturation", "brightness", "alpha"]],
      ] as const) {
        const html = renderToStaticMarkup(
          <I18nextProvider i18n={translator}>
            <ColorPicker defaultValue="#123456" format={format} inline>
              <ColorPickerInput />
              <ColorPickerSwatch />
            </ColorPicker>
          </I18nextProvider>
        );
        for (const key of keys)
          expect(html).toContain(`aria-label="${catalog[`colorPicker.${key}`]}"`);
        expect(html).not.toContain("colorPicker.");
        if (language === "en") expect(html).toContain("Current color:");
        else expect(html).not.toContain("Current color:");
      }
    }
    expect(placeholderErrors(catalogs)).toEqual([]);
  });
});
