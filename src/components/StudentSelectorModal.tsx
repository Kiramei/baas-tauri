import React, {useState, useMemo} from "react";
import {Dialog, DialogPanel, DialogTitle} from "@headlessui/react";
import {X} from "lucide-react";
import {useTranslation} from "react-i18next";

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

const StudentSelectorModal: React.FC<Props> = ({
                                                 isOpen,
                                                 onClose,
                                                 allStudents,
                                                 selected,
                                                 onChange,
                                                 lang = "JP"
                                               }) => {

  const {t} = useTranslation();
  const [query, setQuery] = useState("");

  const displayName = (s: Student) => {
    if (lang === "CN") return s.CN_name;
    if (lang === "Global") return s.Global_name;
    return s.JP_name;
  };

  // 搜索过滤
  const filtered = useMemo(() => {
    return allStudents.filter((s) => {
        if (typeof s === "string")
          return s.toLowerCase().includes(query.toLowerCase());
        return displayName(s).toLowerCase().includes(query.toLowerCase());
      }
    );
  }, [query, allStudents, lang]);

  const toggleStudent = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((n) => n !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true"/>
      <div className="fixed inset-0 flex items-center justify-center">
        <DialogPanel className="w-full max-w-3xl rounded-lg bg-white dark:bg-slate-800 p-6 shadow-lg">
          <div className="flex justify-between items-center mb-4">
            <DialogTitle className="text-lg font-semibold">
              {t("artifact.selectStudent")}
            </DialogTitle>
            <button onClick={onClose}>
              <X className="w-5 h-5 text-slate-500"/>
            </button>
          </div>

          <input
            type="text"
            placeholder={t('student.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full mb-4 px-3 py-2 border rounded-md focus:ring-primary-500 focus:border-primary-500"
          />

          {/* 学生列表 */}
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
                      ? "bg-primary-600 text-white border-primary-600"
                      : "bg-slate-100 dark:bg-slate-700 border-slate-300"
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
