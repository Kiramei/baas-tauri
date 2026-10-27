import { useEffect, useId, useRef } from "react";
import { Cable, Keyboard, Palette, RefreshCw, ScrollText, Settings } from "lucide-react";
import { SearchInput } from "@/components/ui/SearchInput";
import { useUISetting, useSetUISettings } from "@/context/UISettingsProvider";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { i18nKey } from "@/shared/I18nKeys";
import {
  ANDROID_SETTINGS_SECTIONS,
  SETTINGS_SECTIONS,
  filterSettingsSections,
  resolveSettingsSection,
} from "@/shared/SettingsSections";
import { settingsSearchStore } from "@/shared/SettingsSearch";
import { useSettingsSearch } from "@/shared/useSettingsSearch";

const sectionIcons = {
  general: Settings,
  appearance: Palette,
  shortcuts: Keyboard,
  runtime: Cable,
  updates: RefreshCw,
  logs: ScrollText,
};

const availableSections = __WITH_ANDROID__ ? ANDROID_SETTINGS_SECTIONS : SETTINGS_SECTIONS;

/** Global settings navigation, independent of the active game profile. */
export default function SettingsNavigation({ compact = false }: { compact?: boolean }) {
  const { t } = useAppTranslation();
  const section = useUISetting(
    (settings) => resolveSettingsSection(settings.settingsSection, availableSections).id
  );
  const setUiSettings = useSetUISettings();
  const { query, activeIndex, matchCount, matchedSections, resultsQuery } = useSettingsSearch();
  const searchSource = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const hasResults = query.trim().length > 0 && resultsQuery === query;
  const sections = hasResults
    ? availableSections.filter(({ id }) => matchedSections.includes(id))
    : filterSettingsSections(query, t, availableSections);

  useEffect(() => {
    const blur = () => settingsSearchStore.blur(searchSource);
    const focus = () => {
      if (
        document.activeElement === searchRef.current &&
        searchRef.current?.getClientRects().length
      ) {
        settingsSearchStore.focus(searchSource);
      }
    };
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    focus();
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      blur();
    };
  }, [searchSource]);

  return (
    <div
      className={
        compact
          ? "min-w-0 space-y-3"
          : "flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3 px-1 pb-3 pt-1"
      }
    >
      <div className="relative">
        <SearchInput
          ref={searchRef}
          data-settings-search-source={searchSource}
          value={query}
          onChange={(event) => settingsSearchStore.setQuery(event.target.value)}
          onFocus={() => settingsSearchStore.focus(searchSource)}
          onBlur={() => settingsSearchStore.blur(searchSource)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              settingsSearchStore.moveSelection(event.shiftKey ? -1 : 1);
            }
          }}
          placeholder={t("settings.search")}
          autoComplete="off"
          containerClassName="[&>svg]:size-4"
          className={hasResults ? "pl-9 pr-16" : "pl-9"}
        />
        {hasResults && (
          <span
            role="status"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums text-muted-foreground"
          >
            {matchCount ? activeIndex + 1 : 0}/{matchCount}
          </span>
        )}
      </div>
      {!compact && (
        <nav
          aria-label={t("settings.categories")}
          className="min-h-0 min-w-0 space-y-1 overflow-x-hidden overflow-y-auto"
        >
          {sections.map(({ id, label }) => {
            const Icon = sectionIcons[id];
            const selected = section === id;
            return (
              <button
                key={id}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => setUiSettings((settings) => ({ ...settings, settingsSection: id }))}
                className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-medium text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 ${selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"}`}
              >
                <Icon size={16} strokeWidth={1.5} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{t(i18nKey(label))}</span>
              </button>
            );
          })}
          {sections.length === 0 && (
            <p role="status" className="px-3 py-3 text-sm text-muted-foreground">
              {t("settings.noResults")}
            </p>
          )}
        </nav>
      )}
    </div>
  );
}
