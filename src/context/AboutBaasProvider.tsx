import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

const AboutBaasModal = lazy(() => import("@/components/AboutBaasModal"));
const ClientHistoryModal = lazy(() => import("@/components/ClientHistoryModal"));

const AboutBaasContext = createContext<(() => void) | undefined>(undefined);
const ClientHistoryContext = createContext<(() => void) | undefined>(undefined);

/** The titlebar and navigation logo open one shared About dialog. */
export function AboutBaasProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyHasOpened, setHistoryHasOpened] = useState(false);
  const openAbout = useCallback(() => {
    setHistoryOpen(false);
    setHasOpened(true);
    setOpen(true);
  }, []);
  const closeAbout = useCallback(() => setOpen(false), []);
  const openHistory = useCallback(() => {
    setOpen(false);
    setHistoryHasOpened(true);
    setHistoryOpen(true);
  }, []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  return (
    <AboutBaasContext.Provider value={openAbout}>
      <ClientHistoryContext.Provider value={openHistory}>
        {children}
        {hasOpened && (
          <Suspense fallback={null}>
            <AboutBaasModal open={open} onClose={closeAbout} />
          </Suspense>
        )}
        {historyHasOpened && (
          <Suspense fallback={null}>
            <ClientHistoryModal open={historyOpen} onClose={closeHistory} />
          </Suspense>
        )}
      </ClientHistoryContext.Provider>
    </AboutBaasContext.Provider>
  );
}

export function useAboutBaas() {
  const openAbout = useContext(AboutBaasContext);
  if (!openAbout) throw new Error("About actions require an AboutBaasProvider");
  return openAbout;
}

/** Android opens this shared surface from About when the titlebar is absent. */
export function useClientHistory() {
  const openHistory = useContext(ClientHistoryContext);
  if (!openHistory) throw new Error("Client history actions require an AboutBaasProvider");
  return openHistory;
}
