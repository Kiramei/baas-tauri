export const PC_DEFAULT_METHODS = {
  screenshot_method: "mss",
  control_method: "pyautogui",
} as const;

export function pcMethodOptions(
  selected: string,
  kind: "screenshot" | "control",
  available: boolean
) {
  const valid = kind === "screenshot" ? ["mss", "pyautogui"] : ["pyautogui"];
  return [...new Set([...valid, ...(selected ? [selected] : [])])].map((value) => ({
    value,
    disabled: !available || !valid.includes(value),
  }));
}

export const validPcMethods = (screenshot: string, control: string): boolean =>
  ["mss", "pyautogui"].includes(screenshot) && control === "pyautogui";
