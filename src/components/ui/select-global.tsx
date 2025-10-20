"use client"
import * as React from "react"

type GlobalCtx = {
  openId: string | null
  setOpenId: (id: string | null) => void
}

export const GlobalSelectContext = React.createContext<GlobalCtx | null>(null)

export function GlobalSelectProvider({ children }: { children: React.ReactNode }) {
  const [openId, setOpenId] = React.useState<string | null>(null)
  return (
    <GlobalSelectContext.Provider value={{ openId, setOpenId }}>
      {children}
    </GlobalSelectContext.Provider>
  )
}

export function useGlobalSelect() {
  return React.useContext(GlobalSelectContext)
}