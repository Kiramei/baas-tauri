import { i18nKey } from "@/shared/I18nKeys";
import React, {
  Dispatch,
  SetStateAction,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import CafeConfig from "@/features/CafeConfig";
import ServerConfig from "@/features/ServerConfig";
import ScheduleConfig from "@/features/ScheduleConfig";
import ShopConfig from "@/features/ShopConfig";
import ArenaConfig from "@/features/ArenaConfig";
import DailySweep from "@/features/DailySweep";
import TacticalConfig from "@/features/TacticalConfig";
import FinalRestrictionRlsConfig from "@/features/FinalRestrictionRlsConfig";
import DrillConfig from "@/features/DrillConfig";
import EmulatorConfig from "@/features/EmulatorConfig";
import PushConfig from "@/features/PushConfig";
import OtherConfig from "@/features/OtherConfig";
import WhiteListConfig from "@/features/WhiteListConfig";
import ArtifactConfig from "@/features/ArtifactConfig";
import ScriptConfig from "@/features/ScriptConfig";
import StageConfig from "@/features/StageConfig";
import TeamConfig from "@/features/TeamConfig";
import { useApp } from "@/context/AppContext";
import { useWindowLayout } from "@/context/WindowLayoutProvider";
import type { PageKey, ProfileProps } from "@/types/app";
import FeaturePanelErrorBoundary from "@/components/FeaturePanelErrorBoundary";
import ConfigurationNavigation from "@/components/layout/ConfigurationNavigation";
import PageActivity from "@/components/PageActivity";
import { useConfigurationWorkspace } from "@/shared/useConfigurationWorkspace";
import { useConfigurationSearchHighlight } from "@/shared/useConfigurationSearchHighlight";
import { useConfigurationHistoryActions } from "@/shared/useConfigurationHistoryActions";
import { IconTooltip } from "@/components/ui/Tooltip";
import { Undo2, Redo2 } from "lucide-react";
import { useApplicationShortcuts } from "@/shared/useApplicationShortcuts";
import {
  applicationShortcutMatches,
  normalizeApplicationShortcut,
} from "@/shared/ApplicationShortcuts";
import StorageUtil from "@/shared/StorageManager";
import type { HotkeyConfig } from "@/components/HotkeyConfig";
import {
  filterConfigurationSections,
  resolveConfigurationSection,
  type ConfigurationSection,
} from "@/shared/ConfigurationSections";
import "./configuration-page.css";

/** Shared by the original feature editors and their inline configuration surface. */
export interface FeatureComponentProps {
  onClose: () => void;
  profileId: string;
  setActivePage?: Dispatch<SetStateAction<PageKey>>;
}

const featureComponents: Record<ConfigurationSection, React.FC<FeatureComponentProps>> = {
  cafe: CafeConfig,
  schedule: ScheduleConfig,
  shop: ShopConfig,
  artifact: ArtifactConfig,
  arena: ArenaConfig,
  dailySweep: DailySweep,
  tactical: TacticalConfig,
  finalRestrictionRls: FinalRestrictionRlsConfig,
  drill: DrillConfig,
  whitelist: WhiteListConfig,
  server: ServerConfig,
  script: ScriptConfig,
  emulator: EmulatorConfig,
  stage: StageConfig,
  team: TeamConfig,
  push: PushConfig,
  other: OtherConfig,
};
const stayOnSection = () => {};

/** Existing feature drafts remain mounted while the shared navigation changes. */
const ConfigurationPage: React.FC<ProfileProps> = ({ profileId, setActivePage }) => {
  const { t, language } = useAppTranslation();
  const { profiles, activeProfile } = useApp();
  const { expanded } = useWindowLayout();
  const pid = profileId ?? activeProfile?.id;
  const profile = useMemo(
    () => profiles.find((item) => item.id === pid) ?? activeProfile,
    [profiles, pid, activeProfile]
  );
  const { selected, query, select, search } = useConfigurationWorkspace(pid);
  const history = useConfigurationHistoryActions(pid);
  const applicationShortcuts = useApplicationShortcuts();
  const [visited, setVisited] = useState<ConfigurationSection[]>([]);
  const [revisions, setRevisions] = useState<Partial<Record<ConfigurationSection, number>>>({});
  const detailRef = useRef<HTMLDivElement>(null);
  const hasResults = filterConfigurationSections(query, t).length > 0;
  const panels = visited.includes(selected.id) ? visited : [...visited, selected.id];
  useEffect(() => {
    setVisited((current) => (current.includes(selected.id) ? current : [...current, selected.id]));
  }, [selected.id]);
  useLayoutEffect(() => {
    const scroller = detailRef.current?.closest<HTMLElement>(
      ".app-page-scroll, .android-page-scroll"
    );
    if (scroller) scroller.scrollTop = 0;
  }, [selected.id]);
  useConfigurationSearchHighlight(detailRef, selected.id, query, language);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = detailRef.current;
      if (
        !root?.getClientRects().length ||
        root.closest("[aria-hidden='true']") ||
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector("[aria-modal='true'],[role='dialog'],[role='alertdialog']")
      )
        return;
      const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest("input,textarea,select,[contenteditable='true']") &&
        !target.closest(".configuration-editor")
      )
        return;
      const action = (["undo", "redo"] as const).find((id) =>
        applicationShortcutMatches(event, id, applicationShortcuts.bindings, mac)
      );
      if (!action) return;
      let profileBindings: HotkeyConfig[] = [];
      try {
        const saved = StorageUtil.get<HotkeyConfig[]>("hotkeys");
        profileBindings = Array.isArray(saved) ? saved : [];
      } catch {
        /* Defaults are available before storage initializes. */
      }
      if (
        profileBindings.some(
          (binding) =>
            binding.enabled !== false &&
            binding.value &&
            normalizeApplicationShortcut(binding.value, mac) ===
              normalizeApplicationShortcut(applicationShortcuts.bindings[action], mac)
        )
      )
        return;
      event.preventDefault();
      const section = history[action]();
      if (section) select(section);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applicationShortcuts.bindings, history.undo, history.redo, select]);
  if (!pid || !profile) return null;

  return (
    <div className="configuration-page text-foreground" data-profile-id={pid}>
      <div className={`configuration-compact-navigation ${expanded ? "lg:hidden" : ""}`}>
        <ConfigurationNavigation
          selected={selected.id}
          query={query}
          onQueryChange={search}
          onSelect={select}
          compact
        />
      </div>
      <div ref={detailRef} className="configuration-detail">
        <header className="configuration-detail-heading">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-2xl font-semibold tracking-tight">
                {t(i18nKey(selected.title))}
              </h2>
              <span className="min-w-0 truncate text-sm text-muted-foreground">{profile.name}</span>
            </div>
            <div
              className="configuration-history"
              role="group"
              aria-label={t("configuration.history")}
            >
              <IconTooltip
                content={`${t("edit.undo")}${applicationShortcuts.bindings.undo ? ` (${applicationShortcuts.shortcutLabel("undo")})` : ""}`}
              >
                <button
                  type="button"
                  aria-label={t("edit.undo")}
                  disabled={!history.canUndo}
                  onClick={() => {
                    const section = history.undo();
                    if (section) select(section);
                  }}
                >
                  <Undo2 size={16} />
                </button>
              </IconTooltip>
              <IconTooltip
                content={`${t("edit.redo")}${applicationShortcuts.bindings.redo ? ` (${applicationShortcuts.shortcutLabel("redo")})` : ""}`}
              >
                <button
                  type="button"
                  aria-label={t("edit.redo")}
                  disabled={!history.canRedo}
                  onClick={() => {
                    const section = history.redo();
                    if (section) select(section);
                  }}
                >
                  <Redo2 size={16} />
                </button>
              </IconTooltip>
            </div>
          </div>
        </header>
        {!hasResults && query.trim() && (
          <p role="status" className="mb-5 text-sm text-muted-foreground">
            {t("configuration.noResults")}
          </p>
        )}
        {panels.map((section) => {
          const Component = featureComponents[section];
          return (
            <PageActivity
              key={`${pid}:${section}`}
              active={selected.id === section}
              suspendDelayMs={0}
            >
              <section
                className="configuration-editor"
                data-configuration-section={section}
                aria-label={t(i18nKey(resolveConfigurationSection(section).title))}
              >
                <FeaturePanelErrorBoundary
                  key={`${pid}:${section}:${revisions[section] ?? 0}`}
                  closeLabel={t("contextMenu.reload")}
                  onClose={() =>
                    setRevisions((current) => ({
                      ...current,
                      [section]: (current[section] ?? 0) + 1,
                    }))
                  }
                >
                  <Component
                    profileId={pid}
                    onClose={stayOnSection}
                    setActivePage={setActivePage}
                  />
                </FeaturePanelErrorBoundary>
              </section>
            </PageActivity>
          );
        })}
      </div>
    </div>
  );
};
export default ConfigurationPage;
