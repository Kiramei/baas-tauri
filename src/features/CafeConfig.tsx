import React, {useEffect, useMemo, useState} from "react";
import {useTranslation} from "react-i18next";
import {X} from "lucide-react";
import StudentSelectorModal from "@/components/StudentSelectorModal.tsx";
import {FormSelect} from "@/components/ui/FormSelect";
import {FormInput} from "@/components/ui/FormInput";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {Separator} from "@/components/ui/separator.tsx";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {serverMap} from "@/lib/utils.ts";
import {DynamicConfig} from "@/types/dynamic";

type CafeConfigProps = {
  onClose: () => void;
  profileId?: string;
};

type Draft = {
  cafe_reward_collect_hour_reward: boolean;
  cafe_reward_use_invitation_ticket: boolean;
  cafe_reward_allow_exchange_student: boolean;
  cafe_reward_allow_duplicate_invite: boolean;
  cafe_reward_has_no2_cafe: boolean;
  cafe_reward_affection_pat_round: number | "";
  patStyle: string;
  cafe_reward_invite1_criterion: string;
  cafe_reward_invite2_criterion: string;
  cafe_reward_invite1_starred_student_position: string;
  cafe_reward_invite2_starred_student_position: string;
  favorStudent1: string[];
  favorStudent2: string[];
};

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

/* ---------- Main Component for CafeConfig ---------- */
const CafeConfig: React.FC<CafeConfigProps> = ({
                                                 onClose,
                                                 profileId,
                                               }) => {
  const staticConfig = useWebSocketStore(e => e.staticStore);
  const studentNames = staticConfig.student_names;
  const {t} = useTranslation();
  const settings = useWebSocketStore(e => e.configStore[profileId!]);
  const modify = useWebSocketStore(state => state.modify);

  const ext = useMemo(() => {
    return {
      cafe_reward_collect_hour_reward: settings.cafe_reward_collect_hour_reward ?? false,
      cafe_reward_use_invitation_ticket: settings.cafe_reward_use_invitation_ticket ?? true,
      cafe_reward_allow_exchange_student: settings.cafe_reward_allow_exchange_student ?? true,
      cafe_reward_allow_duplicate_invite: settings.cafe_reward_allow_duplicate_invite ?? false,
      cafe_reward_has_no2_cafe: settings.cafe_reward_has_no2_cafe ?? false,
      cafe_reward_affection_pat_round: settings.cafe_reward_affection_pat_round ?? 5,
      patStyle: settings.patStyle ?? "普通",
      cafe_reward_invite1_criterion: settings.cafe_reward_invite1_criterion ?? "lowest_affection",
      cafe_reward_invite2_criterion: settings.cafe_reward_invite2_criterion ?? "lowest_affection",
      cafe_reward_invite1_starred_student_position: String(
        settings.cafe_reward_invite1_starred_student_position ?? "1"
      ),
      cafe_reward_invite2_starred_student_position: String(
        settings.cafe_reward_invite2_starred_student_position ?? "1"
      ),
      favorStudent1: settings.favorStudent1 ?? [],
      favorStudent2: settings.favorStudent2 ?? [],
    };
  }, [settings]);

  const [draft, setDraft] = useState<Draft>(ext);
  const [showSelector1, setShowSelector1] = useState(false);
  const [showSelector2, setShowSelector2] = useState(false);

  useEffect(() => setDraft(ext), [ext]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  // Toggle handlers for boolean fields.
  const onBoolChange = (key: keyof Draft) => (value: boolean) =>
    setDraft((d) => ({...d, [key]: value}));

  // Normalize numeric input and keep it within the supported range.
  const onNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === "") return setDraft((d) => ({...d, cafe_reward_affection_pat_round: ""}));
    const n = Number(raw);
    if (Number.isFinite(n)) {
      setDraft((d) => ({
        ...d,
        cafe_reward_affection_pat_round: clamp(Math.trunc(n), 4, 15),
      }));
    }
  };

  const onSelectChange = (key: string) => (value: string) => {
    setDraft((d) => ({...d, [key]: value}));
  };

  // Persist only the fields that have diverged from the server state.
  const handleSave = async () => {
    const patch: Partial<DynamicConfig> = {};
    (Object.keys(draft) as (keyof Draft)[]).forEach((k) => {
      if (draft[k] !== ext[k]) {
        // @ts-ignore
        patch[k] = draft[k] as DynamicConfig[typeof k];
      }
    });

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    modify(`${profileId}::config`, patch)

    onClose();
  };

  return (
    <div className="space-y-2">
      <Tabs defaultValue="basic" className="w-full">
        <TabsList className="grid grid-cols-3 w-full">
          <TabsTrigger value="basic">{t("cafe.basicSettings")}</TabsTrigger>
          <TabsTrigger value="cafe1">{t("cafe.cafe1Settings")}</TabsTrigger>
          {draft.cafe_reward_has_no2_cafe && (
            <TabsTrigger value="cafe2">{t("cafe.cafe2Settings")}</TabsTrigger>
          )}
        </TabsList>

        {/* Basic Settings */}
        <TabsContent value="basic" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {[
              ["cafe_reward_collect_hour_reward", "cafe.collectReward"],
              ["cafe_reward_use_invitation_ticket", "cafe.useInvitation"],
              ["cafe_reward_allow_exchange_student", "cafe.exchangeStudent"],
              ["cafe_reward_allow_duplicate_invite", "cafe.duplicateInvite"],
              ["cafe_reward_has_no2_cafe", "cafe.hasNo2Cafe"],
            ].map(([key, label]) => (
              <SwitchButton
                label={t(label)}
                checked={draft[key as keyof Draft] as boolean}
                onChange={onBoolChange(key as keyof Draft)}
                key={label}
              />
            ))}
          </div>

          <Separator/>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">

            <FormInput
              label={t("cafe.patRounds")}
              tooltip={t("cafe.patRoundsDesc")}
              type="number"
              value={draft.cafe_reward_affection_pat_round}
              onChange={onNumberChange}
              min={4}
              max={15}
            />

            <FormSelect
              label={t("cafe.patStyle")}
              value={draft.patStyle}
              onChange={onSelectChange("pat_style")}
              options={[
                {value: "拖动礼物", label: t("cafe.patStyleDragGift")},
              ]}
            />

          </div>
        </TabsContent>

        {/* 咖啡馆1 */}
        <TabsContent value="cafe1" className="space-y-6 pt-4">
          <FormSelect
            label={t("cafe.invite1Mode")}
            value={draft.cafe_reward_invite1_criterion}
            onChange={onSelectChange("cafe_reward_invite1_criterion")}
            options={[
              {value: "lowest_affection", label: t("cafe.lowestAffection")},
              {value: "highest_affection", label: t("cafe.highestAffection")},
              {value: "starred", label: t("cafe.starred")},
              {value: "name", label: t("cafe.byName")},
            ]}
          />

          {draft.cafe_reward_invite1_criterion === "starred" && (
            <FormSelect
              label={t("cafe.starredPosition")}
              value={draft.cafe_reward_invite1_starred_student_position}
              onChange={onSelectChange("cafe_invite1_starred_position")}
              options={[1, 2, 3, 4, 5].map((n) => ({
                value: String(n),
                label: String(n),
              }))}
            />
          )}

          {draft.cafe_reward_invite1_criterion === "name" && (
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                {t("cafe.cafe1Students")}
              </label>
              <div className="flex flex-wrap gap-2">
                {draft.favorStudent1.map((name) => (
                  <span
                    key={name}
                    className="flex items-center gap-1 px-2 py-1 bg-slate-200 rounded-full text-sm dark:bg-slate-700"
                  >
                    {name}
                    <button
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          favorStudent1: d.favorStudent1.filter(
                            (n) => n !== name
                          ),
                        }))
                      }
                    >
                      <X className="w-3 h-3"/>
                    </button>
                  </span>
                ))}
                <button
                  onClick={() => setShowSelector1(true)}
                  className="px-3 py-1 text-sm border rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                >
                  {t("Add Student")}
                </button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* 咖啡馆2 */}
        {draft.cafe_reward_has_no2_cafe && (
          <TabsContent value="cafe2" className="space-y-6 pt-4">
            <FormSelect
              label={t("cafe.invite2Mode")}
              value={draft.cafe_reward_invite2_criterion}
              onChange={onSelectChange("cafe_reward_invite2_criterion")}
              options={[
                {value: "lowest_affection", label: t("cafe.lowestAffection")},
                {value: "highest_affection", label: t("cafe.highestAffection")},
                {value: "starred", label: t("cafe.starred")},
                {value: "name", label: t("cafe.byName")},
              ]}
            />

            {draft.cafe_reward_invite2_criterion === "starred" && (
              <FormSelect
                label={t("cafe.starredPosition")}
                value={draft.cafe_reward_invite2_starred_student_position}
                onChange={onSelectChange("cafe_invite2_starred_position")}
                options={[1, 2, 3, 4, 5].map((n) => ({
                  value: String(n),
                  label: String(n),
                }))}
              />
            )}

            {draft.cafe_reward_invite2_criterion === "name" && (
              <div className="space-y-2">
                <label className="block text-sm font-medium">
                  {t("cafe.cafe2Students")}
                </label>
                <div className="flex flex-wrap gap-2">
                  {draft.favorStudent2.map((name) => (
                    <span
                      key={name}
                      className="flex items-center gap-1 px-2 py-1 bg-slate-200 rounded-full text-sm dark:bg-slate-700"
                    >
                      {name}
                      <button
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            favorStudent2: d.favorStudent2.filter(
                              (n) => n !== name
                            ),
                          }))
                        }
                      >
                        <X className="w-3 h-3"/>
                      </button>
                    </span>
                  ))}
                  <button
                    onClick={() => setShowSelector2(true)}
                    className="px-3 py-1 text-sm border rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                  >
                    {t("Add Student")}
                  </button>
                </div>
              </div>
            )}
          </TabsContent>
        )}
      </Tabs>

      <StudentSelectorModal
        isOpen={showSelector1}
        onClose={() => setShowSelector1(false)}
        allStudents={studentNames}
        selected={draft.favorStudent1}
        onChange={(list) => setDraft((d) => ({...d, favorStudent1: list}))}
        lang={serverMap[settings.server]}
      />

      <StudentSelectorModal
        isOpen={showSelector2}
        onClose={() => setShowSelector2(false)}
        allStudents={studentNames}
        selected={draft.favorStudent2}
        onChange={(list) => setDraft((d) => ({...d, favorStudent2: list}))}
        lang={serverMap[settings.server]}
      />

      <Separator/>

      {/* Save Button */}
      <div className="flex justify-end pt-4">
        <button
          onClick={handleSave}
          disabled={!dirty || draft.cafe_reward_affection_pat_round === ""}
          className="px-6 py-2 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors duration-200 disabled:opacity-60"
        >
          {t("save")}
        </button>
      </div>
    </div>
  );
};

export default CafeConfig;


