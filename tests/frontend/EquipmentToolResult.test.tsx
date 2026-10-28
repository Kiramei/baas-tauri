import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import EquipmentToolResult from "../../src/components/plugins/EquipmentToolResult";
import type { JsonValue } from "../../src/shared/Plugins";
import en from "../../public/locales/en.json";
import zh from "../../public/locales/zh.json";

async function render(value: JsonValue, lng = "zh") {
  const translator = createInstance();
  await translator.init({ lng, resources: { en: { translation: en }, zh: { translation: zh } } });
  return renderToStaticMarkup(
    <I18nextProvider i18n={translator}>
      <EquipmentToolResult value={value} />
    </I18nextProvider>
  );
}

describe("equipment result labels", () => {
  test("localizes real CN drop rows and strategy while retaining exact raw data", async () => {
    const value = {
      status: "partial",
      strategy: "high_random",
      yields: [
        { equipment_id: "bag_bp_t6", slot: "bag", tier: 6, kind: "blueprint", expected: 1.032 },
        { equipment_id: "hat_t1", slot: "hat", tier: 1, kind: "gear", expected: 2 },
        {
          equipment_id: "necklace_univ",
          slot: "necklace",
          tier: 0,
          kind: "universal_blueprint",
          expected: 0.5,
        },
      ],
    };
    const markup = await render(value);
    const visible = markup.split("<details")[0];
    expect(visible).toContain("部分目标尚未满足");
    expect(visible).toContain("优先高阶随机掉落");
    expect(visible).toContain("T6 包包 设计图");
    expect(visible).toContain("T1 帽子 装备");
    expect(visible).toContain("项链 通用设计图");
    expect(visible).toContain("1.032");
    expect(visible).not.toContain("bag_bp_t6");
    expect(markup).toContain("bag_bp_t6");
    expect(value.yields[0].equipment_id).toBe("bag_bp_t6");
  });
  test("Eleph plans distinguish unavailable farming from completed targets", async () => {
    const markup = await render({
      students: [
        { name: "优香", status: "unavailable" },
        { name: "睦月", status: "covered" },
      ],
    });
    expect(markup).toContain("暂无已解锁的可刷关卡");
    expect(markup).toContain("目标已满足");
  });
  test("English labels and unknown future values remain readable and escaped", async () => {
    const markup = await render(
      {
        status: "planned",
        strategy: "low_fixed",
        yields: [{ slot: "future", equipment_id: "future_t1", kind: "<script>x</script>" }],
      },
      "en"
    );
    expect(markup).toContain("Plan ready");
    expect(markup).toContain("Prioritize low-tier fixed drops");
    expect(markup).toContain("future_t1");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
  });
});
