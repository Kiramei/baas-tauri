import { useEffect, useState } from "react";
import { toast } from "sonner";
import TitlebarMenu, { type TitlebarMenuControl, type TitlebarMenuEntry } from "./TitlebarMenu";
import { useHelpMenuEntries } from "./HelpMenu";
import CollapsedTitlebarMenu from "./CollapsedTitlebarMenu";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useProfileActions } from "@/context/ProfileActionsProvider";
import { useNavigationHistory } from "@/context/NavigationHistoryProvider";
import { useEditActions } from "@/shared/useEditActions";
import type { EditAction } from "@/shared/EditActions";
import { useConfigurationHistoryActions } from "@/shared/useConfigurationHistoryActions";
import { useConfigurationWorkspace } from "@/shared/useConfigurationWorkspace";
import { useViewActions } from "@/shared/useViewActions";
import { invoke } from "@/shared/TauriInvoke";
import { useWindowLayout } from "@/context/WindowLayoutProvider";
import StorageUtil from "@/shared/StorageManager";
import type { HotkeyConfig } from "@/components/HotkeyConfig";
import { titlebarShortcutLabels } from "@/shared/SettingsShortcut";
import { useApplicationShortcuts } from "@/shared/useApplicationShortcuts";
import {
  applicationShortcutMatches,
  normalizeApplicationShortcut,
} from "@/shared/ApplicationShortcuts";

const menuIds = ["file", "edit", "view", "help"] as const;
type MenuId = (typeof menuIds)[number];

/** Every item invokes the existing application flow or a supported platform action. */
export default function TitlebarMenus() {
  const { t } = useAppTranslation();
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [collapsedOpen, setCollapsedOpen] = useState(false);
  const [menuLayout, setMenuLayout] = useState(() =>
    window.innerWidth < 480 ? "drilldown" : window.innerWidth < 640 ? "submenus" : "wide"
  );
  const profiles = useProfileActions();
  const navigation = useNavigationHistory();
  const configurationProfile =
    navigation.current?.page === "configuration" ? navigation.current.profileId : undefined;
  const configurationHistory = useConfigurationHistoryActions(configurationProfile);
  const configuration = useConfigurationWorkspace(configurationProfile);
  const [configurationEdit, setConfigurationEdit] = useState(false);
  const layout = useWindowLayout();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const applicationShortcuts = useApplicationShortcuts();
  const shortcuts = {
    ...titlebarShortcutLabels(mac),
    ...applicationShortcuts.bindings,
    back: applicationShortcuts.shortcutLabel("back"),
    forward: applicationShortcuts.shortcutLabel("forward"),
  };
  const nativeEditShortcuts = titlebarShortcutLabels(mac);
  const edit = useEditActions();
  const view = useViewActions();
  const helpEntries = useHelpMenuEntries();
  const [availability, setAvailability] = useState(() => edit.getAvailability());
  const captureEditTarget = () => {
    const active = document.activeElement;
    setConfigurationEdit(
      Boolean(
        configurationProfile &&
        !document.querySelector("[aria-modal='true'],[role='dialog'],[role='alertdialog']") &&
        (!(active instanceof Element) ||
          !active.closest("input,textarea,select,[contenteditable='true']") ||
          active.closest(".configuration-editor"))
      )
    );
    edit.captureTarget();
  };
  useEffect(() => {
    const onResize = () => {
      setOpenMenu(null);
      setCollapsedOpen(false);
      setMenuLayout(
        window.innerWidth < 480 ? "drilldown" : window.innerWidth < 640 ? "submenus" : "wide"
      );
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        __WITH_ANDROID__ ||
        !layout.available ||
        !navigation.available ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        !applicationShortcutMatches(event, "settings", applicationShortcuts.bindings, mac)
      )
        return;
      let bindings: HotkeyConfig[];
      try {
        const saved = StorageUtil.get<HotkeyConfig[]>("hotkeys");
        bindings = Array.isArray(saved) ? saved : [];
      } catch {
        return;
      }
      if (
        document.querySelector("[aria-modal='true'], [role='dialog'], [role='alertdialog']") ||
        bindings.some(
          (binding) =>
            binding.enabled !== false &&
            binding.value &&
            normalizeApplicationShortcut(binding.value, mac) ===
              normalizeApplicationShortcut(applicationShortcuts.bindings.settings, mac)
        )
      )
        return;
      event.preventDefault();
      setOpenMenu(null);
      setCollapsedOpen(false);
      navigation.openSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    applicationShortcuts.bindings,
    layout.available,
    mac,
    navigation.available,
    navigation.openSettings,
  ]);
  const setMenu = (id: MenuId, open: boolean) => {
    if (open && id === "edit") setAvailability(edit.getAvailability());
    setOpenMenu((current) => (open ? id : current === id ? null : current));
  };
  const controls = (id: MenuId): TitlebarMenuControl => ({
    open: openMenu === id,
    onOpenChange: (open) => setMenu(id, open),
    onAdjacent: (direction) => {
      const index = (menuIds.indexOf(id) + direction + menuIds.length) % menuIds.length;
      const next = menuIds[index];
      if (next === "edit") captureEditTarget();
      setMenu(next, true);
    },
    onPointerEnter: () => {
      if (!openMenu || openMenu === id) return;
      if (id === "edit") captureEditTarget();
      setMenu(id, true);
    },
  });
  const performEdit = (action: EditAction) => {
    if (configurationEdit && configurationProfile && (action === "undo" || action === "redo")) {
      const section = configurationHistory[action]();
      if (section) configuration.select(section);
      return;
    }
    void edit
      .execute(action)
      .then((result) => {
        if (result.status === "failed") toast.error(t("edit.actionFailed"));
        if (result.status === "unavailable") toast.info(t("edit.unavailable"));
      })
      .catch((error: unknown) => {
        console.error("[edit] menu action failed:", error);
        toast.error(t("edit.actionFailed"));
      });
  };
  const fileEntries: TitlebarMenuEntry[] = [
    {
      id: "new",
      label: t("profile.create"),
      disabled: !profiles,
      onSelect: () => profiles?.create(),
    },
    {
      id: "import",
      label: t("profile.import"),
      disabled: !profiles,
      onSelect: () => {
        void profiles?.import();
      },
    },
  ];
  if (__WITH_TAURI__) {
    fileEntries.push(
      { id: "file-separator", separator: true },
      {
        id: "config-folder",
        label: t("file.openConfigFolder"),
        disabled: __WITH_ANDROID__,
        onSelect: () => {
          void invoke("open_backend_config_folder").catch((error: unknown) => {
            console.error("[file] failed to open config folder:", error);
            toast.error(t("file.openConfigFolderFailed"));
          });
        },
      }
    );
  }
  const editEntries: TitlebarMenuEntry[] = [
    {
      id: "undo",
      label: t("edit.undo"),
      shortcut:
        configurationEdit && configurationProfile ? shortcuts.undo : nativeEditShortcuts.undo,
      disabled: !(configurationEdit && configurationProfile
        ? configurationHistory.canUndo
        : availability.undo),
      onSelect: () => performEdit("undo"),
    },
    {
      id: "redo",
      label: t("edit.redo"),
      shortcut:
        configurationEdit && configurationProfile ? shortcuts.redo : nativeEditShortcuts.redo,
      disabled: !(configurationEdit && configurationProfile
        ? configurationHistory.canRedo
        : availability.redo),
      onSelect: () => performEdit("redo"),
    },
    { id: "history-separator", separator: true },
    {
      id: "cut",
      label: t("edit.cut"),
      shortcut: shortcuts.cut,
      disabled: !availability.cut,
      onSelect: () => performEdit("cut"),
    },
    {
      id: "copy",
      label: t("contextMenu.copy"),
      shortcut: shortcuts.copy,
      disabled: !availability.copy,
      onSelect: () => performEdit("copy"),
    },
    {
      id: "paste",
      label: t("contextMenu.paste"),
      shortcut: shortcuts.paste,
      disabled: !availability.paste,
      onSelect: () => performEdit("paste"),
    },
    {
      id: "delete",
      label: t("common.delete"),
      shortcut: shortcuts.delete,
      disabled: !availability.delete,
      onSelect: () => performEdit("delete"),
    },
    { id: "selection-separator", separator: true },
    {
      id: "select-all",
      label: t("edit.selectAll"),
      shortcut: shortcuts.selectAll,
      disabled: !availability.selectAll,
      onSelect: () => performEdit("selectAll"),
    },
    { id: "settings-separator", separator: true },
    {
      id: "settings",
      label: t("nav.settings"),
      shortcut: shortcuts.settings,
      disabled: !layout.available || !navigation.available,
      onSelect: () => {
        navigation.openSettings();
      },
    },
  ];
  const viewEntries: TitlebarMenuEntry[] = [
    {
      id: "sidebar",
      label: t("view.sidebar"),
      shortcut: shortcuts.sidebar,
      checked: view.sidebarExpanded,
      disabled: !view.canToggleSidebar,
      onSelect: view.toggleSidebar,
    },
    { id: "sidebar-separator", separator: true },
    {
      id: "back",
      label: t("app.back"),
      shortcut: shortcuts.back,
      disabled: !view.canBack,
      onSelect: view.back,
    },
    {
      id: "forward",
      label: t("app.forward"),
      shortcut: shortcuts.forward,
      disabled: !view.canForward,
      onSelect: view.forward,
    },
    { id: "navigation-separator", separator: true },
    {
      id: "zoom-in",
      label: t("view.zoomIn"),
      shortcut: shortcuts.zoomIn,
      disabled: !view.canZoomIn,
      onSelect: view.zoomIn,
    },
    {
      id: "zoom-out",
      label: t("view.zoomOut"),
      shortcut: shortcuts.zoomOut,
      disabled: !view.canZoomOut,
      onSelect: view.zoomOut,
    },
    {
      id: "reset-zoom",
      label: `${t("view.resetZoom")} (100%)`,
      shortcut: shortcuts.resetZoom,
      disabled: view.zoomScale === 100,
      onSelect: view.resetZoom,
    },
    { id: "zoom-separator", separator: true },
    {
      id: "fullscreen",
      label: t("view.fullscreen"),
      shortcut: shortcuts.fullscreen,
      checked: view.fullscreen,
      disabled: !view.canFullscreen || view.fullscreenBusy,
      onSelect: view.toggleFullscreen,
    },
  ];

  return (
    <div role="menubar" aria-label={t("menu.bar")} className="flex h-8 items-center gap-0.5">
      {menuLayout !== "wide" ? (
        <CollapsedTitlebarMenu
          groups={[
            { id: "file", label: t("menu.file"), entries: fileEntries },
            { id: "edit", label: t("menu.edit"), entries: editEntries },
            { id: "view", label: t("menu.view"), entries: viewEntries },
            { id: "help", label: t("help.title"), entries: helpEntries },
          ]}
          open={collapsedOpen}
          onOpenChange={setCollapsedOpen}
          onCapture={() => {
            captureEditTarget();
            setAvailability(edit.getAvailability());
          }}
          onCategoryOpen={(id) => {
            if (id === "edit") setAvailability(edit.getAvailability());
          }}
          drilldown={menuLayout === "drilldown"}
        />
      ) : (
        <>
          <TitlebarMenu label={t("menu.file")} entries={fileEntries} {...controls("file")} />
          <TitlebarMenu
            label={t("menu.edit")}
            entries={editEntries}
            onCapture={captureEditTarget}
            {...controls("edit")}
          />
          <TitlebarMenu label={t("menu.view")} entries={viewEntries} {...controls("view")} />
          <TitlebarMenu label={t("help.title")} entries={helpEntries} {...controls("help")} />
        </>
      )}
    </div>
  );
}
