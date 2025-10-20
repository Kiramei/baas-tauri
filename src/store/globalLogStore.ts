import {create} from "zustand";
import {LogItem} from "./websocketStore.js"

interface GlobalLogInterface {
  globalLogData: LogItem[]
  appendGlobalLog: (log: LogItem) => void
}

export const useGlobalLogStore = create<GlobalLogInterface>((set, _) => ({
  globalLogData: [],

  appendGlobalLog: (log: LogItem) => {
    set((state) => {
      return {globalLogData: [...state.globalLogData, log]}
    })
  }
}));
