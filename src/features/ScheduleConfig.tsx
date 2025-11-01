import React, {useEffect, useMemo, useState} from "react";
import {useTranslation} from "react-i18next";
import {Check, Plus, X} from "lucide-react";
import {Reorder} from "framer-motion";
import {Separator} from "@/components/ui/separator";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import {FormInput} from "@/components/ui/FormInput.tsx";
import StudentSelectorModal from "@/components/StudentSelectorModal.tsx";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {DynamicConfig} from "@/types/dynamic";
import {serverMap, serverMapSpec} from "@/lib/utils.ts";

type LessonConfigProps = {
  onClose: () => void;
  profileId?: string;
  settings?: Partial<DynamicConfig>;
  onChange?: (patch: Partial<DynamicConfig>) => Promise<void>;
};

type Draft = {
  lesson_enableInviteFavorStudent: boolean;
  lesson_favorStudent: string[];
  lesson_relationship_first: boolean;
  lesson_each_region_object_priority: string[][];
  lesson_times: number[];
};

const levels = ["primary", "normal", "advanced", "superior"];

const LessonConfig: React.FC<LessonConfigProps> = ({onClose, profileId}) => {
  const {t} = useTranslation();
  const settings: Partial<DynamicConfig> = useWebSocketStore(
    (state) => state.configStore[profileId!]
  );
  const modify = useWebSocketStore((state) => state.modify);
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const lessonNames = staticConfig.lesson_region_name[serverMapSpec[settings.server!]];
  const studentNames = staticConfig.student_names;
  const [showSelector, setShowSelector] = useState(false);

  // Convert external settings → default draft values
  const ext = useMemo(() => {
    return {
      lesson_enableInviteFavorStudent:
        settings.lesson_enableInviteFavorStudent ?? false,
      lesson_favorStudent: settings.lesson_favorStudent ?? [],
      lesson_relationship_first: settings.lesson_relationship_first ?? false,
      lesson_each_region_object_priority:
        settings.lesson_each_region_object_priority ??
        lessonNames.map(() => [...levels]),
      lesson_times: settings.lesson_times ?? lessonNames.map(() => 1),
    };
  }, [settings]);

  const [draft, setDraft] = useState<Draft>(ext);

  useEffect(() => {
    setDraft((prev) => {
      // Simple shallow comparison to prevent recursive updates
      if (JSON.stringify(prev) !== JSON.stringify(ext)) {
        return ext;
      }
      return prev;
    });
  }, [ext]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  // Save configuration
  const handleSave = async () => {
    const patch: Partial<DynamicConfig> = {};
    (Object.keys(draft) as (keyof Draft)[]).forEach((k) => {
      if (JSON.stringify(draft[k]) !== JSON.stringify(ext[k])) {
        patch[k] = draft[k] as any;
      }
    });

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    modify(`${profileId}::config`, patch);
    onClose();
  };

  // Remove a favorite student from the list
  const removeFavorStudent = (name: string) => {
    setDraft((d) => ({
      ...d,
      lesson_favorStudent: d.lesson_favorStudent.filter((n) => n !== name),
    }));
  };

  // Toggle region-level selection
  const toggleLevel = (i: number, level: string) => {
    setDraft((d) => {
      const copy = d.lesson_each_region_object_priority.map((arr) => [...arr]);
      if (copy[i].includes(level)) {
        copy[i] = copy[i].filter((l) => l !== level);
      } else {
        copy[i].push(level);
      }
      return {...d, lesson_each_region_object_priority: copy};
    });
  };

  // Update number of repetitions per region
  const updateTimes = (i: number, val: string) => {
    const n = Number(val);
    if (Number.isFinite(n)) {
      setDraft((d) => {
        const copy = [...d.lesson_times];
        copy[i] = n;
        return {...d, lesson_times: copy};
      });
    }
  };

  return (
    <div className="space-y-2">
      {/* Priority: Favor specific students */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <SwitchButton
          checked={draft.lesson_enableInviteFavorStudent}
          label={t("lesson.enableFavorStudent")}
          onChange={(checked) =>
            setDraft((d) => ({
              ...d,
              lesson_enableInviteFavorStudent: checked,
            }))
          }
        />

        <SwitchButton
          checked={draft.lesson_relationship_first}
          label={t("lesson.relationshipFirst")}
          onChange={(checked) =>
            setDraft((d) => ({...d, lesson_relationship_first: checked}))
          }
        />
      </div>

      {/* Favorite students section */}
      {draft.lesson_enableInviteFavorStudent && (
        <div>
          <label className="block text-sm font-medium mb-2 text-slate-700 dark:text-slate-200">
            {t("lesson.favorStudent")}
          </label>

          {/* Outer container: single row with horizontal scroll */}
          <div className="overflow-x-auto pb-1 scroll-embedded">
            <Reorder.Group
              axis="x"
              values={draft.lesson_favorStudent}
              onReorder={(newOrder) =>
                setDraft((d) => ({...d, lesson_favorStudent: newOrder}))
              }
              className="flex gap-1 min-w-max"
            >
              {draft.lesson_favorStudent.map((name, index) => (
                <Reorder.Item
                  key={name}
                  value={name}
                  className="
                    flex items-center gap-2 px-3 py-0.5 shrink-0
                    rounded-full border border-slate-300 dark:border-slate-600
                    bg-slate-100 dark:bg-slate-700
                    shadow-sm hover:shadow-md
                    cursor-grab
                  "
                >
                  {/* Order number indicator */}
                  <span
                    className="flex items-center justify-center w-5 h-5 text-xs font-medium rounded-full bg-primary text-primary-foreground">
                    {index + 1}
                  </span>

                  <span className="text-sm">{name}</span>

                  {/* Delete button (light red background on hover) */}
                  <button
                    onClick={() => removeFavorStudent(name)}
                    className="ml-1 inline-flex items-center justify-center w-5 h-5 rounded-full text-red-500 hover:bg-red-100 dark:hover:bg-red-900 transition"
                  >
                    <X className="w-3.5 h-3.5"/>
                  </button>
                </Reorder.Item>
              ))}

              {/* Add button (same row as tags) */}
              <button
                onClick={() => setShowSelector(true)}
                className="
                  flex items-center gap-1 px-3 py-0.5 shrink-0
                  rounded-full border-2 border-dashed border-slate-300 dark:border-slate-600
                  text-slate-600 dark:text-slate-200
                  hover:bg-slate-100 dark:hover:bg-slate-600
                "
              >
                <Plus className="w-4 h-4"/> {t("add")}
              </button>
            </Reorder.Group>
          </div>
        </div>
      )}

      <Separator/>

      {/* Region-level configuration table */}
      <div
        className="overflow-y-auto overflow-x-auto border rounded-md"
        style={{maxHeight: "calc(100vh - 320px)", minHeight: "80px"}}
      >
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-slate-100 dark:bg-slate-700 z-10">
          <tr>
            <th className="px-2 py-1 border text-left">
              {t("lesson.region")}
            </th>
            {levels.map((l) => (
              <th key={l} className="px-2 py-1 border">
                {t(`schedule.${l}`)}
              </th>
            ))}
            <th className="px-2 py-1 border">{t("lesson.times")}</th>
          </tr>
          </thead>
          <tbody>
          {lessonNames.map((name: any, i: number) => (
            <tr key={i}>
              <td className="px-2 py-1 border">{name}</td>
              {levels.map((lvl, j) => (
                <td key={j} className="px-2 py-1 border text-center">
                  <label className="relative inline-flex items-center cursor-pointer mt-1">
                    <input
                      type="checkbox"
                      checked={draft.lesson_each_region_object_priority[i].includes(
                        lvl
                      )}
                      onChange={() => toggleLevel(i, lvl)}
                      className="
                          peer w-6 h-6 cursor-pointer
                          appearance-none
                          rounded-full border
                          border-slate-500 dark:border-slate-400
                          bg-slate-100 dark:bg-slate-700
                          checked:bg-primary-400 checked:border-slate-500
                          dark:checked:bg-primary-600 dark:checked:border-slate-400
                          checked:text-primary-foreground
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
                          disabled:cursor-not-allowed disabled:opacity-50
                        "
                    />
                    <Check
                      className="
                          pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 text-white
                          opacity-0 peer-checked:opacity-100 transition-opacity
                        "
                    />
                  </label>
                </td>
              ))}
              <td className="px-2 py-1 border ">
                <FormInput
                  type="number"
                  value={draft.lesson_times[i]}
                  onChange={(e) => updateTimes(i, e.target.value)}
                  min={0}
                  max={99}
                  className="w-20 px-1 m-auto"
                />
              </td>
            </tr>
          ))}
          </tbody>
        </table>
      </div>

      <StudentSelectorModal
        isOpen={showSelector}
        onClose={() => setShowSelector(false)}
        allStudents={studentNames}
        selected={draft.lesson_favorStudent}
        onChange={(names) =>
          setDraft((d) => ({...d, lesson_favorStudent: names}))
        }
        lang={serverMap[settings.server!]}
      />

      {/* Save button */}
      <div className="flex justify-end pt-4 border-t">
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="px-6 py-2 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors duration-200 disabled:opacity-60"
        >
          {t("save")}
        </button>
      </div>
    </div>
  );
};

export default LessonConfig;
