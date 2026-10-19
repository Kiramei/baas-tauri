/** Existing positional count fields use CSV integers or the literal `max`. */
export function readSweepCountTokens(value: unknown, length: number): string[] | null {
  if (typeof value !== "string") return null;
  const tokens = value.split(",");
  return tokens.length === length &&
    tokens.every(
      (token) => token === "max" || token.trim() === "" || /^[+-]?\d+$/.test(token.trim())
    )
    ? tokens
    : null;
}

export function isSweepCountStringValid(value: unknown, length: number): boolean {
  const tokens = readSweepCountTokens(value, length);
  return tokens !== null && tokens.every((token) => token.trim() !== "");
}

/** Replace one entry while preserving every untouched token, including its original spacing. */
export function replaceSweepCountToken(
  value: string,
  length: number,
  index: number,
  replacement: string
): string | null {
  const tokens = readSweepCountTokens(value, length);
  if (!tokens || index < 0 || index >= tokens.length || !Number.isInteger(index)) return null;
  if (replacement !== "max" && replacement !== "" && !/^\d+$/.test(replacement)) return null;
  tokens[index] = replacement;
  return tokens.join(",");
}

export type ActivitySweepCountMode = "skip" | "count" | "share" | "all";
export interface ActivitySweepCount {
  raw: string;
  mode: ActivitySweepCountMode;
  amount: string;
  valid: boolean;
}

/** Activity `-1` means evenly split AP; decimals/fractions are AP shares, never `max`. */
export function readActivitySweepCounts(value: unknown): ActivitySweepCount[] | null {
  if (typeof value !== "string") return null;
  const tokens = value.split(",");
  const result: ActivitySweepCount[] = [];
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === "") {
      result.push({ raw, mode: "count", amount: "", valid: false });
      continue;
    }
    if (token === ".") {
      result.push({ raw, mode: "share", amount: "", valid: false });
      continue;
    }
    if (/^[+-]?\d+$/.test(token)) {
      const number = Number(token);
      if (!Number.isFinite(number)) return null;
      result.push({
        raw,
        mode: tokens.length === 1 && number === -1 ? "all" : number <= 0 ? "skip" : "count",
        amount: token,
        valid: true,
      });
      continue;
    }
    let share: number;
    if (/^[+-]?(?:\d+\.\d*|\.\d+)$/.test(token)) share = Number(token);
    else if (/^[+-]?\d+\/[+-]?\d+$/.test(token)) {
      const [numerator, denominator] = token.split("/").map(Number);
      share = numerator / denominator;
    } else return null;
    if (!Number.isFinite(share) || share < 0) return null;
    const percent = Math.min(share, 1) * 100;
    result.push({ raw, mode: "share", amount: String(Number(percent.toFixed(8))), valid: true });
  }
  return result;
}

export function isActivitySweepCountStringValid(value: unknown): boolean {
  return readActivitySweepCounts(value)?.every(({ valid }) => valid) ?? false;
}

export function activitySweepCountToken(mode: ActivitySweepCountMode, amount = "1"): string | null {
  if (mode === "skip") return "0";
  if (mode === "all") return "-1";
  if (mode === "count") return amount === "" || /^\d+$/.test(amount) ? amount : null;
  if (amount === "") return ".";
  const percent = Number(amount);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const share = Number((percent / 100).toPrecision(15));
  // A decimal point is required: "1" means one sweep, whereas "1.0" means all AP.
  if (Number.isInteger(share)) return `${share}.0`;
  const serialized = String(share);
  if (!serialized.includes("e")) return serialized;
  const [mantissa, exponent] = serialized.split("e-");
  return `0.${"0".repeat(Number(exponent) - 1)}${mantissa.replace(".", "")}`;
}

export function replaceActivitySweepCount(
  value: string,
  index: number,
  replacement: string
): string | null {
  const counts = readActivitySweepCounts(value);
  if (!counts || !Number.isInteger(index) || index < 0 || index >= counts.length) return null;
  if (replacement === "-1" && counts.length !== 1) return null;
  const tokens = counts.map(({ raw }) => raw);
  tokens[index] = replacement;
  const result = tokens.join(",");
  return readActivitySweepCounts(result) ? result : null;
}
