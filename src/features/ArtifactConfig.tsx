import React, {useState, useMemo, useEffect} from "react";
import {Tabs, TabsList, TabsTrigger, TabsContent} from "@/components/ui/tabs";
import {Select, SelectTrigger, SelectContent, SelectItem, SelectValue} from "@/components/ui/select";
import {Textarea} from "@/components/ui/textarea";
import {useTranslation} from "react-i18next";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import {FormInput} from "@/components/ui/FormInput.tsx";
import {FormSelect} from "@/components/ui/FormSelect.tsx";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import StudentSelectorModal from "@/components/StudentSelectorModal.tsx";
import {serverMap} from "@/lib/utils.ts";
import {DynamicConfig} from "@/types/dynamic";
import CButton from "@/components/ui/CButton.tsx";

type ArtifactConfigProps = {
  onClose: () => void;
  profileId: string;
};

type Draft = {
  use_acceleration_ticket: boolean;
  createTime: string | number;
  create_phase: number;
  create_phase_1_select_item_rule: string;
  create_phase_2_select_item_rule: string;
  create_phase_3_select_item_rule: string;
  createPriority_phase1: string[];
  createPriority_phase2: string[];
  createPriority_phase3: string[];
  // Configuration overrides for each crafting phase.
  phases: {
    method: string;
    priority: string;
  }[];
};

const ArtifactConfig: React.FC<ArtifactConfigProps> = ({onClose, profileId}) => {
  const {t} = useTranslation();

  const settings = useWebSocketStore(state => state.configStore[profileId]);
  const modify = useWebSocketStore(state => state.modify);

  /** Hydrate the form with the latest server-side values. */
  const ext = useMemo(() => {
    return {
      use_acceleration_ticket: settings.use_acceleration_ticket,
      createTime: settings.createTime,
      create_phase: settings.create_phase,
      create_phase_1_select_item_rule: settings.create_phase_1_select_item_rule,
      create_phase_2_select_item_rule: settings.create_phase_2_select_item_rule,
      create_phase_3_select_item_rule: settings.create_phase_3_select_item_rule,
      createPriority_phase1: settings.createPriority_phase1,
      createPriority_phase2: settings.createPriority_phase2,
      createPriority_phase3: settings.createPriority_phase3,
    } as Draft;
  }, [settings]);


  const [draft, setDraft] = useState<Draft>(ext);

  /** Reset the draft whenever the upstream configuration changes. */
  useEffect(() => {
    setDraft(ext);
  }, [ext]);

  /** Track whether the user has modified the draft state. */
  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  /** Persist only the fields that have diverged from the server baseline. */
  const handleSave = async () => {
    const patch: Partial<DynamicConfig> = {};
    (Object.keys(draft) as (keyof Draft)[]).forEach((k) => {
      if (JSON.stringify(draft[k]) !== JSON.stringify(ext[k])) {
        (patch as any)[k] = draft[k];
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
    <div className="space-y-4">
      <Tabs defaultValue="global" className="w-full">
        <TabsList className="w-full">
          <TabsTrigger value="global">{t("artifact.global")}</TabsTrigger>
          {Array.from({length: draft.create_phase}).map((_, i) => (
            <TabsTrigger key={i} value={`phase${i + 1}`}>
              {t(`artifact.phase_${i + 1}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Global configuration */}
        <TabsContent value="global">
          <div className="flex flex-col justify-between gap-4 mt-4">
            <SwitchButton
              label={t("artifact.useTicketDesc")}
              checked={draft.use_acceleration_ticket}
              onChange={(v) =>
                setDraft((d) => ({...d, use_acceleration_ticket: v}))
              }
            />

            <FormInput
              id="createTime"
              label={t("artifact.createTime")}
              type="number"
              value={draft.createTime}
              onChange={(e) =>
                setDraft((d) => ({...d, createTime: e.target.value}))
              }
              min="1"
              max="10"
            />

            <FormSelect
              label={t("artifact.phaseCount")}
              value={draft.create_phase.toString()}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  create_phase: Number(v)
                }))
              }
              options={[1, 2, 3].map((p) => ({
                value: p.toString(),
                label: p.toString(),
              }))}
            />
          </div>
        </TabsContent>

        {/* Phase-specific configuration */}
        {Array.from({length: draft.create_phase}, (_, i) => i).map((i) => (
          <TabsContent key={i} value={`phase${i + 1}`}>
            <ArtifactPhaseConfig
              phase={i + 1}
              draft={draft}
              settings={settings}
              setDraft={setDraft}
            />
          </TabsContent>
        ))}
      </Tabs>

      {/* Save action */}
      <div className="flex justify-end pt-4 border-t border-slate-200 dark:border-slate-700">
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="px-6 py-2 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 disabled:opacity-60"
        >
          {t("save")}
        </button>
      </div>
    </div>
  );
};

/* ---------- Phase Configuration ---------- */
type ArtifactPhaseConfigProps = {
  phase: number;
  draft: Draft;
  settings: Partial<DynamicConfig>
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
};

const ArtifactPhaseConfig: React.FC<ArtifactPhaseConfigProps> = ({
                                                                   settings,
                                                                   phase,
                                                                   draft,
                                                                   setDraft,
                                                                 }) => {
  const {t} = useTranslation();
  const [openStudentModal, setOpenStudentModal] = useState(false);

  const phaseMethods: Record<number, Record<string, string>> = {
    1: {default: t("artifact.default")},
    2: {
      primary: t("artifact.white"),
      normal: t("artifact.blue"),
      primary_normal: t("artifact.whiteBlue"),
      advanced: t("artifact.gold"),
      superior: t("artifact.purple"),
      advanced_superior: t("artifact.goldPurple"),
      primary_normal_advanced_superior: t("artifact.all"),
    },
    3: {
      advanced: t("artifact.gold"),
      superior: t("artifact.purple"),
      advanced_superior: t("artifact.goldPurple"),
    },
  };

  const staticConfig = useWebSocketStore(state => state.staticStore);

  const getPhase2RecommendedPriority = (
    name: string
  ): string[] => {
    const indexes = staticConfig.create_phase2_recommended_priority[name];
    const originPriority = staticConfig.create_default_priority[serverMap[settings.server]]["phase2"];
    const resPriority = indexes.map((i: any) => originPriority[i]);

    originPriority.forEach((_: any, i: number) => {
      if (!indexes.includes(i)) {
        resPriority.push(originPriority[i]);
      }
    });
    return resPriority;
  };

  return (
    <div className="space-y-4">
      {/* Material selection */}
      <div>
        <label className="block mb-1">{t("artifact.materialSelect")}</label>
        <Select
          value={draft[`create_phase_${phase}_select_item_rule`]}
          onValueChange={(val) =>
            setDraft((d) => {
              return {...d, [`create_phase_${phase}_select_item_rule`]: val};
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue/>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(phaseMethods[phase]).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Recommended priority (phase 2 only) */}
      {phase === 2 && (
        <div>
          <label className="block mb-1">{t("artifact.phase2.recommend")}</label>
          <CButton className="w-full" variant={"secondary"} onClick={() => setOpenStudentModal(true)}>
            {t("artifact.selectStudent")}
          </CButton>
        </div>
      )}

      {/* Crafting priority */}
      <div>
        <label className="block mb-1">{t("artifact.priority")}</label>
        <Textarea
          value={(draft[`createPriority_phase${phase}`]).join(" > ") || ""}
          onChange={(e) =>
            setDraft((d) => {
              return {...d, [`createPriority_phase${phase}`]: e.target.value.split(">").map(s => s.trim())};
            })
          }
          placeholder="A > B > C"
          className="min-h-[120px]"
        />
      </div>
      <StudentSelectorModal
        isOpen={openStudentModal}
        onClose={function (): void {
          setOpenStudentModal(false);
        }}
        allStudents={Object.keys(staticConfig.create_phase2_recommended_priority)}
        selected={[]}
        onChange={function (list: string[]): void {
          const priority = getPhase2RecommendedPriority(list[0]);
          setDraft((d) => ({...d, createPriority_phase2: priority}));
          setOpenStudentModal(false)
        }}
      />
    </div>
  );
};

export default ArtifactConfig;
