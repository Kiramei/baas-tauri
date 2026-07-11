import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/context/AppContext";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FilePlus2,
  Loader2,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { AnimatePresence, motion, Reorder } from "framer-motion";
import { type ProfileDTO } from "@/types/app";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import { useBackendStore, waitForNormal } from "@/store/BackendStore";
import StorageUtil from "@/shared/StorageManager.ts";
import { getTimestampMs } from "@/shared/GlobalUtilities.ts";
import { toast } from "sonner";
import { useUISettings } from "@/context/UISettingsProvider.tsx";
import { buildServerOptions } from "@/shared/serverOptions";

const noScrollbarStyle =
  "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

type Tab = ProfileDTO;

/** Returns the is profile ready result. */
const isProfileReady = (profile: Tab): boolean =>
  Boolean(profile.name && profile.settings?.ap && profile.settings?._pass);

/** Renders the header component. */
const Header: React.FC = () => {
  const { t } = useTranslation();
  const { activeProfile, setActiveProfile } = useApp();
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;

  const [tabs, setTabs] = React.useState<Tab[]>([]);
  const tabsRef = useRef(tabs);

  const configStore = useBackendStore((s) => s.configStore);
  const { modify, trigger, triggerBinary } = useBackendStore();

  const stripRef = React.useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = React.useState({ left: false, right: false });
  /** Performs the update scroll buttons operation. */
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

  /** Handles the scroll by workflow. */
  const scrollBy = (dx: number) => {
    stripRef.current?.scrollBy({ left: dx, behavior: lowPerformanceMode ? "auto" : "smooth" });
  };

  const [ctxMenu, setCtxMenu] = React.useState<{ x: number; y: number; tab?: Tab } | null>(null);

  const [editor, setEditor] = React.useState<null | { mode: "create" | "edit"; tab?: Tab }>(null);

  const [confirmDelete, setConfirmDelete] = React.useState<null | Tab>(null);

  /** Handles the hide ctx menu workflow. */
  const hideCtxMenu = () => setCtxMenu(null);

  useEffect(() => {
    const list = Object.keys(configStore).map((key) => ({
      id: key,
      name: configStore[key].name,
      server: configStore[key].server,
      settings: configStore[key],
    }));
    const order = StorageUtil.get("tabOrder");
    if (order && order.length) {
      list.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    }
    setTabs(list);
    const exists = list.find((p) => p.id === activeProfile?.id);
    setActiveProfile(exists ?? list[0]);
    (async () => {
      setTimeout(() => {
        if (!(exists ?? list[0])) return;
        const el = document.getElementById(`tab-${exists ?? list[0].id}`);
        el?.scrollIntoView({
          behavior: lowPerformanceMode ? "auto" : "smooth",
          inline: "center",
          block: "nearest",
        });
      }, 0);
    })();
  }, [configStore, lowPerformanceMode]);

  /** Handles the on reorder interaction. */
  const onReorder = (next: Tab[]) => {
    setTabs(next);
    StorageUtil.set(
      "tabOrder",
      next.map((t) => t.id)
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

    const serialName = await new Promise<string>((resolve) => {
      trigger(
        {
          timestamp: getTimestampMs() + Math.random() * 1000,
          command: "add_config",
          payload: { name, server },
        },
        (e) => resolve(e.data.serial)
      );
    });

    await waitForNormal(
      () => tabsRef.current.filter((p) => p.id === serialName),
      (val) => val.some(isProfileReady)
    );

    const next = tabsRef.current.find((p) => p.id === serialName);
    if (next) setActiveProfile(next);
  };

  /** Performs the run trigger operation. */
  const runTrigger = React.useCallback(
    (command: string, payload: Record<string, any>) =>
      new Promise<any>((resolve, reject) => {
        trigger(
          {
            timestamp: getTimestampMs() + Math.random() * 1000,
            command,
            payload,
          },
          (event) => {
            if (event?.status === "error") {
              reject(new Error(event.error || `${command} failed`));
              return;
            }
            resolve(event?.binary ? event : event?.data);
          }
        );
      }),
    [trigger]
  );

  /** Handles the wait for config workflow. */
  const waitForConfig = async (serialName: string) => {
    await waitForNormal(
      () => tabsRef.current.filter((p) => p.id === serialName),
      (val) => val.some(isProfileReady)
    );
    const next = tabsRef.current.find((p) => p.id === serialName);
    if (next) setActiveProfile(next);
  };

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
  const handleImport = async () => {
    try {
      const bytes = await StorageUtil.upload(t, ".zip");
      if (!bytes) return;
      const result = await new Promise<any>((resolve, reject) => {
        triggerBinary(
          {
            timestamp: getTimestampMs() + Math.random() * 1000,
            command: "import_config",
            payload: {},
          },
          bytes,
          (event) => {
            if (event?.status === "error") {
              reject(new Error(event.error || "import_config failed"));
              return;
            }
            resolve(event?.data);
          }
        );
      });
      await waitForConfig(result.serial);
      setEditor(null);
    } catch (error: any) {
      toast.error(t("profile.importFailed"), { description: error?.message });
    }
  };

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
      timestamp: getTimestampMs() + Math.random() * 1000,
      command: "remove_config",
      payload: {
        id: tab.id,
      },
    });
  };

  // Close the context menu.
  React.useEffect(() => {
    window.addEventListener("click", hideCtxMenu);
    // window.addEventListener('contextmenu', hide);
    return () => {
      window.removeEventListener("click", hideCtxMenu);
      window.removeEventListener("contextmenu", hideCtxMenu);
    };
  }, []);

  const statusStore = useBackendStore((e) => e.statusStore);

  return (
    <header className="h-16 shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 flex items-center px-3">
      {/* Left side: scroll controls */}
      <div className="flex items-center gap-1 mr-2">
        <button
          className={`p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 ${!canScroll.left ? "opacity-40 pointer-events-none" : ""}`}
          onClick={() => scrollBy(-200)}
          aria-label="scroll-left"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <button
          className={`p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 ${!canScroll.right ? "opacity-40 pointer-events-none" : ""}`}
          onClick={() => scrollBy(200)}
          aria-label="scroll-right"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      <div ref={stripRef} className={`flex-1 overflow-x-auto ${noScrollbarStyle}`}>
        <Reorder.Group
          axis="x"
          values={tabs}
          onReorder={onReorder}
          className="flex items-stretch h-10 gap-1"
        >
          {tabs.map((tab) => {
            const active = activeProfile?.id === tab.id;
            return statusStore[tab.id] ? (
              <Reorder.Item
                id={`tab-${tab.id}`}
                key={tab.id}
                value={tab}
                layout={lowPerformanceMode ? undefined : true}
                transition={{ duration: lowPerformanceMode ? 0 : 0.18 }}
                className={`group relative flex items-center max-w-xs shrink-0 rounded-lg px-3 h-10 select-none
                    border cursor-pointer transition-colors
                    ${
                      active
                        ? "bg-slate-100 dark:bg-slate-700 border-slate-400 dark:border-slate-500"
                        : "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700"
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
                  setCtxMenu({ x: e.clientX, y: e.clientY, tab });
                }}
              >
                {statusStore[tab.id].running ? (
                  <Loader2 className="animate-spin mr-2 h-4 w-4" />
                ) : (
                  <></>
                )}

                {/* Profile name */}
                <span className="truncate pr-5">{tab.name}</span>

                {/* Close button, shown on hover. */}
                <button
                  title={t("common.delete")}
                  className="absolute right-1 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200/70 dark:hover:bg-slate-700/70 transition"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(tab);
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </Reorder.Item>
            ) : (
              <div key={tab.id}></div>
            );
          })}
        </Reorder.Group>
      </div>

      {/* Right side: create button */}
      <div className="ml-3">
        <button
          onClick={() => setEditor({ mode: "create" })}
          className="hidden sm:flex items-center px-3 h-9 rounded-lg bg-primary-600 text-white hover:bg-primary-700 transition-colors"
        >
          <FilePlus2 className="w-4 h-4 mr-2" />
          {t("profile.add")}
        </button>
        <button
          onClick={() => setEditor({ mode: "create" })}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600 p-0 text-white transition-colors hover:bg-primary-700 sm:hidden"
          aria-label={t("profile.add")}
        >
          <FilePlus2 className="block h-5 w-5 shrink-0" />
        </button>
      </div>

      {/* Context menu */}
      <AnimatePresence>
        {ctxMenu && ctxMenu.tab && (
          <motion.div
            initial={lowPerformanceMode ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={lowPerformanceMode ? undefined : { opacity: 0, scale: 0.96 }}
            transition={{ type: "tween", duration: lowPerformanceMode ? 0 : 0.12 }}
            className="fixed z-50 min-w-40 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg py-1"
            style={{ top: ctxMenu.y + 2, left: ctxMenu.x + 2 }}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700"
              onClick={() => {
                setEditor({ mode: "edit", tab: ctxMenu.tab! });
                setCtxMenu(null);
              }}
            >
              <Pencil className="w-4 h-4" /> {t("common.edit")}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700"
              onClick={() => {
                void handleCopy(ctxMenu.tab!);
                setCtxMenu(null);
              }}
            >
              <Copy className="w-4 h-4" /> {t("profile.copy")}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700"
              onClick={() => {
                void handleExport(ctxMenu.tab!);
                setCtxMenu(null);
              }}
            >
              <Download className="w-4 h-4" /> {t("profile.export")}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
              onClick={() => {
                setConfirmDelete(ctxMenu.tab!);
                setCtxMenu(null);
              }}
            >
              <Trash2 className="w-4 h-4" /> {t("common.delete")}
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
    </header>
  );
};

export default Header;

const overlayCls =
  "fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50";

/** Renders the profile editor modal component. */
const ProfileEditorModal = (props: {
  open: boolean;
  mode: "create" | "edit";
  initial: ProfileDTO | null;
  onClose: () => void;
  onSubmit: (vals: { name: string; server: string }) => Promise<void>;
  onImport: () => Promise<void>;
  checkName: (name: string, selfId?: string) => boolean;
}) => {
  const { t } = useTranslation();
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;
  const [name, setName] = React.useState(props.initial?.name ?? "");
  const [server, setServer] = React.useState("CN");
  const [err, setErr] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [importing, setImporting] = React.useState(false);

  React.useEffect(() => {
    if (props.open) {
      setName(props.initial?.name ?? "");
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
      className={overlayCls}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <motion.div
        initial={lowPerformanceMode ? false : { opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={lowPerformanceMode ? undefined : { opacity: 0, y: 12, scale: 0.98 }}
        transition={{ duration: lowPerformanceMode ? 0 : 0.18, type: "tween", ease: "easeOut" }}
        className="w-105 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold mb-4">
          {props.mode === "create" ? t("profile.create") : t("profile.edit")}
        </div>

        <div className="space-y-4">
          {props.mode === "create" && (
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || submitting}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60"
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

          {err && <div className="text-red-600 text-sm">{err}</div>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={props.onClose}
            className="px-3 py-2 rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
            disabled={submitting}
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            className="px-3 py-2 rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-60 flex items-center"
            disabled={submitting}
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
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;
  if (!props.open) return null;
  return (
    <div
      className={overlayCls}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <motion.div
        initial={lowPerformanceMode ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={lowPerformanceMode ? undefined : { opacity: 0, y: 8 }}
        transition={{ duration: lowPerformanceMode ? 0 : 0.16 }}
        className="w-105 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-1 rounded-full bg-red-100 dark:bg-red-900/40 text-red-600 p-2">
            <Trash2 className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <div className="text-lg font-semibold">{t("profile.deleteConfirmTitle")}</div>
            <div className="text-sm text-slate-600 dark:text-slate-300 mt-1">
              {t("profile.deleteConfirmMessage", { name: props.name })}
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={props.onCancel}
            className="px-3 py-2 rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={props.onConfirm}
            disabled={props.disabled}
            className="px-3 py-2 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
          >
            {t("common.delete")}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
