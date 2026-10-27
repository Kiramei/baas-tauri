import type { PluginCatalog, PluginText } from "./Plugins";

export interface PluginHomeCard {
  key: string;
  pluginId: string;
  pluginName: PluginText;
  title: PluginText;
  description?: PluginText;
}

/** Home is a small launcher surface; opening a contribution never executes it. */
export function collectPluginHomeCards(catalog: PluginCatalog): PluginHomeCard[] {
  const cards: PluginHomeCard[] = [];
  for (const plugin of catalog.plugins) {
    if (!plugin.enabled || !plugin.trusted || plugin.state !== "available") continue;
    for (const contribution of plugin.contributions?.home ?? []) {
      if (!plugin.actions.some((action) => action.id === contribution.action_id)) continue;
      cards.push({
        key: `${plugin.id}:${contribution.id}`,
        pluginId: plugin.id,
        pluginName: plugin.name,
        title: contribution.title,
        description: contribution.description,
      });
      if (cards.length === 6) return cards;
    }
  }
  return cards;
}
