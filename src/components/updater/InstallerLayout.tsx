import React from "react";
import { motion } from "framer-motion";
import { useUISetting } from "@/context/UISettingsProvider.tsx";

interface InstallerLayoutProps {
  children: React.ReactNode;
  title?: string;
  filling?: boolean;
}

/** Renders the installer layout component. */
const InstallerLayout: React.FC<InstallerLayoutProps> = ({ children, title, filling = false }) => {
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      <header className="flex h-12 shrink-0 items-center border-b border-border/70 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/images/logo.png" alt="" className="size-5 shrink-0 object-contain" />
          <h1 className="truncate text-sm font-medium">{title || "BAAS"}</h1>
        </div>
      </header>

      <main
        className={`min-h-0 flex-1 ${filling ? "flex overflow-hidden p-2 sm:p-3" : "flex flex-col overflow-y-auto px-4 py-6 sm:px-8 sm:pt-10 sm:pb-16"}`}
      >
        <motion.div
          initial={lowPerformanceMode ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: lowPerformanceMode ? 0 : 0.2 }}
          className={
            filling
              ? "flex h-full min-h-0 w-full flex-1 flex-col"
              : "mx-auto my-auto w-full max-w-[760px] shrink-0"
          }
        >
          {children}
        </motion.div>
      </main>
    </div>
  );
};

export default InstallerLayout;
