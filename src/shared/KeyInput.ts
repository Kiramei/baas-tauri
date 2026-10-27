export type KeyInputError = "required" | "mismatch";

/** Login and rotation share the same whitespace handling. Never persist the returned Key. */
export function validateKeyInput(key: string, confirmation?: string): KeyInputError | null {
  if (!key.trim()) return "required";
  if (confirmation !== undefined && key !== confirmation) return "mismatch";
  return null;
}
