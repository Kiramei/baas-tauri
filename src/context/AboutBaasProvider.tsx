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

const AboutBaasContext = createContext<(() => void) | undefined>(undefined);

/** The titlebar and navigation logo open one shared About dialog. */
export function AboutBaasProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const openAbout = useCallback(() => {
    setHasOpened(true);
    setOpen(true);
  }, []);
  const closeAbout = useCallback(() => setOpen(false), []);

  return (
    <AboutBaasContext.Provider value={openAbout}>
      {children}
      {hasOpened && (
        <Suspense fallback={null}>
          <AboutBaasModal open={open} onClose={closeAbout} />
        </Suspense>
      )}
    </AboutBaasContext.Provider>
  );
}

export function useAboutBaas() {
  const openAbout = useContext(AboutBaasContext);
  if (!openAbout) throw new Error("About actions require an AboutBaasProvider");
  return openAbout;
}
