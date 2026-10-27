const DESKTOP_ONLY_METHODS = new Set(["nemu", "mss", "pyautogui", "android_local"]);

/** Keep an imported value visible, while preventing selection of host-only Docker methods. */
export function scriptMethodOptions(methods: unknown, selected: string, webui: boolean) {
  const values = Array.isArray(methods)
    ? methods.filter((value): value is string => typeof value === "string")
    : [];
  const available = webui ? values.filter((value) => !DESKTOP_ONLY_METHODS.has(value)) : values;
  if (selected && !available.includes(selected)) available.push(selected);
  return [...new Set(available)].map((value) => ({
    value,
    disabled: webui && DESKTOP_ONLY_METHODS.has(value),
  }));
}
