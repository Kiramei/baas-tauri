import React, {useEffect, useRef} from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import {useApp} from "@/contexts/AppContext.tsx";

type PageKey = 'home' | 'scheduler' | 'configuration' | 'settings' | 'wiki';


interface MainLayoutProps {
  children: React.ReactNode;
  activePage: string;
  setActivePage: (page: PageKey) => void;
}

export function useZoom(scale: number) {

  const ref = useRef<HTMLDivElement | null>(null);

  if (isNaN(scale)) scale = 1;

  useEffect(() => {
    const el = ref.current!;
    el.style.transformOrigin = "0 0";
    el.style.transform = `scale(${scale})`;
    el.style.width = `${100 / scale}%`;
    el.style.height = `${100 / scale}%`;
  }, [scale]);

  return ref;
}


const MainLayout: React.FC<MainLayoutProps> = ({children, activePage, setActivePage}) => {
  const {uiSettings} = useApp();
  const zoomRef = useZoom(uiSettings?.zoomScale / 100); // 缩放 110%
  return (
    <div className="flex h-full w-full overflow-hidden text-slate-800 dark:text-slate-200" ref={zoomRef}>
      <Sidebar activePage={activePage} setActivePage={setActivePage}/>
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header/>
        <main className="flex-1 overflow-y-auto p-6 pr-0 sm:pr-6 bg-slate-100 dark:bg-slate-800">
          {children}
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
