import React, { useEffect, useRef, useState } from "react";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";
import { PageKey } from "@/types/app";
import { useUISetting } from "@/context/UISettingsProvider.tsx";

interface MainLayoutProps {
  children: React.ReactNode;
  activePage: string;
  setActivePage: (page: PageKey) => void;
}

/** Coordinates the use zoom hook behavior. */
export function useZoom(scale: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  let _scale = scale;
  if (isNaN(scale)) _scale = 1;

  useEffect(() => {
    const el = ref.current!;
    el.style.transformOrigin = "0 0";
    el.style.transform = `scale(${_scale})`;
    el.style.width = `${100 / _scale}%`;
    el.style.height = `${100 / _scale}%`;
  }, [_scale]);

  return ref;
}

/** Renders the main layout component. */
const MainLayout: React.FC<MainLayoutProps> = ({ children, activePage, setActivePage }) => {
  const zoomScale = useUISetting((settings) => settings.zoomScale);
  const zoomRef = useZoom(zoomScale / 100);
  const [desktopSidebarExpanded, setDesktopSidebarExpanded] = useState(false);
  return (
    <div
      className="flex h-full w-full overflow-hidden bg-white text-slate-800 dark:bg-slate-900 dark:text-slate-200"
      ref={zoomRef}
    >
      <Sidebar
        activePage={activePage}
        setActivePage={setActivePage}
        desktopExpanded={desktopSidebarExpanded}
        onDesktopExpandedChange={setDesktopSidebarExpanded}
      />
      <div className="flex flex-1 flex-col overflow-hidden bg-white dark:bg-slate-900">
        <Header />
        <main
          className={
            __WITH_ANDROID__
              ? "desktop-main-panel flex-1 overflow-y-auto bg-slate-100 bg-clip-padding p-3 dark:bg-slate-800 lg:rounded-tl-[16px] lg:border-l"
              : "desktop-main-panel flex-1 overflow-y-auto bg-slate-100 bg-clip-padding p-6 pr-0 dark:bg-slate-800 lg:rounded-tl-[16px] lg:border-l"
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
