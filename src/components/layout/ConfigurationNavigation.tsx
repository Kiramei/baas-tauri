import { i18nKey } from "@/shared/I18nKeys";
import { useId } from "react";
import {
  Amphora,
  ArrowUpFromLine,
  BrushCleaning,
  Coffee,
  Database,
  Dices,
  FileCode2,
  Map,
  ScrollText,
  Server,
  Settings2,
  Shield,
  ShoppingCart,
  Sword,
  Swords,
  Trophy,
  Users2Icon,
} from "lucide-react";
import { FormSelect } from "@/components/ui/FormSelect";
import { SearchInput } from "@/components/ui/SearchInput";
import {
  filterConfigurationSections,
  type ConfigurationPlatform,
  type ConfigurationSection,
} from "@/shared/ConfigurationSections";
import { useAppTranslation } from "@/shared/useAppTranslation";

const sectionIcons = {
  cafe: Coffee,
  schedule: Dices,
  shop: ShoppingCart,
  artifact: Amphora,
  arena: Swords,
  dailySweep: BrushCleaning,
  tactical: Shield,
  finalRestrictionRls: Trophy,
  drill: Sword,
  whitelist: ScrollText,
  server: Server,
  script: FileCode2,
  emulator: Database,
  stage: Map,
  team: Users2Icon,
  push: ArrowUpFromLine,
  other: Settings2,
};

export interface ConfigurationNavigationProps {
  selected: ConfigurationSection;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (section: ConfigurationSection) => void;
  compact?: boolean;
  disabled?: boolean;
  platform?: ConfigurationPlatform;
}

/** Profile configuration navigation shares its selection and search between layouts. */
export default function ConfigurationNavigation({
  selected,
  query,
  onQueryChange,
  onSelect,
  compact = false,
  disabled = false,
  platform = __WITH_ANDROID__ ? "android" : __WITH_WEBUI__ ? "webui" : "desktop",
}: ConfigurationNavigationProps) {
  const { t } = useAppTranslation();
  const navigationId = useId();
  const sections = filterConfigurationSections(query, t, platform);
  const selectedIsVisible = sections.some(({ id }) => id === selected);

  return (
    <div
      className={
        compact
          ? "configuration-navigation min-w-0 space-y-3"
          : "configuration-navigation flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3 px-1 pb-3 pt-1"
      }
    >
      <SearchInput
        data-configuration-search=""
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && sections[0]) {
            event.preventDefault();
            onSelect(sections[0].id);
          }
        }}
        placeholder={t("configuration.search")}
        aria-controls={compact ? undefined : navigationId}
        autoComplete="off"
        disabled={disabled}
        containerClassName="shrink-0 [&>svg]:size-4"
        className="pl-9"
      />

      {compact ? (
        sections.length > 0 ? (
          <FormSelect
            value={selectedIsVisible ? selected : ""}
            onChange={(value) => {
              const section = sections.find(({ id }) => id === value);
              if (section) onSelect(section.id);
            }}
            options={sections.map(({ id, title }) => ({ value: id, label: t(i18nKey(title)) }))}
            placeholder={t("configuration.categories")}
            ariaLabel={t("configuration.categories")}
            disabled={disabled}
          />
        ) : (
          <p role="status" className="px-1 py-2 text-sm text-muted-foreground">
            {t("configuration.noResults")}
          </p>
        )
      ) : (
        <nav
          id={navigationId}
          aria-label={t("configuration.categories")}
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto overscroll-contain"
        >
          {(["feature", "general"] as const).map((group) => {
            const groupSections = sections.filter((section) => section.group === group);
            if (groupSections.length === 0) return null;
            return (
              <section key={group} aria-labelledby={`${navigationId}-${group}`}>
                <h3
                  id={`${navigationId}-${group}`}
                  className="mb-1.5 px-2.5 text-xs font-medium text-muted-foreground"
                >
                  {group === "feature" ? t("settings.feature") : t("settings.general")}
                </h3>
                <div className="space-y-1">
                  {groupSections.map(({ id, title }) => {
                    const Icon = sectionIcons[id];
                    const active = selected === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-current={active ? "page" : undefined}
                        disabled={disabled}
                        onClick={() => onSelect(id)}
                        className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-medium text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:opacity-40 ${active ? "bg-sidebar-accent" : "enabled:hover:bg-sidebar-accent/70"}`}
                      >
                        <Icon size={16} strokeWidth={1.5} className="shrink-0" aria-hidden="true" />
                        <span className="min-w-0 truncate" title={t(i18nKey(title))}>
                          {t(i18nKey(title))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {sections.length === 0 && (
            <p role="status" className="px-3 py-3 text-sm text-muted-foreground">
              {t("configuration.noResults")}
            </p>
          )}
        </nav>
      )}
    </div>
  );
}
