export interface SyncPatchOperation {
  op: string;
  path: string;
  value: unknown;
}

const segments = (path: string): string[] =>
  path === "" || path === "/"
    ? []
    : path
        .slice(1)
        .split("/")
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

/** A parent replacement and a child edit cannot both be replayed in the old order. */
export function syncPathsOverlap(left: string, right: string): boolean {
  const a = segments(left);
  const b = segments(right);
  return a.slice(0, Math.min(a.length, b.length)).every((part, index) => part === b[index]);
}

/** Keep independent fields; an overlapping old parent operation is retired as a whole. */
export function remainingSyncOperations(
  previous: readonly SyncPatchOperation[],
  newer: readonly SyncPatchOperation[]
): SyncPatchOperation[] {
  return previous.filter((operation) =>
    newer.every((next) => !syncPathsOverlap(operation.path, next.path))
  );
}
