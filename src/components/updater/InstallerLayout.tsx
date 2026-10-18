import React from "react";
import { motion } from "framer-motion";
import { useUISetting } from "@/context/UISettingsProvider.tsx";

interface InstallerLayoutProps {
  children: React.ReactNode;
  title?: string;
}

/** Renders the installer layout component. */
const InstallerLayout: React.FC<InstallerLayoutProps> = ({ children, title }) => {
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-background text-foreground flex flex-col font-sans selection:bg-primary selection:text-primary-foreground">
      <header className="shrink-0 border-b border-border px-6 py-4">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/images/logo.png" alt="Logo" className="h-6 w-6 mr-1 rounded-md" />
            <h1 className="text-sm font-medium">BAAS Installer</h1>
          </div>
          {title && <div className="text-sm text-muted-foreground">{title}</div>}
        </div>
      </header>

      <main className="min-h-0 flex-1 container mx-auto p-4 md:p-6 flex flex-col gap-6 overflow-auto">
        <motion.div
          initial={lowPerformanceMode ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: lowPerformanceMode ? 0 : 0.2 }}
          className="min-h-full flex flex-col justify-center py-4"
        >
          {children}
        </motion.div>
      </main>

      <footer className="shrink-0 px-4 py-3 text-center text-xs text-muted-foreground">
        <p>Blue Archive Auto Script &copy; 2025</p>
      </footer>
    </div>
  );
};

export default InstallerLayout;
