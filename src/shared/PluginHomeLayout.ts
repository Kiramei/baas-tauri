import { collectPluginHomeCards, type PluginHomeCard } from "./PluginHome";
import { DEFAULT_HOME_LAYOUT, homeLayout, type HomeLayout, type HomeSection } from "./PluginTools";
import type { PluginCatalog, PluginSettings } from "./Plugins";

export interface PluginHomeData {
  layout: HomeLayout | null;
  cards: PluginHomeCard[];
}

export type HomePluginRequest = <T>(
  command: string,
  configId?: string,
  payload?: Record<string, unknown>
) => Promise<T>;

export const DEFAULT_PLUGIN_HOME_DATA: PluginHomeData = { layout: null, cards: [] };

/** Catalog and settings must belong to the same active profile/session generation. */
export async function loadPluginHomeData(
  request: HomePluginRequest,
  configId: string,
  isCurrent: () => boolean
): Promise<PluginHomeData | null> {
  const catalog = await request<PluginCatalog>("get_plugin_catalog", configId);
  if (!isCurrent()) return null;
  if (catalog.api_version !== 1) return DEFAULT_PLUGIN_HOME_DATA;
  const cards = collectPluginHomeCards(catalog);
  const editor = catalog.plugins.find(
    (plugin) =>
      plugin.id === "baas.home-editor" &&
      plugin.source === "builtin" &&
      plugin.enabled &&
      plugin.trusted &&
      plugin.state === "available"
  );
  if (!editor) return { cards, layout: null };
  try {
    const settings = await request<PluginSettings>("get_plugin_settings", configId, {
      plugin_id: editor.id,
    });
    if (!isCurrent()) return null;
    if (settings.config_id !== configId || settings.plugin_id !== editor.id)
      return { cards, layout: null };
    return { cards, layout: homeLayout(settings.values) };
  } catch {
    return isCurrent() ? { cards, layout: null } : null;
  }
}

/** An enabled editor overrides the legacy assets preference only for its own profile. */
export function homeSectionPresentation(
  layout: HomeLayout | null,
  assetsDisplay: boolean,
  android: boolean
): { order: readonly HomeSection[]; visible: Record<HomeSection, boolean>; edit: boolean } {
  return {
    order:
      layout?.section_order ??
      (android ? ["shortcuts", "tasks", "assets", "logs"] : DEFAULT_HOME_LAYOUT.section_order),
    visible: {
      shortcuts: layout?.shortcuts_visible ?? true,
      assets: layout?.assets_visible ?? assetsDisplay,
      tasks: layout?.tasks_visible ?? true,
      logs: true,
    },
    edit: layout?.show_edit_entry ?? false,
  };
}
