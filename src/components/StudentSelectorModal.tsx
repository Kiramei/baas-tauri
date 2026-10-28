import React, { useDeferredValue, useState, useMemo } from "react";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SearchInput } from "@/components/ui/SearchInput";

type Student = {
  CN_name: string;
  Global_name: string;
  JP_name: string;
  CN_implementation: boolean;
  Global_implementation: boolean;
  JP_implementation: boolean;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  allStudents: Student[] | string[];
  selected: string[];
  onChange: (list: string[]) => void;
  lang?: string;
};

/** Renders the student selector modal component. */
const StudentSelectorModal: React.FC<Props> = ({
  isOpen,
  onClose,
  allStudents,
  selected,
  onChange,
  lang = "JP",
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const displayName = (s: Student) => {
    if (lang === "CN") return s.CN_name;
    if (lang === "Global") return s.Global_name;
    return s.JP_name;
  };

  // Search filter.
  const filtered = useMemo(() => {
    return allStudents.filter((s) => {
      if (typeof s === "string") return s.toLowerCase().includes(deferredQuery.toLowerCase());
      return displayName(s).toLowerCase().includes(deferredQuery.toLowerCase());
    });
  }, [deferredQuery, allStudents, lang]);

  const toggleStudent = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((n) => n !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-[1200]">
      <div data-modal-backdrop="" className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div
        data-modal-backdrop=""
        className="fixed inset-0 flex items-center justify-center p-4"
        style={{ paddingTop: "calc(var(--window-titlebar-height, 0px) + 1rem)" }}
      >
        <DialogPanel
          className="modal-surface w-full max-w-3xl overflow-y-auto overscroll-contain"
          style={{ maxHeight: "calc(100dvh - var(--window-titlebar-height, 0px) - 2rem)" }}
        >
          <div className="modal-header">
            <DialogTitle className="modal-title">{t("artifact.selectStudent")}</DialogTitle>
            <button onClick={onClose} aria-label={t("common.close")} className="modal-close">
              <X className="size-4" />
            </button>
          </div>

          <SearchInput
            placeholder={t("student.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            containerClassName="mb-4"
          />

          {/* Student list */}
          <div className="flex flex-wrap gap-2 max-h-96 overflow-y-auto">
            {filtered.map((s) => {
              const name = typeof s === "string" ? s : displayName(s);
              const active = selected.includes(name);
              return (
                <button
                  key={name}
                  onClick={() => toggleStudent(name)}
                  className={`px-3 py-1 rounded-full text-sm border transition ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-transparent text-foreground border-input hover:bg-secondary"
                  }`}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default StudentSelectorModal;
