import React, { Dispatch, SetStateAction, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import {
  Amphora,
  ArrowUpFromLine,
  BrushCleaning,
  Coffee,
  Database,
  Dices,
  FileCode2,
  LucideProps,
  Map,
  ScrollText,
  Server,
  Settings2,
  Shield,
  ShoppingCart,
  Sword,
  Swords,
  Users2Icon,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import { useUISetting } from "@/context/UISettingsProvider.tsx";
import { ProfileProps } from "@/types/app";
import { PageKey } from "@/types/app";
import { featureTranslationKey, i18nKey } from "@/shared/I18nKeys";
import type { TranslationKey } from "@/types/i18n";

type Feature =
  | "cafe"
  | "schedule"
  | "shop"
  | "artifact"
  | "arena"
  | "dailySweep"
  | "tactical"
  | "drill"
  | "whitelist"
  | "server"
  | "script"
  | "emulator"
  | "stage"
  | "team"
  | "push"
  | "other";

const FeatureWidthDict: Record<Feature, number> = {
  cafe: 50,
  schedule: 50,
  shop: 50,
  artifact: 80,
  arena: 30,
  dailySweep: 70,
  tactical: 60,
  drill: 50,
  whitelist: 70,
  server: 30,
  script: 60,
  emulator: 50,
  stage: 80,
  team: 70,
  push: 50,
  other: 30,
};

/**
 * Contract for feature configuration panels rendered inside the modal.
 */
export interface FeatureComponentProps {
  onClose: () => void;
  profileId: string;
  setActivePage?: Dispatch<SetStateAction<PageKey>>;
}

const CafeConfig = React.lazy(() => import("@/features/CafeConfig"));
const ServerConfig = React.lazy(() => import("@/features/ServerConfig"));
const ScheduleConfig = React.lazy(() => import("@/features/ScheduleConfig"));
const ShopConfig = React.lazy(() => import("@/features/ShopConfig"));
const ArenaConfig = React.lazy(() => import("@/features/ArenaConfig"));
const DailySweep = React.lazy(() => import("@/features/DailySweep"));
const TacticalConfig = React.lazy(() => import("@/features/TacticalConfig.tsx"));
const DrillConfig = React.lazy(() => import("@/features/DrillConfig.tsx"));
const EmulatorConfig = React.lazy(() => import("@/features/EmulatorConfig"));
const PushConfig = React.lazy(() => import("@/features/PushConfig"));
const OtherConfig = React.lazy(() => import("@/features/OtherConfig"));
const WhiteListConfig = React.lazy(() => import("@/features/WhiteListConfig.tsx"));
const ArtifactConfig = React.lazy(() => import("@/features/ArtifactConfig.tsx"));
const ScriptConfig = React.lazy(() => import("@/features/ScriptConfig.tsx"));
const StageConfig = React.lazy(() => import("@/features/StageConfig.tsx"));
const TeamConfig = React.lazy(() => import("@/features/TeamConfig.tsx"));

/**
 * Registry that connects feature identifiers with their iconography, copy, and concrete implementation.
 */
const featureMap: Record<
  Feature,
  {
    icon: React.FC<LucideProps>;
    descKey: TranslationKey;
    component: React.LazyExoticComponent<React.FC<FeatureComponentProps>>;
  }
> = {
  cafe: { icon: Coffee, descKey: "description.cafe", component: CafeConfig },
  schedule: { icon: Dices, descKey: "description.schedule", component: ScheduleConfig },
  shop: { icon: ShoppingCart, descKey: "description.shop", component: ShopConfig },
  arena: { icon: Swords, descKey: "description.arena", component: ArenaConfig },
  dailySweep: { icon: BrushCleaning, descKey: "description.dailySweep", component: DailySweep },
  tactical: { icon: Shield, descKey: "description.tactical", component: TacticalConfig },
  drill: { icon: Sword, descKey: "description.drill", component: DrillConfig },
  whitelist: { icon: ScrollText, descKey: "description.whitelist", component: WhiteListConfig },
  artifact: { icon: Amphora, descKey: "description.artifact", component: ArtifactConfig },

  server: { icon: Server, descKey: "description.server", component: ServerConfig },
  script: { icon: FileCode2, descKey: "description.script", component: ScriptConfig },
  emulator: { icon: Database, descKey: "description.emulator", component: EmulatorConfig },
  stage: { icon: Map, descKey: "description.stage", component: StageConfig },
  team: { icon: Users2Icon, descKey: "description.team", component: TeamConfig },
  push: { icon: ArrowUpFromLine, descKey: "description.push", component: PushConfig },
  other: { icon: Settings2, descKey: "description.other", component: OtherConfig },
};

/** Renders the motion card component. */
const MotionCard: React.FC<
  React.PropsWithChildren<{ lowPerformanceMode: boolean; onClick?: () => void }>
> = ({ children, lowPerformanceMode, onClick }) => (
  <div
    className={`cursor-pointer ${lowPerformanceMode ? "" : "transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.99]"}`}
    onClick={onClick}
  >
    <Card>{children}</Card>
  </div>
);

/** Renders a small placeholder while a selected feature panel chunk is fetched. */
const FeaturePanelFallback: React.FC = () => (
  <div className="flex min-h-40 items-center justify-center">
    <div className="h-7 w-7 rounded-full border-2 border-slate-300 border-t-primary-500 animate-spin" />
  </div>
);

/**
 * Presents the full catalog of configurable features for the selected profile.
 * Each tile launches a modal that exposes the respective configuration surface.
 */
const ConfigurationPage: React.FC<ProfileProps> = ({ profileId, setActivePage }) => {
  const { t } = useTranslation();
  const { profiles, activeProfile } = useApp();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);

  const pid = profileId ?? activeProfile?.id;
  /** Handles the profile workflow. */
  const profile = useMemo(
    () => profiles.find((p) => p.id === pid) ?? activeProfile ?? null,
    [profiles, pid, activeProfile]
  );

  const [modalContent, setModalContent] = useState<Feature | null>(null);
  const [modalWidth, setModalWidth] = useState<number | null>(null);

  /** Performs the open modal operation. */
  const openModal = (feature: Feature) => {
    setModalWidth(FeatureWidthDict[feature]);
    setModalContent(feature);
  };

  /** Performs the close modal operation. */
  const closeModal = () => {
    setModalContent(null);
  };

  const featureGroups: Record<string, Feature[]> = {
    [t("settings.feature")]: [
      "cafe",
      "schedule",
      "shop",
      "artifact",
      "arena",
      "dailySweep",
      "tactical",
      "drill",
      "whitelist",
    ],
    [t("settings.general")]: ["server", "script", "emulator", "stage", "team", "push", "other"],
  };

  /** Handles the render feature card workflow. */
  const renderFeatureCard = (feature: Feature) => {
    const { icon: Icon, descKey } = featureMap[feature];
    return (
      <MotionCard
        key={feature}
        lowPerformanceMode={lowPerformanceMode}
        onClick={() => openModal(feature)}
      >
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="bg-primary-100 dark:bg-primary-900/50 p-3 rounded-lg">
              <Icon className="w-6 h-6 text-primary-600 dark:text-primary-400" />
            </div>
            <div>
              <CardTitle>{t(featureTranslationKey(feature))}</CardTitle>
              <CardDescription>{t(i18nKey(descKey))}</CardDescription>
            </div>
          </div>
        </CardHeader>
      </MotionCard>
    );
  };

  const CurrentModalContent = modalContent ? featureMap[modalContent].component : null;

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between">
        <div className="flex">
          <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100">
            {t("nav.configuration")}
          </h2>
          <h2 className="text-2xl ml-3 text-slate-500 dark:text-slate-400">#{profile?.name}</h2>
        </div>
      </div>

      {/* Feature catalog rendered as motion-enabled tiles. */}
      <div className="space-y-8">
        {Object.entries(featureGroups).map(([groupTitle, features]) => (
          <section key={groupTitle}>
            <h3 className="text-lg font-semibold mb-4 text-slate-700 dark:text-slate-200">
              {groupTitle}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {features.map(renderFeatureCard)}
            </div>
          </section>
        ))}
      </div>

      {/* Lazy render the selected feature panel inside a shared modal shell. */}
      {modalContent && CurrentModalContent && (
        <Modal
          isOpen
          title={t(featureTranslationKey(modalContent))}
          onClose={closeModal}
          width={modalWidth ?? 0}
        >
          <React.Suspense fallback={<FeaturePanelFallback />}>
            <CurrentModalContent
              onClose={closeModal}
              profileId={profile!.id}
              setActivePage={setActivePage}
            />
          </React.Suspense>
        </Modal>
      )}
    </div>
  );
};

export default ConfigurationPage;
