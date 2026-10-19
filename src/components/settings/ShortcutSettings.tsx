import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import HotkeyField, { HotkeySettingsModal } from "@/components/HotkeyConfig";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsControls";
import { useTauriShortcuts } from "@/context/TauriShortcutProvider";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useApplicationShortcuts } from "@/shared/useApplicationShortcuts";
import {
  APPLICATION_SHORTCUTS,
  formatApplicationShortcutLabel,
  normalizeApplicationShortcut,
  type ApplicationShortcutId,
} from "@/shared/ApplicationShortcuts";
import { titlebarShortcutLabels } from "@/shared/SettingsShortcut";
import { i18nKey } from "@/shared/I18nKeys";

interface BindingRowProps {
  id: ApplicationShortcutId;
  label: string;
  description: string;
  value: string;
  error?: string;
  inactive: boolean;
  onChange: (id: ApplicationShortcutId, value: string) => void;
  onRecordingChange: (id: ApplicationShortcutId, recording: boolean) => void;
}
function BindingRow({
  id,
  label,
  description,
  value,
  error,
  inactive,
  onChange,
  onRecordingChange,
}: BindingRowProps) {
  const recordingChanged = useCallback(
    (recording: boolean) => onRecordingChange(id, recording),
    [id, onRecordingChange]
  );
  return (
    <SettingsRow
      label={label}
      description={description}
      className={`settings-shortcut-row${inactive ? " settings-shortcut-row-inactive" : ""}`}
    >
      <div role="group" aria-label={label} aria-disabled={inactive || undefined}>
        <HotkeyField
          className="settings-shortcut-field"
          value={value}
          onChange={(next) => onChange(id, next)}
          onRecordingChange={recordingChanged}
          error={error}
        />
      </div>
    </SettingsRow>
  );
}

/** Keyboard bindings share the regular settings cards and persist after valid recording. */
export function ShortcutSettings() {
  const { t } = useAppTranslation();
  const { bindings, defaults, setBinding, resetAll, bindingConflict } = useApplicationShortcuts();
  const { hotkeys, saveHotkeys, setShortcutsSuspended } = useTauriShortcuts();
  const [recordingId, setRecordingId] = useState<ApplicationShortcutId | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ApplicationShortcutId, string>>>({});
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const native = titlebarShortcutLabels(mac);
  const recordingChanged = useCallback(
    (id: ApplicationShortcutId, recording: boolean) => {
      setRecordingId((current) => (recording ? id : current === id ? null : current));
      setShortcutsSuspended(recording);
    },
    [setShortcutsSuspended]
  );
  useEffect(() => () => setShortcutsSuspended(false), [setShortcutsSuspended]);
  const updateBinding = (id: ApplicationShortcutId, value: string) => {
    const normalized = normalizeApplicationShortcut(value, mac);
    const conflict = normalized === null ? null : bindingConflict(id, normalized);
    const globalConflict = normalized
      ? hotkeys.find(
          (item) =>
            item.enabled !== false && normalizeApplicationShortcut(item.value, mac) === normalized
        )
      : undefined;
    const nativeConflict = normalized
      ? [
          { label: t("edit.cut"), value: native.cut },
          { label: t("contextMenu.copy"), value: native.copy },
          { label: t("contextMenu.paste"), value: native.paste },
          { label: t("edit.selectAll"), value: native.selectAll },
          { label: t("common.delete"), value: native.delete },
          { label: t("common.cancel"), value: "Escape" },
        ].find((item) => normalizeApplicationShortcut(item.value, mac) === normalized)
      : undefined;
    const conflictLabel = conflict
      ? APPLICATION_SHORTCUTS.find((item) => item.id === conflict)?.label
      : undefined;
    const error =
      normalized === null
        ? t("hotkey.invalidFormat")
        : nativeConflict
          ? t("settings.shortcuts.conflict", { shortcut: nativeConflict.label })
          : globalConflict
            ? t("settings.shortcuts.conflict", { shortcut: globalConflict.label })
            : conflictLabel
              ? t("settings.shortcuts.conflict", { shortcut: t(i18nKey(conflictLabel)) })
              : undefined;
    if (error) {
      setErrors((current) => ({ ...current, [id]: error }));
      return;
    }
    setBinding(id, normalized!);
    setErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };
  const nativeRows = [
    { id: "cut", label: t("edit.cut"), value: native.cut },
    { id: "copy", label: t("contextMenu.copy"), value: native.copy },
    { id: "paste", label: t("contextMenu.paste"), value: native.paste },
    { id: "selectAll", label: t("edit.selectAll"), value: native.selectAll },
    { id: "delete", label: t("common.delete"), value: native.delete },
  ];
  const resetBindings = () => {
    const defaultValues = Object.values(defaults).map((value) =>
      normalizeApplicationShortcut(value, mac)
    );
    const conflict = hotkeys.find(
      (item) =>
        item.enabled !== false &&
        item.value &&
        defaultValues.includes(normalizeApplicationShortcut(item.value, mac))
    );
    if (conflict) {
      toast.error(t("settings.shortcuts.conflict", { shortcut: conflict.label }));
      return;
    }
    resetAll();
    setErrors({});
  };
  return (
    <div className="settings-sections">
      <SettingsGroup title={t("settings.shortcuts.application")}>
        <div className="settings-block">
          <p className="settings-description">{t("settings.shortcuts.instructions")}</p>
        </div>
        {APPLICATION_SHORTCUTS.map((item) => (
          <BindingRow
            key={item.id}
            id={item.id}
            label={t(i18nKey(item.label))}
            description={`${t(i18nKey(item.description))} ${t("settings.shortcuts.defaultBinding", { binding: formatApplicationShortcutLabel(defaults[item.id], mac) || t("settings.shortcuts.disabled") })}`}
            value={formatApplicationShortcutLabel(bindings[item.id], mac)}
            error={errors[item.id]}
            inactive={recordingId !== null && recordingId !== item.id}
            onChange={updateBinding}
            onRecordingChange={recordingChanged}
          />
        ))}
        <SettingsRow
          label={t("settings.shortcuts.resetAll")}
          description={t("settings.shortcuts.resetDescription")}
        >
          <button
            type="button"
            className="settings-shortcut-action"
            disabled={recordingId !== null}
            onClick={resetBindings}
          >
            {t("settings.shortcuts.resetButton")}
          </button>
        </SettingsRow>
      </SettingsGroup>
      {__WITH_TAURI__ && !__WITH_ANDROID__ && (
        <SettingsGroup title={t("settings.shortcuts.global")}>
          <SettingsRow
            label={t("settings.shortcuts.profileRun")}
            description={t("settings.shortcuts.globalDescription")}
          >
            <button
              type="button"
              className="settings-shortcut-action"
              disabled={!hotkeys.length || recordingId !== null}
              onClick={() => setProfileModalOpen(true)}
            >
              {t("common.edit")}
            </button>
          </SettingsRow>
          {hotkeys.map((item) => (
            <SettingsRow
              key={item.id}
              label={item.label}
              description={t("settings.shortcuts.profileDescription")}
            >
              <kbd className="settings-shortcut-key">
                {item.enabled !== false && item.value
                  ? item.value
                  : t("settings.shortcuts.disabled")}
              </kbd>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}
      <SettingsGroup title={t("settings.shortcuts.native")}>
        <div className="settings-block">
          <p className="settings-description">{t("settings.shortcuts.nativeDescription")}</p>
        </div>
        {nativeRows.map((item) => (
          <SettingsRow
            key={item.id}
            label={item.label}
            description={t("settings.shortcuts.nativeTextDescription")}
          >
            <kbd className="settings-shortcut-key">{item.value}</kbd>
          </SettingsRow>
        ))}
        <SettingsRow
          label={t("common.cancel")}
          description={t("settings.shortcuts.escapeDescription")}
        >
          <kbd className="settings-shortcut-key">Esc</kbd>
        </SettingsRow>
      </SettingsGroup>
      {__WITH_TAURI__ && !__WITH_ANDROID__ && (
        <HotkeySettingsModal
          isOpen={profileModalOpen}
          value={hotkeys}
          onRecordingChange={setShortcutsSuspended}
          onClose={async (save, draft) => {
            setShortcutsSuspended(false);
            if (!save) {
              setProfileModalOpen(false);
              return;
            }
            const next = draft ?? hotkeys;
            for (const item of next) {
              const normalized = normalizeApplicationShortcut(item.value, mac);
              if (!normalized || item.enabled === false) continue;
              const conflict = APPLICATION_SHORTCUTS.find(
                (shortcut) =>
                  normalizeApplicationShortcut(bindings[shortcut.id], mac) === normalized
              );
              if (conflict) {
                toast.error(
                  t("settings.shortcuts.conflict", { shortcut: t(i18nKey(conflict.label)) })
                );
                return;
              }
            }
            try {
              const report = await saveHotkeys(next);
              if (report.rejected.length) {
                toast.error(t("hotkey.fixInvalid"), {
                  description: report.rejected
                    .map((item) => `${item.accelerator}: ${item.reason}`)
                    .join("; "),
                });
                return;
              }
              setProfileModalOpen(false);
            } catch (error) {
              toast.error(t("hotkey.fixInvalid"), {
                description: error instanceof Error ? error.message : String(error),
              });
            }
          }}
        />
      )}
    </div>
  );
}
