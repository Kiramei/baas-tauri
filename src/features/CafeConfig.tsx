import React, { useMemo, useState } from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { X } from "lucide-react";
import StudentSelectorModal from "@/components/StudentSelectorModal";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationRow,
  ConfigurationSelect,
  ConfigurationToggle,
} from "@/components/configuration/ConfigurationControls";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { serverMap } from "@/shared/GlobalUtilities";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";

type CafeConfigProps = { onClose: () => void; profileId?: string };
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
const serialize = (draft: Draft) =>
  draft.cafe_reward_affection_pat_round === ""
    ? null
    : {
        ...draft,
        cafe_reward_invite1_starred_student_position: Number(
          draft.cafe_reward_invite1_starred_student_position
        ),
        cafe_reward_invite2_starred_student_position: Number(
          draft.cafe_reward_invite2_starred_student_position
        ),
      };

/** Cafe behavior and per-cafe invitations, saved as the user edits. */
const CafeConfig: React.FC<CafeConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId!]);
  const studentNames = useWebSocketStore((state) => state.staticStore.student_names ?? []);
  const ext = useMemo<Draft>(
    () => ({
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
        settings.cafe_reward_invite1_starred_student_position ?? 1
      ),
      cafe_reward_invite2_starred_student_position: String(
        settings.cafe_reward_invite2_starred_student_position ?? 1
      ),
      favorStudent1: settings.favorStudent1 ?? [],
      favorStudent2: settings.favorStudent2 ?? [],
    }),
    [settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId!, "cafe", ext, { serialize });
  const [selector, setSelector] = useState<1 | 2 | null>(null);
  const [tab, setTab] = useState("basic");
  const inviteOptions = [
    { value: "lowest_affection", label: t("cafe.lowestAffection") },
    { value: "highest_affection", label: t("cafe.highestAffection") },
    { value: "starred", label: t("cafe.starred") },
    { value: "name", label: t("cafe.byName") },
  ];
  const renderInvitation = (number: 1 | 2) => {
    const criterion =
      number === 1 ? "cafe_reward_invite1_criterion" : "cafe_reward_invite2_criterion";
    const position =
      number === 1
        ? "cafe_reward_invite1_starred_student_position"
        : "cafe_reward_invite2_starred_student_position";
    const students = number === 1 ? "favorStudent1" : "favorStudent2";
    return (
      <ConfigurationGroup title={number === 1 ? t("cafe.cafe1Settings") : t("cafe.cafe2Settings")}>
        <ConfigurationSelect
          label={number === 1 ? t("cafe.invite1Mode") : t("cafe.invite2Mode")}
          description={t("configurationHelp.cafeInviteMode")}
          value={draft[criterion]}
          onChange={(value) => setDraft((current) => ({ ...current, [criterion]: value }))}
          options={inviteOptions}
        />
        {draft[criterion] === "starred" && (
          <ConfigurationSelect
            label={t("cafe.starredPosition")}
            description={t("configurationHelp.cafeStarredPosition")}
            value={draft[position]}
            onChange={(value) => setDraft((current) => ({ ...current, [position]: value }))}
            options={[1, 2, 3, 4, 5].map((value) => ({
              value: String(value),
              label: String(value),
            }))}
          />
        )}
        {draft[criterion] === "name" && (
          <ConfigurationRow
            label={number === 1 ? t("cafe.cafe1Students") : t("cafe.cafe2Students")}
            description={t("configurationHelp.cafeStudents")}
            className="configuration-row-stacked"
          >
            <div className="flex flex-wrap items-center gap-2">
              {draft[students].map((name) => (
                <span
                  key={name}
                  className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-sm"
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
                  <button
                    type="button"
                    aria-label={`${t("common.delete")}: ${name}`}
                    className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        [students]: current[students].filter((item) => item !== name),
                      }))
                    }
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => setSelector(number)}
                className="rounded-lg bg-secondary px-3 py-1.5 text-sm hover:bg-secondary/70"
              >
                {t("student.add")}
              </button>
            </div>
          </ConfigurationRow>
        )}
      </ConfigurationGroup>
    );
  };
  return (
    <div className="space-y-6">
      <Tabs
        value={tab === "cafe2" && !draft.cafe_reward_has_no2_cafe ? "basic" : tab}
        onValueChange={setTab}
      >
        <TabsList
          className={`grid w-full ${draft.cafe_reward_has_no2_cafe ? "grid-cols-3" : "grid-cols-2"}`}
        >
          <TabsTrigger value="basic">{t("cafe.basicSettings")}</TabsTrigger>
          <TabsTrigger value="cafe1">{t("cafe.cafe1Settings")}</TabsTrigger>
          {draft.cafe_reward_has_no2_cafe && (
            <TabsTrigger value="cafe2">{t("cafe.cafe2Settings")}</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="basic" className="space-y-6">
          <ConfigurationGroup title={t("cafe.basicSettings")}>
            <ConfigurationToggle
              label={t("cafe.collectReward")}
              description={t("configurationHelp.cafeCollectReward")}
              checked={draft.cafe_reward_collect_hour_reward}
              onChange={(value) =>
                setDraft((current) => ({ ...current, cafe_reward_collect_hour_reward: value }))
              }
            />
            <ConfigurationToggle
              label={t("cafe.useInvitation")}
              description={t("configurationHelp.cafeUseInvitation")}
              checked={draft.cafe_reward_use_invitation_ticket}
              onChange={(value) =>
                setDraft((current) => ({ ...current, cafe_reward_use_invitation_ticket: value }))
              }
            />
            <ConfigurationToggle
              label={t("cafe.exchangeStudent")}
              description={t("configurationHelp.cafeExchangeStudent")}
              checked={draft.cafe_reward_allow_exchange_student}
              onChange={(value) =>
                setDraft((current) => ({ ...current, cafe_reward_allow_exchange_student: value }))
              }
            />
            <ConfigurationToggle
              label={t("cafe.duplicateInvite")}
              description={t("configurationHelp.cafeDuplicateInvite")}
              checked={draft.cafe_reward_allow_duplicate_invite}
              onChange={(value) =>
                setDraft((current) => ({ ...current, cafe_reward_allow_duplicate_invite: value }))
              }
            />
            <ConfigurationToggle
              label={t("cafe.hasNo2Cafe")}
              description={t("configurationHelp.cafeSecondCafe")}
              checked={draft.cafe_reward_has_no2_cafe}
              onChange={(value) =>
                setDraft((current) => ({ ...current, cafe_reward_has_no2_cafe: value }))
              }
            />
          </ConfigurationGroup>
          <ConfigurationGroup title={t("cafe.patStyle")}>
            <ConfigurationInput
              label={t("cafe.patRounds")}
              description={t("description.cafe.patRounds")}
              type="number"
              min={4}
              max={15}
              value={draft.cafe_reward_affection_pat_round}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "")
                  setDraft((current) => ({ ...current, cafe_reward_affection_pat_round: "" }));
                else if (Number.isFinite(Number(value)))
                  setDraft((current) => ({
                    ...current,
                    cafe_reward_affection_pat_round: Math.max(
                      4,
                      Math.min(15, Math.trunc(Number(value)))
                    ),
                  }));
              }}
            />
            <ConfigurationSelect
              label={t("cafe.patStyle")}
              description={t("configurationHelp.cafePatStyle")}
              value={draft.patStyle}
              onChange={(value) => setDraft((current) => ({ ...current, patStyle: value }))}
              options={[
                { value: "普通", label: t("configurationHelp.cafePatNormal") },
                { value: "拖动礼物", label: t("cafe.patStyleDragGift") },
              ]}
            />
          </ConfigurationGroup>
        </TabsContent>
        <TabsContent value="cafe1">{renderInvitation(1)}</TabsContent>
        {draft.cafe_reward_has_no2_cafe && (
          <TabsContent value="cafe2">{renderInvitation(2)}</TabsContent>
        )}
      </Tabs>
      <StudentSelectorModal
        isOpen={selector !== null}
        onClose={() => setSelector(null)}
        allStudents={studentNames}
        selected={selector === 2 ? draft.favorStudent2 : draft.favorStudent1}
        onChange={(list) =>
          setDraft((current) => ({
            ...current,
            [selector === 2 ? "favorStudent2" : "favorStudent1"]: list,
          }))
        }
        lang={serverMap[settings.server]}
      />
    </div>
  );
};
export default CafeConfig;
