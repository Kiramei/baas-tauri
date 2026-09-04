import { expect, test } from "bun:test";
import { applyResourcePatch } from "../../src/shared/ResourcePatch";

test("event field sync keeps arrays and leaves prior snapshots immutable", () => {
  const previous = [
    { enabled: true, next_tick: 123.125, extra: { keep: true }, pre_task: ["a"] },
    { enabled: false },
  ];
  const updated = applyResourcePatch(previous, ["0", "enabled"], false);
  expect(Array.isArray(updated)).toBe(true);
  expect(updated[0].enabled).toBe(false);
  expect(previous[0].enabled).toBe(true);
  expect(updated[0].next_tick).toBe(123.125);
  expect(updated[1]).toBe(previous[1]);
  const relation = applyResourcePatch(updated, ["0", "pre_task"], ["b"]);
  expect(relation[0].pre_task).toEqual(["b"]);
  expect(updated[0].pre_task).toEqual(["a"]);
});
test("root snapshots, removals and escaped keys preserve JSON-pointer semantics", () => {
  expect(applyResourcePatch([1, 2], [""], [3])).toEqual([3]);
  expect(applyResourcePatch([1, 2], ["0"], undefined)).toEqual([2]);
  expect(applyResourcePatch({ a: 1 }, ["a"], undefined)).toEqual({});
  expect(applyResourcePatch({ "a/b": { "~": 1 } }, ["a~1b", "~0"], 2)).toEqual({
    "a/b": { "~": 2 },
  });
});
