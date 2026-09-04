import type { EventConfig } from "@/types/event";

export type RelationKind = "pre" | "post";
export type Relation = {
  id: string;
  kind: RelationKind;
  source: string;
  target: string;
  owner: string;
  related: string;
};
export type Positions = Record<string, { x: number; y: number }>;
export type GraphError = "selfLink" | "duplicate" | "cycle" | "unknown" | "portMismatch";

export function relationsFor(tasks: EventConfig[]): {
  relations: Relation[];
  unknown: string[];
  cyclic: boolean;
} {
  const names = new Set(tasks.map((task) => task.func_name));
  const relations: Relation[] = [];
  const unknown: string[] = [];
  for (const task of tasks) {
    for (const kind of ["pre", "post"] as const) {
      for (const related of task[`${kind}_task`] ?? []) {
        if (!names.has(related)) {
          unknown.push(`${task.func_name} → ${String(related)}`);
          continue;
        }
        const owner = task.func_name;
        const id = JSON.stringify([kind, owner, related]);
        if (!relations.some((relation) => relation.id === id))
          relations.push({
            id,
            kind,
            owner,
            related,
            source: kind === "pre" ? related : owner,
            target: kind === "pre" ? owner : related,
          });
      }
    }
  }
  return {
    relations,
    unknown,
    cyclic: relations.some((edge) => reachable(edge.target, edge.source, relations)),
  };
}

function reachable(start: string, goal: string, edges: Relation[]): boolean {
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === goal) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...edges.filter((edge) => edge.source === current).map((edge) => edge.target));
  }
  return false;
}

export function connectionError(
  tasks: EventConfig[],
  source: string,
  target: string,
  sourceHandle: string | null,
  targetHandle: string | null
): GraphError | null {
  if (sourceHandle !== targetHandle || !["pre", "post"].includes(sourceHandle ?? ""))
    return "portMismatch";
  if (source === target) return "selfLink";
  if (![source, target].every((id) => tasks.some((task) => task.func_name === id)))
    return "unknown";
  const { relations } = relationsFor(tasks);
  if (
    relations.some(
      (edge) => edge.source === source && edge.target === target && edge.kind === sourceHandle
    )
  )
    return "duplicate";
  return reachable(target, source, relations) ? "cycle" : null;
}

/** A narrow JSON patch leaves unrelated records, unknown fields and fractional timestamps intact. */
export function taskFieldPatch(
  tasks: EventConfig[],
  id: string,
  fields: Partial<EventConfig>
): Record<string, unknown> {
  const index = tasks.findIndex((task) => task.func_name === id);
  if (index < 0) return {};
  return Object.fromEntries(
    Object.entries(fields)
      .filter(
        ([key, value]) =>
          JSON.stringify(tasks[index][key as keyof EventConfig]) !== JSON.stringify(value)
      )
      .map(([key, value]) => [`${index}/${key}`, value])
  );
}

export function relationPatch(
  tasks: EventConfig[],
  relation: Pick<Relation, "kind" | "owner" | "related">,
  remove = false
) {
  const field = `${relation.kind}_task` as const;
  const task = tasks.find((task) => task.func_name === relation.owner);
  if (!task) return {};
  const previous = task[field] ?? [];
  return taskFieldPatch(tasks, relation.owner, {
    [field]: remove
      ? previous.filter((id) => id !== relation.related)
      : [...previous, relation.related],
  });
}

/** Connected components occupy separate lanes; dependencies progress left to right. */
export function arrangeTasks(tasks: EventConfig[]): Positions {
  const { relations } = relationsFor(tasks);
  const remaining = new Set(tasks.map((task) => task.func_name));
  const positions: Positions = {};
  let laneY = 40;
  const isolated: string[] = [];
  while (remaining.size) {
    const component = new Set<string>();
    const pending = [remaining.values().next().value!];
    while (pending.length) {
      const id = pending.pop()!;
      if (component.has(id)) continue;
      component.add(id);
      remaining.delete(id);
      for (const edge of relations) {
        if (edge.source === id) pending.push(edge.target);
        if (edge.target === id) pending.push(edge.source);
      }
    }
    const levels = new Map<string, number>();
    if (component.size === 1 && !relations.some((edge) => component.has(edge.source))) {
      isolated.push(...component);
      continue;
    }
    const unplaced = new Set(component);
    while (unplaced.size) {
      const ready = [...unplaced].filter(
        (id) => !relations.some((edge) => edge.target === id && unplaced.has(edge.source))
      );
      // Legacy cycles remain visible, without recursive layout or silently changing the configuration.
      if (!ready.length) ready.push(unplaced.values().next().value!);
      for (const id of ready) {
        const parents = relations
          .filter((edge) => edge.target === id)
          .map((edge) => levels.get(edge.source) ?? -1);
        levels.set(id, Math.max(-1, ...parents) + 1);
        unplaced.delete(id);
      }
    }
    const rows = new Map<number, number>();
    for (const id of component) {
      const level = levels.get(id)!;
      const row = rows.get(level) ?? 0;
      positions[id] = { x: 40 + level * 370, y: laneY + row * 330 };
      rows.set(level, row + 1);
    }
    laneY += Math.max(...rows.values()) * 330 + 40;
  }
  isolated.forEach((id, index) => {
    positions[id] = { x: 40 + (index % 4) * 370, y: laneY + Math.floor(index / 4) * 330 };
  });
  return positions;
}

export function validPositions(value: unknown): Positions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, p]) => p && typeof p === "object" && Number.isFinite(p.x) && Number.isFinite(p.y)
    )
  );
}

export const graphStorageKey = (backend: string, profile: string) =>
  `scheduler.graph.v1:${encodeURIComponent(backend)}:${encodeURIComponent(profile)}`;
