import { IconTooltip } from "@/components/ui/Tooltip";
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useApp } from "@/context/AppContext";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FilePlus2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { AnimatePresence, motion, Reorder } from "framer-motion";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import { useModalFocus } from "@/components/ui/Modal.tsx";
import { useWebSocketStore } from "@/store/WebsocketStore";
import StorageUtil from "@/shared/StorageManager.ts";
import { getTimestampMs } from "@/shared/GlobalUtilities.ts";
import { toast } from "sonner";
import { useUISetting } from "@/context/UISettingsProvider.tsx";
import { buildServerOptions } from "@/shared/serverOptions";
import { useShallow } from "zustand/react/shallow";
import { useProfileActionsController } from "@/context/ProfileActionsProvider";
import { profileDisplayName, unusedDefaultProfileName } from "@/shared/ProfileName";
import { runProfileCommand, waitForProfileConfig } from "@/shared/ProfileCommands";
import { reconcileProfileTabs, type ProfileTab as Tab } from "@/shared/ProfileTabs";

const noScrollbarStyle =
  "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** Renders the header component. */
const Header: React.FC<{ desktopExpanded?: boolean; settingsMode?: boolean }> = ({
  desktopExpanded = true,
  settingsMode = false,
}) => {
  const { t } = useTranslation();
  const { activeProfile, setActiveProfile } = useApp();
  const profileActions = useProfileActionsController();
  const canManageProfiles = useWebSocketStore(
    (state) => state._auth_phase === "authenticated" && state._all_data_initialized
  );
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const [desktop, setDesktop] = React.useState(
    () => window.matchMedia("(min-width: 64rem)").matches
  );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 64rem)");
    const update = () => setDesktop(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const [tabs, setTabs] = React.useState<Tab[]>([]);
  const tabsRef = useRef(tabs);

  const profileEntries = useWebSocketStore(
    useShallow((state) =>
      Object.entries(state.configStore).map(([id, config]: [string, any]) =>
        JSON.stringify([
          id,
          profileDisplayName(String(config.name ?? "")),
          String(config.server ?? ""),
        ])
      )
    )
  );
  const modify = useWebSocketStore((s) => s.modify);
  const trigger = useWebSocketStore((s) => s.trigger);

  const stripRef = React.useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = React.useState({ left: false, right: false });
  const updateScrollButtons = React.useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setCanScroll({
      left: el.scrollLeft > 0,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  React.useEffect(() => {
    updateScrollButtons();
    const el = stripRef.current;
    if (!el) return;
    /** Handles the on resize interaction. */
    const onResize = () => updateScrollButtons();
    /** Handles the on scroll interaction. */
    const onScroll = () => updateScrollButtons();
    window.addEventListener("resize", onResize);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
      el.removeEventListener("scroll", onScroll as any);
    };
  }, [updateScrollButtons]);

  const scrollBy = (dx: number) => {
    stripRef.current?.scrollBy({ left: dx, behavior: lowPerformanceMode ? "auto" : "smooth" });
  };

  const [ctxMenu, setCtxMenu] = React.useState<{ x: number; y: number; tab?: Tab } | null>(null);
  const ctxMenuRef = React.useRef<HTMLDivElement>(null);
  const ctxMenuOpener = React.useRef<HTMLElement | null>(null);

  const [editor, setEditor] = React.useState<null | { mode: "create" | "edit"; tab?: Tab }>(null);

  const [confirmDelete, setConfirmDelete] = React.useState<null | Tab>(null);

  const hideCtxMenu = () => setCtxMenu(null);

  useEffect(() => {
    // profileEntries triggers reconciliation, but a queued effect/reorder must
    // read current membership and metadata rather than a previous render.
    const list = reconcileProfileTabs(
      useWebSocketStore.getState().configStore,
      StorageUtil.get("tabOrder")
    );
    tabsRef.current = list;
    setTabs(list);
    const exists = list.find((p) => p.id === activeProfile?.id);
    const nextActive = exists ?? list[0];
    setActiveProfile(nextActive);
    (async () => {
      setTimeout(() => {
        if (!nextActive) return;
        const el = document.getElementById(`tab-${nextActive.id}`);
        el?.scrollIntoView({
          behavior: lowPerformanceMode ? "auto" : "smooth",
          inline: "center",
          block: "nearest",
        });
      }, 0);
    })();
  }, [profileEntries, lowPerformanceMode, setActiveProfile]);

  /** Handles the on reorder interaction. */
  const onReorder = (next: Tab[]) => {
    const reconciled = reconcileProfileTabs(
      useWebSocketStore.getState().configStore,
      next.map((tab) => tab.id)
    );
    tabsRef.current = reconciled;
    setTabs(reconciled);
    StorageUtil.set(
      "tabOrder",
      reconciled.map((tab) => tab.id)
    );
  };

  /** Handles the on select interaction. */
  const onSelect = (tab: Tab) => {
    setActiveProfile(tab);
    // Keep the selected tab in view.
    const el = document.getElementById(`tab-${tab.id}`);
    el?.scrollIntoView({
      behavior: lowPerformanceMode ? "auto" : "smooth",
      inline: "center",
      block: "nearest",
    });
  };

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  /** Handles the handle create interaction. */
  const handleCreate = async (name: string, server: string) => {
    if (tabsRef.current.some((t) => (t.name ?? "").trim() === name.trim()))
      throw new Error(t("profile.nameExists"));

    const result = await runProfileCommand(useWebSocketStore.getState, "add_config", {
      name,
      server,
    });
    await waitForConfig(result?.serial);
  };

  const runTrigger = React.useCallback(
    (command: string, payload: Record<string, any>) =>
      runProfileCommand(useWebSocketStore.getState, command, payload),
    []
  );

  const waitForConfig = React.useCallback(
    async (serialName: string) => {
      const profile = await waitForProfileConfig(useWebSocketStore.getState, serialName);
      // The store snapshot can precede React's tab-list effect by one render.
      const next: Tab = {
        id: serialName,
        name: profileDisplayName(String(profile.name)),
        server: String(profile.server ?? ""),
      };
      setActiveProfile(next);
    },
    [setActiveProfile]
  );

  /** Handles the handle copy interaction. */
  const handleCopy = async (tab: Tab) => {
    try {
      const result = await runTrigger("copy_config", { id: tab.id });
      await waitForConfig(result.serial);
    } catch (error: any) {
      toast.error(t("profile.copyFailed"), { description: error?.message });
    }
  };

  /** Handles the handle export interaction. */
  const handleExport = async (tab: Tab) => {
    try {
      const result = await runTrigger("export_config", { id: tab.id });
      await StorageUtil.download(
        result.data?.filename || result.filename || `${tab.name}.zip`,
        result.binary,
        t
      );
    } catch (error: any) {
      toast.error(t("profile.exportFailed"), { description: error?.message });
    }
  };

  /** Handles the handle import interaction. */
  const handleImport = React.useCallback(async () => {
    try {
      const bytes = await StorageUtil.upload(t, ".zip");
      if (!bytes) return;
      const result = await runProfileCommand(
        useWebSocketStore.getState,
        "import_config",
        {},
        bytes
      );
      await waitForConfig(result?.serial);
      setEditor(null);
    } catch (error: any) {
      toast.error(t("profile.importFailed"), { description: error?.message });
    }
  }, [setEditor, t, waitForConfig]);

  /** Handles the handle edit interaction. */
  const handleEdit = async (tab: Tab, name: string, server: string) => {
    const trimmed = name.trim();
    if (tabs.some((t) => t.id !== tab.id && t.name.trim() === trimmed))
      throw new Error(t("profile.nameExists"));
    modify(`${tab.id}::config`, { name: trimmed, server: server });
    setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, name: trimmed, server } : t)));
    if (activeProfile?.id === tab.id) setActiveProfile({ ...activeProfile, name: trimmed });
  };

  /** Handles the handle delete interaction. */
  const handleDelete = async (tab: Tab) => {
    if (tabs.length <= 1) {
      alert(t("profile.cannotDeleteLast"));
      return;
    }

    let nextActive: Tab | null = null;

    setTabs((prev) => {
      const idx = prev.findIndex((p) => p.id === tab.id);
      const next = prev.filter((p) => p.id !== tab.id);
      if (activeProfile?.id === tab.id) {
        nextActive = next[Math.max(0, Math.min(idx, next.length - 1))] ?? null;
      }
      return next;
    });

    if (nextActive) {
      queueMicrotask(() => setActiveProfile(nextActive));
    }

    trigger({
      timestamp: getTimestampMs(),
      command: "remove_config",
      payload: {
        id: tab.id,
      },
    });
  };

  React.useLayoutEffect(() => {
    const element = ctxMenuRef.current;
    if (!ctxMenu || !element) return;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(ctxMenu.x + 2, window.innerWidth - width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(ctxMenu.y + 2, window.innerHeight - height - 8))}px`;
    element.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus({ preventScroll: true });
  }, [ctxMenu]);

  React.useEffect(() => {
    if (!ctxMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ctxMenuRef.current?.contains(event.target as Node)) hideCtxMenu();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", hideCtxMenu);
    window.addEventListener("blur", hideCtxMenu);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", hideCtxMenu);
      window.removeEventListener("blur", hideCtxMenu);
    };
  }, [ctxMenu]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      hideCtxMenu();
      ctxMenuOpener.current?.focus({ preventScroll: true });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']")
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };

  const runningByProfile = useWebSocketStore(
    useShallow((state) =>
      Object.fromEntries(
        Object.entries(state.statusStore).map(([id, status]) => [id, Boolean(status?.running)])
      )
    )
  );

  useEffect(() => {
    if (!canManageProfiles) return;
    return profileActions.attach({
      create: () => setEditor({ mode: "create" }),
      import: handleImport,
    });
  }, [profileActions, canManageProfiles, handleImport]);

  return (
    <>
      <header
        className={
          settingsMode
            ? __WITH_ANDROID__
              ? "hidden"
              : "profile-navigation flex h-[52px] min-w-0 shrink-0 items-center border-b border-border bg-background px-4 text-sm lg:hidden"
            : `profile-navigation flex h-[52px] min-h-0 shrink-0 items-center gap-1 border-b border-border bg-background px-2 text-sm lg:h-auto lg:flex-1 lg:flex-col lg:items-stretch lg:gap-2 lg:border-0 lg:bg-transparent lg:px-0 lg:pt-2 ${desktopExpanded ? "" : "lg:hidden"}`
        }
      >
        {settingsMode ? (
          <h1 className="font-semibold text-foreground">{t("nav.settings")}</h1>
        ) : (
          <>
            <div className="hidden shrink-0 items-center justify-between pl-2 lg:flex">
              <span className="text-[14px] font-medium text-muted-foreground">
                {t("profile.list")}
              </span>
              <IconTooltip content={t("profile.add")} side="bottom">
                <button
                  type="button"
                  onClick={() => setEditor({ mode: "create" })}
                  aria-label={t("profile.add")}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                >
                  <FilePlus2 className="h-4 w-4" strokeWidth={1.6} />
                </button>
              </IconTooltip>
            </div>
            {/* Left side: scroll controls */}
            <div className={__WITH_ANDROID__ ? "hidden" : "mr-1 flex items-center gap-1 lg:hidden"}>
              <button
                className={`flex h-[36px] w-[36px] items-center justify-center rounded-lg hover:bg-accent ${!canScroll.left ? "pointer-events-none opacity-40" : ""}`}
                onClick={() => scrollBy(-200)}
                aria-label="scroll-left"
              >
                <ChevronLeft className="h-[20px] w-[20px]" />
              </button>
              <button
                className={`flex h-[36px] w-[36px] items-center justify-center rounded-lg hover:bg-accent ${!canScroll.right ? "pointer-events-none opacity-40" : ""}`}
                onClick={() => scrollBy(200)}
                aria-label="scroll-right"
              >
                <ChevronRight className="h-[20px] w-[20px]" />
              </button>
            </div>

            <div
              ref={stripRef}
              className={`min-h-0 min-w-0 flex-1 overflow-x-auto lg:overflow-x-hidden lg:overflow-y-auto ${noScrollbarStyle}`}
            >
              <Reorder.Group
                axis={desktop ? "y" : "x"}
                values={tabs}
                onReorder={onReorder}
                className={`flex items-stretch gap-1 lg:h-auto lg:flex-col lg:gap-0.5 ${__WITH_ANDROID__ ? "h-11" : "h-9"}`}
              >
                {tabs.map((tab) => {
                  const active = activeProfile?.id === tab.id;
                  const menuOpen = ctxMenu?.tab?.id === tab.id;
                  // A config can arrive before its status or survive status
                  // recovery. Missing status must not hide its entry point.
                  return (
                    <Reorder.Item
                      id={`tab-${tab.id}`}
                      key={tab.id}
                      value={tab}
                      layout={lowPerformanceMode ? undefined : true}
                      transition={{ duration: lowPerformanceMode ? 0 : 0.18 }}
                      role="button"
                      tabIndex={0}
                      aria-pressed={active}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (
                          event.key === "ContextMenu" ||
                          (event.shiftKey && event.key === "F10")
                        ) {
                          event.preventDefault();
                          const bounds = event.currentTarget.getBoundingClientRect();
                          ctxMenuOpener.current = event.currentTarget;
                          setCtxMenu({ x: bounds.right - 8, y: bounds.bottom, tab });
                          return;
                        }
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelect(tab);
                        }
                      }}
                      className={`group relative flex max-w-xs shrink-0 select-none items-center rounded-lg px-3 lg:h-8 lg:w-full lg:max-w-none lg:px-2 ${__WITH_ANDROID__ ? "h-11" : "h-9"}
                    cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring
                    ${
                      active
                        ? "bg-secondary text-foreground lg:bg-sidebar-accent"
                        : "text-foreground hover:bg-secondary lg:hover:bg-sidebar-accent"
                    }
                  `}
                      onClick={() => onSelect(tab)}
                      onPointerDown={(e: any) => {
                        if ((e as any).button === 1) {
                          e.preventDefault();
                          setConfirmDelete(tab);
                        }
                      }}
                      onContextMenu={(e: any) => {
                        e.preventDefault();
                        e.stopPropagation();
                        ctxMenuOpener.current = e.currentTarget;
                        setCtxMenu({ x: e.clientX, y: e.clientY, tab });
                      }}
                    >
                      {runningByProfile[tab.id] && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin lg:hidden" />
                      )}

                      {/* Profile name */}
                      <span
                        className={`min-w-0 truncate text-[14px] font-normal lg:pr-7 ${__WITH_ANDROID__ ? "pr-10" : "pr-6"}`}
                      >
                        {tab.name}
                      </span>

                      {/* A single action slot keeps activity and menu icons aligned. */}
                      <IconTooltip content={t("profile.edit")} side="bottom">
                        <button
                          type="button"
                          aria-label={`${t("profile.edit")} ${tab.name}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md transition-colors group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-secondary lg:right-0 lg:size-7 ${__WITH_ANDROID__ ? "size-11 opacity-100" : "size-6 opacity-0"} ${runningByProfile[tab.id] ? "lg:opacity-100" : ""} ${menuOpen ? "opacity-100" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            const bounds = e.currentTarget.getBoundingClientRect();
                            ctxMenuOpener.current = e.currentTarget;
                            setCtxMenu({ x: bounds.right - 8, y: bounds.bottom, tab });
                          }}
                        >
                          {runningByProfile[tab.id] && !menuOpen && (
                            <Loader2 className="hidden h-4 w-4 animate-spin lg:block lg:group-hover:hidden lg:group-focus-within:hidden" />
                          )}
                          <MoreHorizontal
                            className={`h-4 w-4 ${runningByProfile[tab.id] && !menuOpen ? "lg:hidden lg:group-hover:block lg:group-focus-within:block" : ""}`}
                          />
                        </button>
                      </IconTooltip>
                    </Reorder.Item>
                  );
                })}
              </Reorder.Group>
            </div>

            {/* Right side: create button */}
            <div className="ml-1 lg:hidden">
              <IconTooltip content={t("profile.add")} side="bottom">
                <button
                  onClick={() => setEditor({ mode: "create" })}
                  aria-label={t("profile.add")}
                  className={`flex shrink-0 items-center justify-center rounded-lg p-0 text-foreground transition-colors hover:bg-secondary ${__WITH_ANDROID__ ? "size-11" : "size-8"}`}
                >
                  <FilePlus2 className="block h-[20px] w-[20px] shrink-0" />
                </button>
              </IconTooltip>
            </div>
          </>
        )}
      </header>
      {createPortal(
        <>
          {/* Menus live outside the scrolling sidebar so they remain visible at any zoom. */}
          <AnimatePresence>
            {ctxMenu && ctxMenu.tab && (
              <motion.div
                ref={ctxMenuRef}
                role="menu"
                data-native-preview-blocker
                aria-label={ctxMenu.tab.name}
                onKeyDown={onMenuKeyDown}
                onContextMenu={(event) => event.preventDefault()}
                initial={lowPerformanceMode ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={lowPerformanceMode ? undefined : { opacity: 0 }}
                transition={{ type: "tween", duration: lowPerformanceMode ? 0 : 0.1 }}
                className="fixed z-[1300] w-[220px] max-w-[calc(100vw-16px)] select-none rounded-[8px] border-none bg-[var(--menu-background)] p-[6px] text-popover-foreground shadow-[var(--menu-shadow)] backdrop-blur-xl backdrop-saturate-125"
                style={{
                  top: Math.max(8, Math.min(ctxMenu.y + 2, window.innerHeight - 180)),
                  left: Math.max(8, Math.min(ctxMenu.x + 2, window.innerWidth - 200)),
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex h-7 w-full cursor-default items-center gap-2.5 rounded-[4px] px-3 text-[13px] outline-none hover:bg-[var(--menu-hover)] focus-visible:bg-[var(--menu-hover)]"
                  onClick={() => {
                    ctxMenuOpener.current?.focus({ preventScroll: true });
                    setEditor({ mode: "edit", tab: ctxMenu.tab! });
                    setCtxMenu(null);
                  }}
                >
                  <Pencil className="size-3.5 text-muted-foreground" strokeWidth={1.6} />{" "}
                  {t("common.edit")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex h-7 w-full cursor-default items-center gap-2.5 rounded-[4px] px-3 text-[13px] outline-none hover:bg-[var(--menu-hover)] focus-visible:bg-[var(--menu-hover)]"
                  onClick={() => {
                    void handleCopy(ctxMenu.tab!);
                    setCtxMenu(null);
                  }}
                >
                  <Copy className="size-3.5 text-muted-foreground" strokeWidth={1.6} />{" "}
                  {t("profile.copy")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex h-7 w-full cursor-default items-center gap-2.5 rounded-[4px] px-3 text-[13px] outline-none hover:bg-[var(--menu-hover)] focus-visible:bg-[var(--menu-hover)]"
                  onClick={() => {
                    void handleExport(ctxMenu.tab!);
                    setCtxMenu(null);
                  }}
                >
                  <Download className="size-3.5 text-muted-foreground" strokeWidth={1.6} />{" "}
                  {t("profile.export")}
                </button>
                <div role="separator" className="-mx-[6px] my-[6px] h-px bg-[var(--menu-border)]" />
                <button
                  type="button"
                  role="menuitem"
                  className="flex h-7 w-full cursor-default items-center gap-2.5 rounded-[4px] px-3 text-[13px] text-destructive outline-none hover:bg-[var(--menu-hover)] focus-visible:bg-[var(--menu-hover)]"
                  onClick={() => {
                    ctxMenuOpener.current?.focus({ preventScroll: true });
                    setConfirmDelete(ctxMenu.tab!);
                    setCtxMenu(null);
                  }}
                >
                  <Trash2 className="size-3.5" strokeWidth={1.6} /> {t("common.delete")}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Edit/create modal */}
          <ProfileEditorModal
            open={!!editor}
            mode={editor?.mode || "create"}
            initial={editor?.tab || null}
            onClose={() => setEditor(null)}
            onSubmit={async (vals) => {
              if (editor?.mode === "create") {
                await handleCreate(vals.name, vals.server);
              } else if (editor?.mode === "edit" && editor?.tab) {
                await handleEdit(editor.tab, vals.name, vals.server);
              }
              setEditor(null);
            }}
            onImport={handleImport}
            // Local duplicate-name validation.
            checkName={(name, selfId) =>
              tabs.some((t) => t.id !== selfId && t.name.trim() === name.trim())
            }
          />

          {/* Delete confirmation modal with icon. */}
          <ConfirmDeleteModal
            open={!!confirmDelete}
            name={confirmDelete?.name || ""}
            onCancel={() => setConfirmDelete(null)}
            onConfirm={async () => {
              if (confirmDelete) await handleDelete(confirmDelete);
              setConfirmDelete(null);
            }}
            disabled={tabs.length <= 1}
          />
        </>,
        document.body
      )}
    </>
  );
};

export default Header;

const overlayCls =
  "fixed inset-0 bg-black/35 flex items-center justify-center p-4 pt-[calc(var(--window-titlebar-height,0px)+1rem)] z-[1100]";

/** Renders the profile editor modal component. */
const ProfileEditorModal = (props: {
  open: boolean;
  mode: "create" | "edit";
  initial: Tab | null;
  onClose: () => void;
  onSubmit: (vals: { name: string; server: string }) => Promise<void>;
  onImport: () => Promise<void>;
  checkName: (name: string, selfId?: string) => boolean;
}) => {
  const { t } = useTranslation();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const [name, setName] = React.useState(
    () => props.initial?.name ?? unusedDefaultProfileName((value) => props.checkName(value))
  );
  const [server, setServer] = React.useState("CN");
  const [err, setErr] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useModalFocus(props.open, panelRef, () => {
    if (!submitting && !importing) props.onClose();
  });

  React.useEffect(() => {
    if (props.open) {
      setName(props.initial?.name ?? unusedDefaultProfileName((value) => props.checkName(value)));
      setServer(props.initial?.server ?? "NULL");
      setErr(null);
    }
  }, [props.open, props.initial]);

  /** Handles the handle submit interaction. */
  const handleSubmit = async () => {
    const nm = name.trim();
    if (!nm) return setErr(t("configAdd.nameRequired"));
    if (server === "NULL") return setErr(t("configAdd.serverRequired"));
    if (props.checkName(nm, props.initial?.id)) return setErr(t("configAdd.nameDuplicate"));
    try {
      setSubmitting(true);
      await props.onSubmit({ name: nm, server });
    } catch (e: any) {
      console.error(e);
      console.error({ nm, server });
      setErr(e?.message || t("configAdd.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  /** Handles the handle import interaction. */
  const handleImport = async () => {
    try {
      setImporting(true);
      await props.onImport();
    } catch (e: any) {
      setErr(e?.message || t("profile.importFailed"));
    } finally {
      setImporting(false);
    }
  };

  if (!props.open) return null;
  return (
    <div
      data-modal-backdrop=""
      className={overlayCls}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting && !importing) props.onClose();
      }}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial={lowPerformanceMode ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={lowPerformanceMode ? undefined : { opacity: 0, y: 4 }}
        transition={{ duration: lowPerformanceMode ? 0 : 0.14, type: "tween", ease: "easeOut" }}
        className="modal-surface w-full max-w-105 max-h-[calc(100dvh-var(--window-titlebar-height,0px)-32px)] overflow-y-auto outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId} className="modal-title">
            {props.mode === "create" ? t("profile.create") : t("profile.edit")}
          </h2>
          <IconTooltip content={t("common.close")} side="bottom">
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={props.onClose}
              disabled={submitting || importing}
              className="modal-close disabled:opacity-40"
            >
              <X className="size-4" />
            </button>
          </IconTooltip>
        </div>

        <div className="space-y-4">
          {props.mode === "create" && (
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || submitting}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-[8px] border border-input px-3 text-sm outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"
            >
              {importing ? (
                <Loader2 className="animate-spin h-4 w-4" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              <span>{t("profile.import")}</span>
            </button>
          )}

          <FormInput
            data-autofocus
            value={name}
            label={t("profile.name")}
            placeholder={t("placeholder.profileName")}
            onChange={(e) => setName(e.target.value)}
          />

          <FormSelect
            label={t("server.server")}
            value={server}
            disabled={props.mode === "edit"}
            onChange={(e) => setServer(e)}
            placeholder={t("configAdd.selectServer")}
            options={[
              { label: t("configAdd.selectServer"), value: "NULL" },
              ...buildServerOptions(t),
            ]}
          />

          {err && (
            <div role="alert" className="text-sm text-destructive">
              {err}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            data-variant="secondary"
            onClick={props.onClose}
            className="h-8 rounded-[8px] bg-secondary px-3.5 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"
            disabled={submitting || importing}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="flex h-8 items-center rounded-[8px] bg-primary px-3.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"
            disabled={submitting || importing}
          >
            {submitting && <Loader2 className="animate-spin mr-2 h-4 w-4" />}
            <span>{props.mode === "create" ? t("common.create") : t("common.save")}</span>
          </button>
        </div>
      </motion.div>
    </div>
  );
};

/** Renders the confirm delete modal component. */
const ConfirmDeleteModal = (props: {
  open: boolean;
  name: string;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) => {
  const { t } = useTranslation();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useModalFocus(props.open, panelRef, props.onCancel);
  if (!props.open) return null;
  return (
    <div
      data-modal-backdrop=""
      className={overlayCls}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <motion.div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial={lowPerformanceMode ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={lowPerformanceMode ? undefined : { opacity: 0, y: 4 }}
        transition={{ duration: lowPerformanceMode ? 0 : 0.14 }}
        className="modal-surface w-full max-w-105 max-h-[calc(100dvh-var(--window-titlebar-height,0px)-32px)] overflow-y-auto outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId} className="modal-title">
            {t("profile.deleteConfirmTitle")}
          </h2>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={props.onCancel}
            className="modal-close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="text-sm leading-6 text-muted-foreground">
          {t("profile.deleteConfirmMessage", { name: props.name })}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            data-variant="secondary"
            data-autofocus
            onClick={props.onCancel}
            className="h-8 rounded-[8px] bg-secondary px-3.5 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            disabled={props.disabled}
            className="h-8 rounded-[8px] bg-destructive px-3.5 text-sm font-medium text-white outline-none transition-colors hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:opacity-40"
          >
            {t("common.delete")}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
