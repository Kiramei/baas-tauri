import React, { useEffect, useLayoutEffect, useRef } from "react";
import Sidebar from "@/components/layout/Sidebar";
import { PageKey } from "@/types/app";
import { useUISetting } from "@/context/UISettingsProvider.tsx";
import { WindowLayoutBoundary, useWindowLayout } from "@/context/WindowLayoutProvider";

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
const MainLayoutContent: React.FC<MainLayoutProps> = ({ children, activePage, setActivePage }) => {
  const zoomScale = useUISetting((settings) => settings.zoomScale);
  const zoomRef = useZoom(zoomScale / 100);
  const { expanded: desktopSidebarExpanded, registerSidebar } = useWindowLayout();
  useLayoutEffect(registerSidebar, [registerSidebar]);
  return (
    <div
      className="app-layout flex h-full w-full min-h-0 flex-col overflow-hidden text-foreground lg:flex-row"
      ref={zoomRef}
      data-sidebar-expanded={desktopSidebarExpanded}
    >
      <Sidebar
        activePage={activePage}
        setActivePage={setActivePage}
        desktopExpanded={desktopSidebarExpanded}
      />
      <div
        className={`app-content-shell flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background lg:mb-[2px] lg:mr-[2px] lg:border lg:border-[var(--workspace-edge)] ${desktopSidebarExpanded ? "lg:rounded-tr-[14px]" : "lg:rounded-t-[14px] lg:rounded-bl-[14px]"}`}
      >
        <main
          className={
            __WITH_ANDROID__
              ? "desktop-main-panel min-h-0 flex-1 overflow-hidden bg-background p-3"
              : "desktop-main-panel min-h-0 flex-1 overflow-hidden bg-background"
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
};

const MainLayout: React.FC<MainLayoutProps> = (props) => (
  <WindowLayoutBoundary>
    <MainLayoutContent {...props} />
  </WindowLayoutBoundary>
);

export default MainLayout;
