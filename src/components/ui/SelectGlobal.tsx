"use client";
import * as React from "react";

type GlobalCtx = {
  openId: string | null;
  setOpenId: (id: string | null) => void;
};

export const GlobalSelectContext = React.createContext<GlobalCtx | null>(null);

/** Renders the global select provider component. */
export function GlobalSelectProvider({ children }: { children: React.ReactNode }) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const value = React.useMemo(() => ({ openId, setOpenId }), [openId]);
  return <GlobalSelectContext.Provider value={value}>{children}</GlobalSelectContext.Provider>;
}

/** Coordinates the use global select hook behavior. */
export function useGlobalSelect() {
  return React.useContext(GlobalSelectContext);
}
