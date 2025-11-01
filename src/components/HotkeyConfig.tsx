import {useTranslation} from "react-i18next";
import React, {useEffect, useMemo, useState} from "react";
import {Modal} from "@/components/ui/Modal.tsx";
import CButton from "@/components/ui/CButton.tsx";
import HotkeyField from "@/components/utils/HotkeyField.tsx";

type HotkeyConfig = { id: string; label: string; value: string };

// 小工具：快捷键格式简校验（允许空；或者像 "Ctrl+Shift+K"、"Alt+S"、"F5" 等）
const isHotkeyValid = (v: string) => {
  if (!v.trim()) return true; // 允许留空，表示未绑定

  // 修饰键
  const modifier = '(ctrl|alt|shift|meta|cmd|command|option|opt|super|win)';

  // 特殊命名键
  const special = '(enter|tab|escape|space|arrow(up|down|left|right)|f[1-9]|f1[0-9]|f2[0-4])';

  // 主键：字母、数字或常见符号
  const main = '([a-z0-9]|[~`!@#$%^&*()_\\-+={}\\[\\]\\\\|;:\'",<.>/?])';

  // 组合规则：至少一个 main 或 special，前后可带修饰键
  const hotkeyRegex = new RegExp(
    `^(${modifier}\\+)*(${special}|${main})(\\+${modifier})*$`,
    'i'
  );

  return hotkeyRegex.test(v.trim());
};


// ========== 快捷键设置模态框 ========== //
const HotkeySettingsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  value: HotkeyConfig[];
  onChange: (next: HotkeyConfig[]) => void;
}> = ({isOpen, onClose, value, onChange}) => {
  const {t} = useTranslation();
  const [draft, setDraft] = useState<HotkeyConfig[]>(value);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setDraft(value);
    setErrors({});
  }, [value, isOpen]);

  // 检测重复
  const duplicates = useMemo(() => {
    const map = new Map<string, string[]>();
    draft.forEach(k => {
      const v = k.value.trim().toLowerCase();
      if (!v) return;
      map.set(v, [...(map.get(v) || []), k.id]);
    });
    const dups: Record<string, true> = {};
    map.forEach(ids => {
      if (ids.length > 1) ids.forEach(id => dups[id] = true);
    });
    return dups;
  }, [draft]);

  const handleInput = (id: string, v: string) => {
    setDraft(prev => prev.map(it => it.id === id ? {...it, value: v} : it));
    setErrors(prev => {
      const next = {...prev};
      if (!isHotkeyValid(v)) next[id] = t('Invalid hotkey format') as string;
      else delete next[id];
      return next;
    });
  };

  const handleSave = () => {
    // 最终校验：格式 + 重复
    const bad: Record<string, string> = {};
    draft.forEach(k => {
      if (!isHotkeyValid(k.value)) bad[k.id] = t('Invalid hotkey format') as string;
    });
    if (Object.keys(bad).length) {
      setErrors(bad);
      return;
    }
    if (Object.keys(duplicates).length) {
      // 给重复项标红
      const dupErr: Record<string, string> = {};
      Object.keys(duplicates).forEach(id => dupErr[id] = t('Duplicated hotkey') as string);
      setErrors(dupErr);
      return;
    }
    onChange(draft);
    onClose();
  };

  const [search, setSearch] = useState("");

  const filteredDraft = draft.filter(cfg => {
    const q = search.toLowerCase();
    return cfg.label.toLowerCase().includes(q) || cfg.value.toLowerCase().includes(q);
  });


  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('hotkeys')}>
      <div className="space-y-6">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('Use combinations like')} <code
          className="px-1 py-0.5 bg-slate-200/70 dark:bg-slate-700/60 rounded">Ctrl+Shift+K</code>, <code
          className="px-1 py-0.5 bg-slate-200/70 dark:bg-slate-700/60 rounded">Alt+S</code>, <code
          className="px-1 py-0.5 bg-slate-200/70 dark:bg-slate-700/60 rounded">F5</code>. {t('Leave empty to unbind')}.
        </p>

        <div className="mb-2 p-1">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('Search hotkeys')}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600
                   px-3 py-2 text-sm bg-white dark:bg-slate-900
                   text-slate-900 dark:text-slate-100
                   focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>

        <div className="grid grid-cols-1 gap-2 h-64 max-h-64 overflow-y-auto mt-4 p-2 scroll-embedded">
          {filteredDraft.map(cfg => {
            const hasDup = !!duplicates[cfg.id];
            const err = errors[cfg.id];
            return (
              <HotkeyField
                key={cfg.id}
                label={cfg.label}
                value={cfg.value}
                onChange={(v) => {
                  setDraft(prev => prev.map(it => it.id === cfg.id ? {...it, value: v} : it));
                  setErrors(prev => {
                    const next = {...prev};
                    if (!isHotkeyValid(v)) next[cfg.id] = t('Invalid hotkey format') as string;
                    else delete next[cfg.id];
                    return next;
                  });
                }}
                error={err || (hasDup ? t('Duplicated hotkey') as string : "")}
                className="mb-3"
              />
            );
          })}
        </div>

        {/* 错误提示（若有） */}
        {(Object.keys(errors).length > 0) && (
          <div className="text-sm text-red-500">
            {t('Please fix invalid or duplicated hotkeys.')}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <CButton variant="secondary" onClick={onClose}>{t('cancel')}</CButton>
          <CButton variant="primary" onClick={handleSave}>{t('save')}</CButton>
        </div>
      </div>
    </Modal>
  );
};

export {
  type HotkeyConfig,
  HotkeySettingsModal
};
