/** Apply a backend JSON-pointer update without mutating snapshots or changing arrays into objects. */
export function applyResourcePatch(document: any, rawKeys: string[], value: unknown): any {
  if (!rawKeys.length || (rawKeys.length === 1 && rawKeys[0] === "")) return value;
  const keys = rawKeys.map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
  const update = (current: any, index: number): any => {
    const key = keys[index];
    const copy = Array.isArray(current) ? [...current] : { ...current };
    if (index === keys.length - 1) {
      if (value === undefined) {
        if (Array.isArray(copy)) copy.splice(Number(key), 1);
        else delete copy[key];
      } else copy[key as any] = value;
    } else copy[key as any] = update(current?.[key], index + 1);
    return copy;
  };
  return update(document, 0);
}
