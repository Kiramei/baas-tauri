import { IconTooltip } from "@/components/ui/Tooltip";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  Loader2,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Square,
} from "lucide-react";
import HeartbeatIndicator from "@/components/HeartbeatIndicator.tsx";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useWebSocketStore, waitForNormal } from "@/store/WebsocketStore";
import { PageKey } from "@/types/app";
import { getTimestampMs } from "@/shared/GlobalUtilities.ts";
import { reloadWithoutPrompt } from "@/shared/reload";
import { useTauriSelfUpdate } from "@/context/TauriSelfUpdateProvider";
import { TauriUpdateProgressModal } from "@/components/updater/TauriUpdateProgressModal";
import { useUISetting } from "@/context/UISettingsProvider.tsx";
import { invoke } from "@/shared/TauriInvoke";
import { listen } from "@tauri-apps/api/event";
import Header from "@/components/layout/Header";
import SettingsNavigation from "@/components/layout/SettingsNavigation";
import ConfigurationNavigation from "@/components/layout/ConfigurationNavigation";
import { useConfigurationWorkspace } from "@/shared/useConfigurationWorkspace";
import { useWindowLayout } from "@/context/WindowLayoutProvider";
import NavigationIcon from "@/components/layout/NavigationIcon";
import { useAboutBaas } from "@/context/AboutBaasProvider";
import { useApp } from "@/context/AppContext";
import WorkspaceSwitcher from "@/components/layout/WorkspaceSwitcher";
import { resolveSidebarPane, type SidebarPeekContext } from "@/shared/SidebarPane";

const InlineXTermLog = React.lazy(() => import("@/components/InlineXTermLog"));

interface SidebarProps {
  activePage: string;
  setActivePage: (page: PageKey) => void;
  desktopExpanded: boolean;
}

/** Renders the sidebar component. */
const Sidebar: React.FC<SidebarProps> = ({ activePage, setActivePage, desktopExpanded }) => {
  const { t } = useTranslation();
  const { activeProfile } = useApp();
  const configuration = useConfigurationWorkspace(activeProfile?.id);
  const primaryRunning = useWebSocketStore((state) =>
    activeProfile?.id ? Boolean(state.statusStore[activeProfile.id]?.running) : false
  );
  const { customFrame, sidebarLocked, setExpanded } = useWindowLayout();
  const [peekContext, setPeekContext] = useState<SidebarPeekContext | null>(null);
  const { page: panePage, peek } = resolveSidebarPane(
    activePage,
    desktopExpanded,
    sidebarLocked,
    peekContext
  );
  const openAbout = useAboutBaas();
  const navigationButtons = React.useRef<Partial<Record<PageKey, HTMLButtonElement | null>>>({});
  const profilePaneRef = React.useRef<HTMLElement>(null);
  const openTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionConfig = useWebSocketStore((state) => state.versionStore);
  const trigger = useWebSocketStore((state) => state.trigger);
  const triggerStream = useWebSocketStore((state) => state.triggerStream);
  const [backendUpdating, setBackendUpdating] = useState(false);
  const [backendUpdateLogs, setBackendUpdateLogs] = useState<string[]>([]);
  const [backendUpdateTerminalText, setBackendUpdateTerminalText] = useState("");
  const [backendUpdateLogOpen, setBackendUpdateLogOpen] = useState(false);
  const tauriUpdate = useTauriSelfUpdate();
  const tauriVersion = versionConfig["tauri"] ?? {};
  const hasBackendUpdate =
    __WITH_TAURI__ &&
    Boolean(versionConfig["remote"]) &&
    versionConfig["local"] !== versionConfig["remote"];
  const hasTauriUpdate = Boolean(__WITH_TAURI__ && tauriVersion.updateAvailable);
  const hasAnyUpdate = hasBackendUpdate || hasTauriUpdate;
  const sidebarToggleLabel = desktopExpanded ? t("app.collapseSidebar") : t("app.expandSidebar");
  const profilePaneVisible = desktopExpanded || peek;

  const cancelClose = React.useCallback(() => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const cancelOpen = React.useCallback(() => {
    if (openTimerRef.current !== null) clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);
  const closePeek = React.useCallback(() => {
    cancelOpen();
    cancelClose();
    setPeekContext(null);
  }, [cancelOpen, cancelClose]);
  const hasOpenOverlay = () =>
    Boolean(
      document.querySelector(
        "[role='menu'], [role='listbox'], [role='dialog'], [role='alertdialog']"
      )
    );
  const scheduleClose = () => {
    cancelOpen();
    if (desktopExpanded || closeTimerRef.current !== null) return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (!hasOpenOverlay() && !profilePaneRef.current?.contains(document.activeElement))
        setPeekContext(null);
    }, 180);
  };
  const scheduleOpen = (page: PageKey) => {
    cancelClose();
    if (
      page === "settings" ||
      desktopExpanded ||
      sidebarLocked ||
      !window.matchMedia("(min-width: 64rem)").matches
    )
      return;
    cancelOpen();
    if (peek) {
      if (panePage !== page) setPeekContext({ page, originPage: activePage });
      return;
    }
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setPeekContext({ page, originPage: activePage });
    }, 120);
  };

  React.useEffect(() => {
    closePeek();
  }, [activePage, desktopExpanded, sidebarLocked, closePeek]);

  React.useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
    },
    [cancelOpen, cancelClose]
  );

  React.useEffect(() => {
    if (!peek || desktopExpanded) return;
    const isInside = (target: EventTarget | null) =>
      target instanceof Node &&
      (profilePaneRef.current?.contains(target) ||
        Object.values(navigationButtons.current).some((button) => button?.contains(target)));
    const isOverlayTarget = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(
        target.closest("[role='menu'], [role='listbox'], [role='dialog'], [role='alertdialog']")
      );
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.target) && !isOverlayTarget(event.target)) closePeek();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (isInside(event.target) || isOverlayTarget(event.target)) cancelClose();
      else if (!hasOpenOverlay()) scheduleClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || hasOpenOverlay()) return;
      event.preventDefault();
      closePeek();
      (navigationButtons.current[panePage as PageKey] ?? navigationButtons.current.home)?.focus({
        preventScroll: true,
      });
    };
    const onResize = () => closePeek();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      cancelClose();
    };
  }, [peek, desktopExpanded, closePeek, cancelClose, panePage]);

  const navItems: Array<{ id: PageKey; label: string; compactLabel?: string }> = [
    { id: "home", label: t("nav.home") },
    { id: "scheduler", label: t("nav.scheduler"), compactLabel: t("nav.mobileScheduler") },
    {
      id: "configuration",
      label: t("nav.configuration"),
      compactLabel: t("nav.mobileConfiguration"),
    },
    { id: "plugins", label: t("nav.plugins"), compactLabel: t("nav.mobilePlugins") },
    { id: "settings", label: t("nav.settings"), compactLabel: t("nav.mobileSettings") },
  ];

  const stopAllTasks = async () => {
    trigger({
      timestamp: getTimestampMs(),
      command: "stop_all_tasks",
      payload: {},
    });
    await waitForNormal(
      () => useWebSocketStore.getState().statusStore,
      (statuses) => Object.values(statuses).every((status: any) => !status?.running),
      15_000
    );
  };

  /** Handles the handle backend update interaction. */
  const handleBackendUpdate = async (): Promise<void> => {
    setBackendUpdating(true);
    setBackendUpdateLogs([]);
    setBackendUpdateTerminalText("");
    setBackendUpdateLogOpen(true);
    try {
      if (__WITH_ANDROID__) {
        const stableRegions = new Map<string, any>();
        const shownStableRegions = new Set<string>();
        let sawAndroidUpdateError = false;

        const appendTerminal = (chunk: string) => {
          if (!chunk) return;
          setBackendUpdateTerminalText((prev) => prev + chunk);
        };

        const appendTerminalLine = (line: string) => {
          appendTerminal(`${line}\r\n`);
        };

        const appendStableRegion = (payload: any) => {
          const regionKey = String(payload.regionId ?? payload.taskId ?? "");
          if (regionKey && shownStableRegions.has(regionKey)) return;
          if (regionKey) shownStableRegions.add(regionKey);
          const lines = [payload.title, ...(payload.lines ?? [])]
            .map((line) => String(line ?? "").trimEnd())
            .filter(Boolean);
          if (!lines.length) return;
          appendTerminalLine(lines.join("\r\n"));
        };

        const unlisteners = await Promise.all([
          listen<any>("term:chunk", (event) => {
            appendTerminal(String(event.payload?.chunk ?? ""));
          }),
          listen<any>("term:task-started", (event) => {
            const payload = event.payload;
            appendTerminalLine(
              `[${payload.stepIndex}/${payload.stepTotal}] ${payload.name} started`
            );
          }),
          listen<any>("term:region-stable", (event) => {
            const payload = event.payload ?? {};
            stableRegions.set(String(payload.taskId ?? ""), payload);
            if (sawAndroidUpdateError) {
              appendStableRegion(payload);
            }
          }),
          listen<any>("term:task-status", (event) => {
            const payload = event.payload;
            if (payload.status === "failed" || payload.status === "stopped") {
              sawAndroidUpdateError = true;
              appendTerminalLine(
                `${payload.status.toUpperCase()} ${payload.taskId}: ${payload.error ?? ""}`
              );
              const stableRegion = stableRegions.get(String(payload.taskId ?? ""));
              if (stableRegion) {
                appendStableRegion(stableRegion);
              }
            }
          }),
          listen<any>("term:session-finished", async (event) => {
            const success = Boolean(event.payload?.success);
            appendTerminalLine(
              success ? "DONE android git2 update" : "ERROR android git2 update failed"
            );
            setBackendUpdating(false);
            for (const unlisten of unlisteners) unlisten();
            if (success) {
              toast.success(t("update.backendStarted"));
              try {
                await invoke("updater_reset_backend_auth_and_restart");
                reloadWithoutPrompt();
              } catch (error) {
                toast.error(t("update.backendStartFailed"), {
                  description: error instanceof Error ? error.message : String(error),
                });
              }
            } else {
              toast.error(t("update.backendStartFailed"));
            }
          }),
        ]);
        appendTerminalLine("START android git2 update");
        await invoke("updater_start_workflow", { request: { launch: true } });
        toast.info(t("update.backendStarted"));
        return;
      }
      await stopAllTasks();
      if (__WITH_TAURI__ && !__WITH_ANDROID__) {
        reloadWithoutPrompt();
        return;
      }
      triggerStream(
        {
          timestamp: getTimestampMs(),
          command: "update_to_latest_stream",
          payload: {},
        },
        async (event) => {
          const data = event.data ?? {};
          if (data.done) {
            if (event.status === "error") {
              setBackendUpdateLogs((prev) => [...prev, `ERROR ${String(event.error ?? "")}`]);
              toast.error(t("update.backendStartFailed"), {
                description: String(event.error ?? ""),
              });
            }
            setBackendUpdating(false);
            return;
          }
          if (data.type === "progress") {
            setBackendUpdateLogs((prev) => [...prev, formatBackendUpdateEvent(data)]);
            return;
          }
          if (data.type === "error") {
            setBackendUpdateLogs((prev) => [...prev, `ERROR ${String(data.error ?? "")}`]);
            setBackendUpdating(false);
            toast.error(t("update.backendStartFailed"), {
              description: String(data.error ?? ""),
            });
            return;
          }
          if (data.type === "result") {
            const result = data.result ?? {};
            setBackendUpdating(false);
            if (result.status === "updated") {
              setBackendUpdateLogs((prev) => [...prev, `DONE ${result.current ?? ""}`]);
              toast.success(t("update.backendStarted"), {
                description: result.current ?? result.channel ?? undefined,
              });
              if (__WITH_ANDROID__) {
                try {
                  await invoke("updater_reset_backend_auth_and_restart");
                  reloadWithoutPrompt();
                } catch (error) {
                  toast.error(t("update.backendStartFailed"), {
                    description: error instanceof Error ? error.message : String(error),
                  });
                }
              }
              return;
            }
            if (result.status === "skipped") {
              setBackendUpdateLogs((prev) => [...prev, "SKIP no_update"]);
              toast.info(t("update.tauriUpToDate"));
              return;
            }
            toast.info(t("update.backendStarted"));
          }
        }
      );
      toast.info(t("update.backendStarted"));
    } catch (error) {
      toast.error(t("update.backendStartFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
      setBackendUpdating(false);
    }
  };

  return (
    <div
      className={`app-sidebar relative flex ${__WITH_ANDROID__ && activePage === "settings" ? "h-0" : "h-[52px]"} w-full shrink-0 flex-col lg:mb-[2px] lg:grid lg:h-auto lg:min-h-0 lg:self-stretch lg:grid-rows-[minmax(0,1fr)] lg:transition-[width] lg:duration-200 ${
        desktopExpanded
          ? "lg:w-[292px] lg:grid-cols-[52px_minmax(0,1fr)]"
          : "lg:w-[52px] lg:grid-cols-[52px_0px]"
      }`}
    >
      <aside
        className="desktop-app-rail hidden min-h-0 flex-col items-center gap-3 py-2 lg:col-start-1 lg:row-start-1 lg:flex"
        aria-label="BAAS"
      >
        {(__WITH_TAURI__ || __WITH_ANDROID__) && !customFrame && !sidebarLocked && (
          <IconTooltip content={sidebarToggleLabel} side="right">
            <button
              type="button"
              aria-label={sidebarToggleLabel}
              aria-expanded={desktopExpanded}
              onClick={() => setExpanded(!desktopExpanded)}
              className="mb-1 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {desktopExpanded ? (
                <PanelLeftClose size={17} strokeWidth={1.5} />
              ) : (
                <PanelLeftOpen size={17} strokeWidth={1.5} />
              )}
            </button>
          </IconTooltip>
        )}
        <nav className="flex flex-col gap-2">
          {navItems
            .filter((item) => item.id !== "settings")
            .map((item) => (
              <IconTooltip key={item.id} content={item.label} side="right">
                <button
                  ref={(button) => {
                    navigationButtons.current[item.id] = button;
                  }}
                  type="button"
                  aria-label={item.label}
                  aria-current={activePage === item.id ? "page" : undefined}
                  onClick={() => {
                    closePeek();
                    setActivePage(item.id);
                  }}
                  onPointerEnter={(event) => {
                    if (event.pointerType !== "touch") scheduleOpen(item.id);
                  }}
                  onPointerLeave={scheduleClose}
                  onKeyDown={(event) => {
                    if (
                      event.key === "ArrowRight" &&
                      !desktopExpanded &&
                      !sidebarLocked &&
                      item.id !== "settings"
                    ) {
                      event.preventDefault();
                      cancelOpen();
                      cancelClose();
                      setPeekContext({ page: item.id, originPage: activePage });
                      requestAnimationFrame(() =>
                        profilePaneRef.current?.querySelector<HTMLButtonElement>("button")?.focus()
                      );
                    }
                  }}
                  aria-expanded={desktopExpanded || (peek && panePage === item.id)}
                  aria-controls="desktop-profile-pane"
                  className={`flex size-9 items-center justify-center rounded-[9px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring ${activePage === item.id ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"}`}
                >
                  <NavigationIcon page={item.id} selected={activePage === item.id} size={19} />
                </button>
              </IconTooltip>
            ))}
        </nav>
        <div className="mx-auto mt-1 w-5 border-t border-[var(--workspace-edge)]" />
        <div className="min-h-2 flex-1" />
        {!desktopExpanded && hasAnyUpdate && !peek && (
          <div className="flex w-full flex-col gap-2 px-2">
            {hasBackendUpdate && (
              <UpdateActionButton
                label="BAAS"
                title={t("update.backendAction")}
                icon={PackageOpen}
                busy={backendUpdating}
                onClick={handleBackendUpdate}
                tone="red"
                expanded={false}
              />
            )}
            {hasTauriUpdate && (
              <UpdateActionButton
                label={t("update.tauriAction")}
                title={t("update.tauriAvailable")}
                icon={Download}
                busy={tauriUpdate.updating}
                onClick={tauriUpdate.runUpdate}
                tone="blue"
                expanded={false}
              />
            )}
          </div>
        )}
        <nav className="flex flex-col gap-2">
          {navItems
            .filter((item) => item.id === "settings")
            .map((item) => (
              <IconTooltip key={item.id} content={item.label} side="right">
                <button
                  type="button"
                  aria-label={item.label}
                  aria-current={activePage === item.id ? "page" : undefined}
                  onClick={() => setActivePage(item.id)}
                  className={`flex size-9 items-center justify-center rounded-[9px] transition-colors focus-visible:outline-2 focus-visible:outline-ring ${activePage === item.id ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"}`}
                >
                  <NavigationIcon page={item.id} selected={activePage === item.id} size={19} />
                </button>
              </IconTooltip>
            ))}
        </nav>
        <AboutLogoButton
          onClick={() => {
            closePeek();
            openAbout();
          }}
        />
      </aside>

      <section
        id="desktop-profile-pane"
        ref={profilePaneRef}
        data-profile-peek={peek && !desktopExpanded ? "true" : undefined}
        data-profile-context={panePage}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onFocusCapture={cancelClose}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose();
        }}
        className={`contents min-h-0 min-w-0 lg:flex-col lg:overflow-hidden ${
          desktopExpanded
            ? "lg:relative lg:col-start-2 lg:row-start-1 lg:flex lg:rounded-l-[14px] lg:border-y lg:border-l lg:border-[var(--workspace-edge)] lg:bg-sidebar"
            : peek
              ? "lg:absolute lg:inset-y-0 lg:left-[52px] lg:z-[200] lg:flex lg:w-[260px] lg:max-w-[calc(100vw-60px)] lg:rounded-[10px] lg:border lg:border-[var(--menu-border)] lg:bg-[var(--menu-background)] lg:shadow-[var(--menu-shadow)] lg:backdrop-blur-xl"
              : "lg:hidden"
        }`}
      >
        <div
          className={`profile-pane-heading hidden h-11 min-w-0 shrink-0 items-center justify-between pl-4 pr-2 lg:flex ${panePage === "settings" ? "" : "pt-1"}`}
        >
          {panePage === "settings" ? (
            <span className="text-[18px] font-semibold leading-7 tracking-[-0.01em]">
              {t("nav.settings")}
            </span>
          ) : (
            <WorkspaceSwitcher />
          )}
          {!desktopExpanded && peek && (
            <IconTooltip content={t("app.expandSidebar")} side="right">
              <button
                type="button"
                aria-label={t("app.expandSidebar")}
                onClick={() => setExpanded(true)}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-[var(--menu-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <PanelLeftOpen size={17} strokeWidth={1.5} />
              </button>
            </IconTooltip>
          )}
        </div>
        <div
          className={`profile-pane-content flex min-h-0 min-w-0 [&>.profile-navigation]:min-w-0 [&>.profile-navigation]:flex-1 lg:flex-1 lg:flex-col lg:overflow-hidden lg:px-2 ${panePage === "configuration" ? "profile-pane-content--configuration" : ""}`}
        >
          <Header desktopExpanded={profilePaneVisible} settingsMode={panePage === "settings"} />
          {panePage === "settings" && (
            <div className="hidden min-h-0 flex-1 flex-col lg:flex">
              <SettingsNavigation />
            </div>
          )}
          {panePage === "configuration" && activeProfile && (
            <div className="configuration-sidebar-navigation hidden min-h-0 min-w-0 flex-1 flex-col lg:flex">
              <ConfigurationNavigation
                selected={configuration.selected.id}
                query={configuration.query}
                onQueryChange={configuration.search}
                onSelect={(section) => {
                  configuration.select(section);
                  if (activePage !== "configuration") {
                    closePeek();
                    setActivePage("configuration");
                  }
                }}
              />
            </div>
          )}
        </div>
        {hasAnyUpdate && (
          <footer className="hidden min-w-0 shrink-0 flex-col gap-2 px-2 py-2 lg:flex">
            <div className="flex flex-row gap-2">
              {hasBackendUpdate && (
                <UpdateActionButton
                  label="BAAS"
                  title={t("update.backendAction")}
                  icon={PackageOpen}
                  busy={backendUpdating}
                  onClick={handleBackendUpdate}
                  tone="red"
                  expanded={true}
                />
              )}
              {hasTauriUpdate && (
                <UpdateActionButton
                  label={t("update.tauriAction")}
                  title={t("update.tauriAvailable")}
                  icon={Download}
                  busy={tauriUpdate.updating}
                  onClick={tauriUpdate.runUpdate}
                  tone="blue"
                  expanded={true}
                />
              )}
            </div>
          </footer>
        )}
      </section>

      {/* Mobile bottom navigation */}
      <nav
        className={`mobile-bottom-navigation fixed bottom-0 left-0 z-40 flex w-full items-center justify-between border-t border-border bg-background px-3 lg:hidden ${__WITH_ANDROID__ ? "h-[var(--android-bottom-navigation-height)] pb-[env(safe-area-inset-bottom,0px)]" : "h-[70px]"}`}
      >
        {navItems.map((item) => (
          <React.Fragment key={item.id}>
            <IconTooltip content={item.label} side="top">
              <button
                type="button"
                aria-label={item.label}
                aria-current={activePage === item.id ? "page" : undefined}
                onClick={() => setActivePage(item.id)}
                className={`flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 ${
                  activePage === item.id
                    ? "text-foreground"
                    : "text-muted-foreground/75 hover:text-foreground"
                }`}
              >
                <span className="mobile-navigation-icon flex h-8 w-9 items-center justify-center">
                  <NavigationIcon page={item.id} selected={activePage === item.id} size={24} />
                </span>
                <span
                  className={`mobile-navigation-label block max-w-full truncate text-center text-xs leading-4 ${activePage === item.id ? "font-semibold" : "font-normal"}`}
                >
                  {__WITH_ANDROID__ ? (item.compactLabel ?? item.label) : item.label}
                </span>
              </button>
            </IconTooltip>
          </React.Fragment>
        ))}
        {__WITH_ANDROID__ && (
          <button
            type="button"
            aria-label={primaryRunning ? t("common.stop") : t("common.start")}
            disabled={!activeProfile}
            onClick={() => window.dispatchEvent(new Event("baas:toggle-primary-run"))}
            className={`mobile-primary-run absolute -top-16 right-3 grid h-12 w-12 shrink-0 place-items-center rounded-full border-4 border-background shadow-xl transition active:scale-95 disabled:opacity-50 ${primaryRunning ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}
          >
            {primaryRunning ? (
              <Square className="h-6 w-6 fill-current" />
            ) : (
              <Play className="h-7 w-7 -translate-y-px fill-current" />
            )}
          </button>
        )}
      </nav>

      {/* Mobile floating update buttons */}
      {hasAnyUpdate && (
        <div className="mobile-update-actions lg:hidden fixed bottom-25 right-5 z-50 flex flex-col gap-3">
          {hasBackendUpdate && (
            <FloatingUpdateButton
              title={t("update.backendAction")}
              icon={PackageOpen}
              busy={backendUpdating}
              onClick={handleBackendUpdate}
              tone="red"
            />
          )}
          {hasTauriUpdate && (
            <FloatingUpdateButton
              title={t("update.tauriAvailable")}
              icon={Download}
              busy={tauriUpdate.updating}
              onClick={tauriUpdate.runUpdate}
              tone="blue"
            />
          )}
        </div>
      )}

      <TauriUpdateProgressModal
        open={tauriUpdate.progressOpen}
        onClose={() => tauriUpdate.setProgressOpen(false)}
        updating={tauriUpdate.updating}
        tauriProgress={tauriUpdate.progress}
        tauriStatus={tauriUpdate.status}
      />
      {backendUpdateLogOpen && (
        <div className="mobile-update-log fixed inset-x-4 bottom-24 z-60 mx-auto max-w-2xl rounded-lg border border-slate-300 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-950 lg:bottom-6">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Android update log
            </div>
            <button
              type="button"
              className="rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={() => setBackendUpdateLogOpen(false)}
            >
              Close
            </button>
          </div>
          {__WITH_ANDROID__ ? (
            <div className="h-64 overflow-hidden rounded bg-slate-950 p-3">
              <React.Suspense
                fallback={
                  <pre className="h-full overflow-auto text-xs leading-5 text-slate-100">
                    {backendUpdateTerminalText || "waiting...\r\n"}
                  </pre>
                }
              >
                <InlineXTermLog text={backendUpdateTerminalText || "waiting...\r\n"} />
              </React.Suspense>
            </div>
          ) : (
            <pre className="max-h-64 overflow-auto rounded bg-slate-950 p-3 text-xs leading-5 text-slate-100">
              {(backendUpdateLogs.length ? backendUpdateLogs : ["waiting..."]).join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

export default Sidebar;

const AboutLogoButton: React.FC<{ onClick: () => void; side?: "right" | "bottom" }> = ({
  onClick,
  side = "right",
}) => {
  const { t } = useTranslation();
  return (
    <IconTooltip content={t("about.title")} side={side}>
      <button
        type="button"
        aria-label={t("about.title")}
        aria-describedby="baas-service-status"
        onClick={onClick}
        className="relative flex size-9 shrink-0 items-center justify-center rounded-lg outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <img src="/images/logo.png" alt="" draggable={false} className="size-5 object-contain" />
        <HeartbeatIndicator
          id="baas-service-status"
          className="pointer-events-none absolute right-1.5 top-1.5 ring-[1.5px] ring-(--chrome-background)"
        />
      </button>
    </IconTooltip>
  );
};

type UpdateTone = "red" | "blue";

const toneClasses: Record<UpdateTone, { desktop: string; floating: string }> = {
  red: {
    desktop:
      "bg-red-100/70 text-red-600 hover:bg-red-100 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900/80",
    floating: "bg-red-500 hover:bg-red-600 text-white",
  },
  blue: {
    desktop:
      "bg-sky-100/80 text-sky-700 hover:bg-sky-100 dark:bg-sky-900/50 dark:text-sky-300 dark:hover:bg-sky-900/80",
    floating: "bg-sky-500 hover:bg-sky-600 text-white",
  },
};

/** Renders the update action button component. */
const UpdateActionButton: React.FC<{
  label: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  busy: boolean;
  onClick: () => void | Promise<void>;
  tone: UpdateTone;
  expanded: boolean;
}> = ({ label, title, icon: Icon, busy, onClick, tone, expanded }) => (
  <IconTooltip content={title} side="right">
    <button
      type="button"
      aria-label={title}
      onClick={onClick}
      disabled={busy}
      className={`flex min-w-0 flex-1 items-center justify-center rounded-lg px-3 py-2 text-sm font-bold transition disabled:opacity-60 ${toneClasses[tone].desktop}`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      <span
        className={`overflow-hidden whitespace-nowrap transition-[width,opacity,margin] duration-150 ${
          expanded ? "ml-2 w-auto opacity-100" : "ml-0 w-0 opacity-0"
        }`}
      >
        {label}
      </span>
    </button>
  </IconTooltip>
);

/** Renders the floating update button component. */
const FloatingUpdateButton: React.FC<{
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  busy: boolean;
  onClick: () => void | Promise<void>;
  tone: UpdateTone;
}> = ({ title, icon: Icon, busy, onClick, tone }) => {
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);

  return (
    <IconTooltip content={title} side="top">
      <motion.button
        type="button"
        aria-label={title}
        onClick={onClick}
        disabled={busy}
        whileHover={lowPerformanceMode ? undefined : { scale: 1.08 }}
        whileTap={lowPerformanceMode ? undefined : { scale: 0.95 }}
        animate={lowPerformanceMode ? { y: 0 } : { y: [0, -4, 0] }}
        transition={{
          duration: lowPerformanceMode ? 0 : 2,
          repeat: lowPerformanceMode ? 0 : Infinity,
          ease: "easeInOut",
        }}
        className={`flex h-13 w-13 items-center justify-center rounded-full shadow-lg transition disabled:opacity-60 ${toneClasses[tone].floating}`}
      >
        {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Icon className="h-6 w-6" />}
      </motion.button>
    </IconTooltip>
  );
};

const formatBytes = (value?: number): string => {
  if (!value) return "0 B";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
};

const formatBackendUpdateEvent = (data: any): string => {
  const stage = String(data.stage ?? "progress");
  if (stage === "fetch_sha")
    return `FETCH SHA channel=${data.channel ?? ""} method=${data.method ?? ""}`;
  if (stage === "remote_sha") return `REMOTE SHA ${String(data.sha ?? "").slice(0, 12)}`;
  if (stage === "download_start") return `DOWNLOAD ${data.url ?? ""}`;
  if (stage === "download_progress") {
    if (data.total)
      return `DOWNLOADING ${formatBytes(data.downloaded)} / ${formatBytes(data.total)}`;
    return `DOWNLOADING ${formatBytes(data.downloaded)}`;
  }
  if (stage === "download_done") return `DOWNLOADED ${formatBytes(data.downloaded)}`;
  if (stage === "extract_start") return "EXTRACT archive";
  if (stage === "copy_start") return "COPY repository files";
  if (stage === "copy_done") return "COPY done";
  if (stage === "write_setup") return "WRITE setup.toml";
  if (stage === "done") return `DONE ${String(data.sha ?? "").slice(0, 12)}`;
  if (stage === "skipped") return `SKIP ${data.reason ?? ""}`;
  return stage.toUpperCase();
};
