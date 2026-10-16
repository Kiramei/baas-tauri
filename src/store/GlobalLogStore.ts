import { create } from "zustand";
import { LogItem } from "@/types/app";

interface GlobalLogInterface {
  globalLogData: LogItem[];
  terminalLogData: LogItem[];

  appendGlobalLog: (log: LogItem) => void;
  appendGlobalLogs: (logs: LogItem[]) => void;

  appendTerminalLog: (log: LogItem) => void;
  appendTerminalLogs: (logs: LogItem[]) => void;
}

export const useGlobalLogStore = create<GlobalLogInterface>((set) => ({
  globalLogData: [],
  terminalLogData: [],
  appendGlobalLog: (log: LogItem) => {
    set((state) => {
      return { globalLogData: [...state.globalLogData, log] };
    });
  },
  appendGlobalLogs: (logs: LogItem[]) => {
    if (logs.length === 0) return;
    set((state) => ({ globalLogData: [...state.globalLogData, ...logs] }));
  },

  appendTerminalLog: (log: LogItem) => {
    set((state) => {
      return { terminalLogData: [...state.terminalLogData, log] };
    });
  },
  appendTerminalLogs: (logs: LogItem[]) => {
    if (logs.length === 0) return;
    set((state) => {
      return { terminalLogData: [...state.terminalLogData, ...logs] };
    });
  },
}));
