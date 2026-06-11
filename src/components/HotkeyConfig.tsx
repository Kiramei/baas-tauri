import React, { useMemo } from "react";
import { Modal } from "@/components/ui/Modal.tsx";
import CButton from "@/components/ui/CButton.tsx";
import { useEffect, useState } from "react";
import { Keyboard as KeyboardIcon, Circle as RecIcon, X as XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface HotkeyFieldProps {
  label?: string;
  value: string; // Current hotkey value (e.g. Ctrl+Shift+K)
  onChange: (next: string) => void; // Callback invoked when recording completes
  error?: string;
  className?: string;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

function normalizeCombo(e: KeyboardEvent): string | null {
  // Require at least one non-modifier key; modifier-only presses are ignored.
  const { key, ctrlKey, shiftKey, altKey, metaKey } = e;

  // Normalise the main key representation.
  let main = key;

  // Skip pure modifier keys.
  if (["Shift", "Control", "Alt", "Meta"].includes(main)) return null;

  // Standardise casing for readability while keeping special keys intact.
  if (main.length === 1) main = main.toUpperCase();
  if (main === " ") main = "Space";

  const parts: string[] = [];
  if (isMac) {
    if (metaKey) parts.push("Cmd");
    if (altKey) parts.push("Option");
    if (ctrlKey) parts.push("Ctrl"); // Some Mac configurations still use Ctrl
  } else {
    if (ctrlKey) parts.push("Ctrl");
    if (altKey) parts.push("Alt");
    if (metaKey) parts.push("Meta"); // Windows key
  }
  if (shiftKey) parts.push("Shift");

  parts.push(main);
  return parts.join("+");
}

export default function HotkeyField({
  label,
  value,
  onChange,
  error,
  className = "",
}: HotkeyFieldProps) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");
  const { t } = useTranslation();
  const placeholder = t("placeholder.nobinding");

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Prevent the host page from executing its default shortcut handlers.
      e.preventDefault();

      // Allow escape to cancel the recording session.
      if (e.key === "Escape") {
        setRecording(false);
        setHint("");
        return;
      }

      const combo = normalizeCombo(e);
      if (!combo) {
        setHint(isMac ? "Press a main key…" : "Press a non-modifier key…");
        return;
      }

      onChange(combo);
      setRecording(false);
      setHint("");
    };

    // Surface contextual hints while recording.
    setHint(isMac ? "Press the key combination, Esc to cancel" : "Press keys, Esc to cancel");

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording, onChange]);

  const borderClass = error
    ? "border-red-400 focus-within:border-red-400"
    : recording
      ? "border-primary-500 ring-2 ring-primary-500/20"
      : "border-transparent focus-within:border-primary-500";

  return (
    <div className={`w-full ${className}`}>
      {label && (
        <label className="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">
          {label}
        </label>
      )}

      <div
        className={`relative flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100
                       border transition border-2 ${borderClass}`}
      >
        {/* Read-only display slot */}
        <input
          type={"text"}
          readOnly
          value={recording ? hint : value}
          placeholder={placeholder}
          className={`flex-1 bg-transparent rounded-lg px-3 py-2 outline-none dark:bg-slate-900
                     ${recording ? "italic text-slate-500 dark:text-slate-400" : ""}`}
        />

        {/* Clear button – visible only when a value is present. */}
        {value && !recording && (
          <button
            type="button"
            className="absolute right-9 p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            onClick={() => onChange("")}
            title="Clear"
            aria-label="Clear"
          >
            <XIcon className="w-4 h-4" />
          </button>
        )}

        {/* Toggle recording state. */}
        <button
          type="button"
          onClick={() => setRecording((r) => !r)}
          className={`absolute right-1.5 my-0.5 px-2 py-1 rounded-md transition
                     ${
                       recording
                         ? "bg-primary-600 text-white hover:bg-primary-700"
                         : "text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
                     }`}
          title={recording ? "Stop recording" : "Record hotkey"}
          aria-pressed={recording}
        >
          {recording ? (
            <span className="flex items-center gap-1">
              <RecIcon className="w-3.5 h-3.5" />
              <span className="text-xs">REC</span>
            </span>
          ) : (
            <KeyboardIcon className="w-4 h-4" />
          )}
        </button>
      </div>

      {error && <p className="mt-1 text-sm text-red-500">{error}</p>}
    </div>
  );
}

type HotkeyConfig = { id: string; label: string; value: string };

// 小工具：快捷键格式简校验（允许空；或者像 "Ctrl+Shift+K"、"Alt+S"、"F5" 等）
const isHotkeyValid = (v: string) => {
  if (!v.trim()) return true; // 允许留空，表示未绑定

  // 修饰键
  const modifier = "(ctrl|alt|shift|meta|cmd|command|option|opt|super|win)";

  // 特殊命名键
  const special = "(enter|tab|escape|space|arrow(up|down|left|right)|f[1-9]|f1[0-9]|f2[0-4])";

  // 主键：字母、数字或常见符号
  const main = "([a-z0-9]|[~`!@#$%^&*()_\\-+={}\\[\\]\\\\|;:'\",<.>/?])";

  // 组合规则：至少一个 main 或 special，前后可带修饰键
  const hotkeyRegex = new RegExp(`^(${modifier}\\+)*(${special}|${main})(\\+${modifier})*$`, "i");

  return hotkeyRegex.test(v.trim());
};

// ========== 快捷键设置模态框 ========== //
const HotkeySettingsModal: React.FC<{
  isOpen: boolean;
  onClose: (toSave: boolean, draft?: HotkeyConfig[]) => void;
  value: HotkeyConfig[];
}> = ({ isOpen, onClose, value }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<HotkeyConfig[]>(value);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setDraft(value);
    setErrors({});
  }, [value, isOpen]);

  // 检测重复
  const duplicates = useMemo(() => {
    const map = new Map<string, string[]>();
    draft.forEach((k) => {
      const v = k.value.trim().toLowerCase();
      if (!v) return;
      map.set(v, [...(map.get(v) || []), k.id]);
    });
    const dups: Record<string, true> = {};
    map.forEach((ids) => {
      if (ids.length > 1) ids.forEach((id) => (dups[id] = true));
    });
    return dups;
  }, [draft]);

  const handleSave = () => {
    // 最终校验：格式 + 重复
    const bad: Record<string, string> = {};
    draft.forEach((k) => {
      if (!isHotkeyValid(k.value)) bad[k.id] = t("Invalid hotkey format") as string;
    });
    if (Object.keys(bad).length) {
      setErrors(bad);
      return;
    }
    if (Object.keys(duplicates).length) {
      // 给重复项标红
      const dupErr: Record<string, string> = {};
      Object.keys(duplicates).forEach((id) => (dupErr[id] = t("Duplicated hotkey") as string));
      setErrors(dupErr);
      return;
    }
    onClose(true, draft);
  };

  const [search, setSearch] = useState("");

  const filteredDraft = draft.filter((cfg) => {
    const q = search.toLowerCase();
    return cfg.label.toLowerCase().includes(q) || cfg.value.toLowerCase().includes(q);
  });

  return (
    <Modal isOpen={isOpen} onClose={() => onClose(false)} title={t("hotkeys")}>
      <div className="space-y-6">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t("Use combinations like")}{" "}
          <code className="px-1 py-0.5 bg-slate-200/70 dark:bg-slate-700/60 rounded">
            Ctrl+Shift+K
          </code>
          , <code className="px-1 py-0.5 bg-slate-200/70 dark:bg-slate-700/60 rounded">Alt+S</code>,{" "}
          <code className="px-1 py-0.5 bg-slate-200/70 dark:bg-slate-700/60 rounded">F5</code>.{" "}
          {t("Leave empty to unbind")}.
        </p>

        <div className="mb-2 p-1">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search hotkeys")}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600
                   px-3 py-2 text-sm bg-white dark:bg-slate-900
                   text-slate-900 dark:text-slate-100
                   focus:outline-none focus:ring-2 focus:ring-primary-500 transition"
          />
        </div>

        <div className="grid grid-cols-1 gap-2 h-64 max-h-64 overflow-y-auto mt-4 p-2 scroll-embedded">
          {filteredDraft.map((cfg) => {
            const hasDup = !!duplicates[cfg.id];
            const err = errors[cfg.id];
            return (
              <HotkeyField
                key={cfg.id}
                label={cfg.label}
                value={cfg.value}
                onChange={(v) => {
                  setDraft((prev) =>
                    prev.map((it) => (it.id === cfg.id ? { ...it, value: v } : it))
                  );
                  setErrors((prev) => {
                    const next = { ...prev };
                    if (!isHotkeyValid(v)) next[cfg.id] = t("Invalid hotkey format") as string;
                    else delete next[cfg.id];
                    return next;
                  });
                }}
                error={err || (hasDup ? (t("Duplicated hotkey") as string) : "")}
                className="mb-3"
              />
            );
          })}
        </div>

        {/* 错误提示（若有） */}
        {Object.keys(errors).length > 0 && (
          <div className="text-sm text-red-500">
            {t("Please fix invalid or duplicated hotkeys.")}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <CButton variant="secondary" onClick={() => onClose(false)}>
            {t("cancel")}
          </CButton>
          <CButton variant="primary" onClick={handleSave}>
            {t("save")}
          </CButton>
        </div>
      </div>
    </Modal>
  );
};

export { type HotkeyConfig, HotkeySettingsModal };
