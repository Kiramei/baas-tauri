import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Combines conditional classes while resolving Tailwind conflicts. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
