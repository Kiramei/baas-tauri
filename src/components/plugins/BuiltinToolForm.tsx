import { useTranslation } from "react-i18next";
import PluginSchemaForm from "./PluginSchemaForm";
import HomeLayoutEditor from "./HomeLayoutEditor";
import { InventoryToolForm } from "./InventoryTool";
import { isBuiltinTool } from "@/shared/PluginTools";
import type { JsonValue, PluginDescriptor, PluginSchema } from "@/shared/Plugins";

/** Built-ins may use host-owned controls; arbitrary plugins retain the portable schema form. */
export default function BuiltinToolForm({
  plugin,
  actionId,
  ...props
}: {
  plugin: PluginDescriptor;
  actionId?: string;
  schema: PluginSchema;
  value: JsonValue;
  onChange: (value: JsonValue) => void;
  onInvalid: (path: string, invalid: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (!actionId && isBuiltinTool(plugin, "baas.home-editor"))
    return (
      <HomeLayoutEditor value={props.value} onChange={props.onChange} disabled={props.disabled} />
    );
  if (actionId === "solve" && isBuiltinTool(plugin, "baas.inventory-calculator"))
    return <InventoryToolForm {...props} />;
  const labels: Record<string, string> = {
    high_random: t("pluginTools.options.highRandom"),
    low_fixed: t("pluginTools.options.lowFixed"),
    relaxed: t("pluginTools.options.relaxed"),
    regeneration: t("pluginTools.options.regeneration"),
    profile: t("pluginTools.options.profile"),
    side: t("pluginTools.options.side"),
    preset: t("pluginTools.options.preset"),
    burst: t("property.burst"),
    pierce: t("property.pierce"),
    mystic: t("property.mystic"),
    shock: t("property.shock"),
    unused: t("pluginTools.options.unused"),
    necklace: t("pluginTools.options.necklace"),
    watch: t("pluginTools.options.watch"),
    charm: t("pluginTools.options.charm"),
    hairpin: t("pluginTools.options.hairpin"),
    badge: t("pluginTools.options.badge"),
    bag: t("pluginTools.options.bag"),
    shoes: t("pluginTools.options.shoes"),
    gloves: t("pluginTools.options.gloves"),
    hat: t("pluginTools.options.hat"),
    none: t("pluginTools.options.none"),
    "30": t("pluginTools.options.jjc30"),
    "30_60": t("pluginTools.options.jjc3060"),
  };
  return (
    <PluginSchemaForm
      {...props}
      formatEnum={
        plugin.source === "builtin"
          ? (value) => (typeof value === "string" ? labels[value] : undefined)
          : undefined
      }
    />
  );
}
