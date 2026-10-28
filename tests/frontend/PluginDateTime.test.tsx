import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tools = fileURLToPath(new URL("../../src/shared/PluginTools.ts", import.meta.url));
const form = fileURLToPath(
  new URL("../../src/components/plugins/PluginSchemaForm.tsx", import.meta.url)
);

/** A child process gives each case its own timezone without racing other tests. */
async function inZone<T>(zone: string, body: string): Promise<T> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { dateTimeInput, dateTimeIso } from ${JSON.stringify(tools)};
     const result = await (async () => { ${body} })();
     process.stdout.write(JSON.stringify(result));`,
    ],
    {
      cwd: root,
      env: { ...process.env, TZ: zone },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status, stderr).toBe(0);
  return JSON.parse(stdout) as T;
}

describe("portable plugin date-time input", () => {
  test.each([
    ["UTC", "2026-10-28T03:04"],
    ["Asia/Shanghai", "2026-10-28T11:04"],
    ["Asia/Tokyo", "2026-10-28T12:04"],
    ["America/New_York", "2026-10-27T23:04"],
  ])(
    "%s renders equivalent UTC/+8/+9 instants as the same browser-local minute",
    async (zone, local) => {
      const result = await inZone<{ local: string[]; iso: string }>(
        zone,
        `
      return {
        local: ["2026-10-28T03:04:00.000Z", "2026-10-28T11:04:00+08:00", "2026-10-28T12:04:00+09:00"].map(dateTimeInput),
        iso: dateTimeIso(${JSON.stringify(local)})
      };`
      );
      expect(result.local).toEqual([local, local, local]);
      expect(result.iso).toBe("2026-10-28T03:04:00.000Z");
    }
  );

  test("invalid calendar dates, time ranges and malformed local values are rejected", async () => {
    const result = await inZone<{ invalid: unknown[]; leap: string; empty: string[] }>(
      "UTC",
      `
      return {
        invalid: ["", "not-a-date", "2026-02-29T11:04", "2026-02-30T11:04", "2026-04-31T11:04",
          "2026-00-28T11:04", "2026-13-28T11:04", "2026-10-00T11:04", "2026-10-28T24:00",
          "2026-10-28T11:60", "2026-10-28 11:04", "2026-10-28", "2026-10-28T11:04Z",
          "2026-10-28T11:04+08:00", "2026-10-28T11:04 trailing", " 2026-10-28T11:04"]
          .map(value => dateTimeIso(value) ?? null),
        leap: dateTimeIso("2024-02-29T11:04"),
        empty: [undefined, null, 0, false, {}, "", "not-a-date"].map(dateTimeInput)
      };`
    );
    expect(result.invalid).toEqual(Array(16).fill(null));
    expect(result.leap).toBe("2024-02-29T11:04:00.000Z");
    expect(result.empty).toEqual(Array(7).fill(""));
  });

  test("a daylight-saving skipped hour is rejected instead of silently moving the schedule", async () => {
    const result = await inZone<{ before: string; skipped: unknown; after: string; input: string }>(
      "America/New_York",
      `
      return {
        before: dateTimeIso("2024-03-10T01:30"),
        skipped: dateTimeIso("2024-03-10T02:30") ?? null,
        after: dateTimeIso("2024-03-10T03:30"),
        input: dateTimeInput("2024-03-10T07:30:00.000Z")
      };`
    );
    expect(result.before).toBe("2024-03-10T06:30:00.000Z");
    expect(result.skipped).toBeNull();
    expect(result.after).toBe("2024-03-10T07:30:00.000Z");
    expect(result.input).toBe("2024-03-10T03:30");
  });

  test("the minute-only control never accepts seconds, fractions, or timezone suffixes as local input", async () => {
    const result = await inZone<unknown[]>(
      "Asia/Shanghai",
      `
      return ["2026-10-28T11:04:00", "2026-10-28T11:04:01", "2026-10-28T11:04:59",
        "2026-10-28T11:04:00.000", "2026-10-28T11:04:00Z", "2026-10-28T11:04:00+08:00"]
        .map(value => dateTimeIso(value) ?? null);`
    );
    expect(result).toEqual(Array(6).fill(null));
  });

  test.each([
    ["Asia/Shanghai", "2026-10-28T11:04"],
    ["Asia/Tokyo", "2026-10-28T12:04"],
  ])("schema date-time fields render minute-step local controls in %s", async (zone, local) => {
    const markup = await inZone<string>(
      zone,
      `
      const { default: React } = await import("react");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { createInstance } = await import("i18next");
      const { I18nextProvider } = await import("react-i18next");
      const { default: PluginSchemaForm } = await import(${JSON.stringify(form)});
      const translator = createInstance();
      await translator.init({ lng: "en", showSupportNotice: false, resources: { en: { translation: {} } } });
      const schema = { type: "object", properties: {
        target: { type: "string", format: "date-time", title: "Spend at", description: "Browser local time" },
        note: { type: "string", title: "Note" },
        count: { type: "integer", title: "Count", minimum: 1 }
      } };
      return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: translator },
        React.createElement(PluginSchemaForm, { schema, value: { target: "2026-10-28T03:04:00.000Z", note: "Keep this text", count: 2 }, onChange() {}, onInvalid() {} })));`
    );
    expect(markup).toContain('type="datetime-local"');
    expect(markup).toContain('step="60"');
    expect(markup).toContain(`value="${local}"`);
    expect(markup).toContain("Spend at");
    expect(markup).toContain("Browser local time");
    expect(markup).toContain('type="text"');
    expect(markup).toContain('value="Keep this text"');
    expect(markup).toContain('type="number"');
    expect(markup).not.toContain('value="2026-10-28T03:04:00.000Z"');
  });
});
