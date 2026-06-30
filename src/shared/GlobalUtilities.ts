import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { StringKVMap } from "@/types/app";

/** Handles the cn workflow. */
export const cn = (...inputs: ClassValue[]) => {
  return twMerge(clsx(inputs));
};

/** Returns the is plain object result. */
export const isPlainObject = (v: any) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Handles the deep merge workflow. */
export const deepMerge = <T extends Record<string, any>>(target: T, patch: any): T => {
  if (!isPlainObject(target) || !isPlainObject(patch)) {
    if (Array.isArray(patch)) return patch.slice() as any;
    return patch;
  }

  const out: Record<string, any> = { ...target };
  for (const key of Object.keys(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;

    const prev = target[key];
    const next = patch[key];

    if (isPlainObject(prev) && isPlainObject(next)) {
      out[key] = deepMerge(prev, next);
    } else if (Array.isArray(next)) {
      out[key] = next.slice(); // Replace the entire array to prevent shared references.
    } else {
      out[key] = next; // Overwrite primitive or object values directly.
    }
  }
  return out as T;
};

/** Handles the pause workflow. */
export const pause = (ms: number, label?: string) => {
  return new Promise<void>((resolve) => {
    console.log(`[pause] start${label ? " - " + label : ""}, waiting ${ms}ms`);
    if (ms != Infinity) {
      setTimeout(() => {
        console.log(`[pause] end${label ? " - " + label : ""}`);
        resolve();
      }, ms);
    }
  });
};

/** Returns the format iso to readable result. */
export const formatIsoToReadable = (iso: string): string => {
  const date = new Date(iso);

  /** Handles the pad workflow. */
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");

  return (
    `${date.getFullYear()}-` +
    `${pad(date.getMonth() + 1)}-` +
    `${pad(date.getDate())} ` +
    `${pad(date.getHours())}:` +
    `${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
};

/** Returns the format iso to readable time result. */
export const formatIsoToReadableTime = (iso: string): string => {
  const date = new Date(iso);

  /** Handles the pad workflow. */
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");

  return (
    `${pad(date.getHours())}:` +
    `${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
};

/** Returns the get timestamp result. */
export const getTimestamp = (): number => Math.floor(Date.now() / 1000);

/** Returns the get timestamp ms result. */
export const getTimestampMs = (): number => Date.now();

export const serverMap: StringKVMap = {
  日服: "JP",
  国际服: "Global",
  国际服青少年: "Global",
  韩国ONE: "Global",
  Steam国际服: "Global",
  B服: "CN",
  官服: "CN",
};

export const serverMapSpec: StringKVMap = {
  日服: "JP",
  国际服: "Global_en-us",
  国际服青少年: "Global_en-us",
  韩国ONE: "Global_en-us",
  Steam国际服: "Global_en-us",
  B服: "CN",
  官服: "CN",
};
