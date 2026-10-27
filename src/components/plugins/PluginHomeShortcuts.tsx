import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Puzzle } from "lucide-react";
import { collectPluginHomeCards, type PluginHomeCard } from "@/shared/PluginHome";
import { pluginRequest, pluginText, requestPluginOpen, type PluginCatalog } from "@/shared/Plugins";
import { useWebSocketStore } from "@/store/WebsocketStore";

/** Disabled plugins and legacy backends contribute no home controls. */
export default function PluginHomeShortcuts({
  configId,
  active,
}: {
  configId: string;
  active: boolean;
}) {
  const { t, i18n } = useTranslation();
  const authenticated = useWebSocketStore((state) => state._auth_phase === "authenticated");
  const triggerReady = useWebSocketStore((state) => state.connections.trigger?.readyState === 1);
  const sessionId = useWebSocketStore((state) => state._session?.sessionId);
  const [cards, setCards] = useState<PluginHomeCard[]>([]);

  useEffect(() => {
    if (!active || !authenticated || !sessionId || !triggerReady) {
      setCards([]);
      return;
    }
    let disposed = false;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void pluginRequest<PluginCatalog>("get_plugin_catalog", configId)
        .then((catalog) => {
          if (!disposed && current === generation) setCards(collectPluginHomeCards(catalog));
        })
        .catch(() => {
          // Unsupported old services still provide the rest of the home page.
          if (!disposed && current === generation) setCards([]);
        });
    };
    const changed = (event: Event) => {
      const changedConfig = (event as CustomEvent<{ configId?: string }>).detail?.configId;
      if (!changedConfig || changedConfig === configId) refresh();
    };
    refresh();
    window.addEventListener("baas:plugins-changed", changed);
    return () => {
      disposed = true;
      window.removeEventListener("baas:plugins-changed", changed);
    };
  }, [configId, active, authenticated, sessionId, triggerReady]);

  if (!cards.length) return null;
  return (
    <section aria-label={t("nav.plugins")} className="min-w-0 shrink-0" data-plugin-home>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={() => requestPluginOpen(card.pluginId)}
            className="group flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
            title={
              pluginText(card.description, i18n.language) ||
              pluginText(card.pluginName, i18n.language)
            }
          >
            <Puzzle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{pluginText(card.title, i18n.language)}</span>
            <ArrowUpRight
              className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground"
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
    </section>
  );
}
