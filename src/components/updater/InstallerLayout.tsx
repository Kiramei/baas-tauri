import React from "react";
import { motion } from "framer-motion";

interface InstallerLayoutProps {
  children: React.ReactNode;
  title?: string;
}

const InstallerLayout: React.FC<InstallerLayoutProps> = ({ children, title }) => {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary selection:text-primary-foreground">
      <header className="p-4 border-b border-border/40 bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 sticky top-0 z-1">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/images/logo.png" alt="Logo" className="h-8 w-8 mr-1" />
            <h1 className="text-xl font-bold tracking-tight">BAAS Installer</h1>
          </div>
          {title && <div className="text-sm text-muted-foreground">{title}</div>}
        </div>
      </header>

      <main className="flex-1 container mx-auto p-6 flex flex-col gap-6 z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex-1 flex flex-col justify-center"
        >
          {children}
        </motion.div>
      </main>

      <footer className="p-4 border-t border-border/40 text-center text-sm text-muted-foreground z-1 backdrop-blur supports-backdrop-filter:bg-background/60">
        <p>Blue Archive Auto Script &copy; 2025</p>
      </footer>
    </div>
  );
};

export default InstallerLayout;
