import { create } from "zustand";
import { LogItem } from "@/types/app";

interface ProgressInterface {
  progress: number;
  message: string;
}

interface GlobalLogInterface {
  globalLogData: LogItem[];
  terminalLogData: LogItem[];
  globalProgress: ProgressInterface;

  appendGlobalLog: (log: LogItem) => void;

  appendTerminalLog: (log: LogItem) => void;
  setProgress: (progress: ProgressInterface) => void;
}

export const useGlobalLogStore = create<GlobalLogInterface>((set) => ({
  globalLogData: [],
  terminalLogData: [],
  globalProgress: {
    progress: 0,
    message: "Initializing ...",
  },
  appendGlobalLog: (log: LogItem) => {
    set((state) => {
      return { globalLogData: [...state.globalLogData, log] };
    });
  },

  appendTerminalLog: (log: LogItem) => {
    set((state) => {
      return { terminalLogData: [...state.terminalLogData, log] };
    });
  },

  setProgress: (progress: ProgressInterface) => {
    set((state) => ({
      ...state,
      globalProgress: {
        progress: progress.progress,
        message: progress.message,
      },
    }));
  },
}));
