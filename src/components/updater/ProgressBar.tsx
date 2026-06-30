import React from "react";
import { motion } from "framer-motion";
import { useGlobalLogStore } from "@/store/GlobalLogStore";
import { useUISettings } from "@/context/UISettingsProvider.tsx";

/** Renders the progress bar component. */
const ProgressBar: React.FC = () => {
  const globalProgress = useGlobalLogStore((e) => e.globalProgress);
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;

  return (
    <div className="w-full space-y-2">
      <div className="flex justify-between text-sm">
        <span className="font-medium">{globalProgress.message}</span>
        <span className="text-muted-foreground">{globalProgress.progress}%</span>
      </div>
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-primary-600"
          initial={lowPerformanceMode ? false : { width: 0 }}
          animate={{ width: `${globalProgress.progress}%` }}
          transition={
            lowPerformanceMode ? { duration: 0 } : { type: "spring", stiffness: 50, damping: 15 }
          }
        />
      </div>
    </div>
  );
};

export default ProgressBar;
