import { useTranslation } from "react-i18next";
import PluginResultView from "./PluginResultView";
import type { JsonValue, PluginSchema } from "@/shared/Plugins";

/** Host-owned labels leave the original result intact for copying and diagnosis. */
export default function EquipmentToolResult({
  value,
  schema,
}: {
  value: JsonValue;
  schema?: PluginSchema;
}) {
  const { t } = useTranslation();
  const slots: Record<string, string> = {
    necklace: t("pluginTools.options.necklace"),
    watch: t("pluginTools.options.watch"),
    charm: t("pluginTools.options.charm"),
    hairpin: t("pluginTools.options.hairpin"),
    badge: t("pluginTools.options.badge"),
    bag: t("pluginTools.options.bag"),
    shoes: t("pluginTools.options.shoes"),
    gloves: t("pluginTools.options.gloves"),
    hat: t("pluginTools.options.hat"),
  };
  const labels: Record<string, string> = {
    planned: t("pluginTools.equipment.planned"),
    partial: t("pluginTools.equipment.partial"),
    covered: t("pluginTools.equipment.covered"),
    unavailable: t("pluginTools.equipment.unavailable"),
    high_random: t("pluginTools.options.highRandom"),
    low_fixed: t("pluginTools.options.lowFixed"),
    blueprint: t("pluginTools.equipment.blueprint"),
    gear: t("pluginTools.equipment.gear"),
    universal_blueprint: t("pluginTools.equipment.universal"),
  };
  return (
    <PluginResultView
      value={value}
      schema={schema}
      formatValue={(item, key) => {
        if (typeof item !== "string") return undefined;
        if (key === "slot") return Object.hasOwn(slots, item) ? slots[item] : undefined;
        if (key === "status" || key === "strategy" || key === "kind")
          return Object.hasOwn(labels, item) ? labels[item] : undefined;
        if (key === "equipment_id") {
          const match =
            /^(necklace|watch|charm|hairpin|badge|bag|shoes|gloves|hat)_(bp_t([1-9]\d*)|univ|[t]([1-9]\d*))$/.exec(
              item
            );
          if (match)
            return [
              match[3] || match[4] ? `T${match[3] || match[4]}` : "",
              slots[match[1]],
              match[2] === "univ"
                ? labels.universal_blueprint
                : match[3]
                  ? labels.blueprint
                  : labels.gear,
            ]
              .filter(Boolean)
              .join(" ");
        }
        return undefined;
      }}
    />
  );
}
