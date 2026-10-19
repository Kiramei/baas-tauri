import { describe, expect, test } from "bun:test";
import {
  movePriorityEntry,
  priorityDropIndex,
  selectPriorityEntry,
} from "../../src/shared/PriorityOrder";

describe("crafting priority editing preserves backend values", () => {
  test("moves across the whole list in one edit, preserving legacy and duplicate nodes", () => {
    const values = ["Gift", "旧节点", "Gift", "", "Furniture"];
    expect(movePriorityEntry(values, 4, 0)).toEqual(["Furniture", "Gift", "旧节点", "Gift", ""]);
    expect(movePriorityEntry(values, 0, 4)).toEqual(["旧节点", "Gift", "", "Furniture", "Gift"]);
    expect(values).toEqual(["Gift", "旧节点", "Gift", "", "Furniture"]);
    for (const [from, to] of [
      [-1, 0],
      [0, 99],
      [0.5, 2],
      [1, NaN],
    ])
      expect(movePriorityEntry(values, from, to)).toEqual(values);
  });

  test("multi-selection appends new nodes and never drops unrelated unknown values", () => {
    const values = ["旧节点", "Gift", "", "Furniture"];
    expect(selectPriorityEntry(values, "Material", true)).toEqual([...values, "Material"]);
    expect(selectPriorityEntry(values, "Gift", true)).toEqual(values);
    expect(selectPriorityEntry(values, "Gift", false)).toEqual(["旧节点", "", "Furniture"]);
    expect(selectPriorityEntry(["Gift", "Gift", "旧节点"], "Gift", false)).toEqual(["旧节点"]);
  });

  test("pointer insertion supports first, last and wrapped variable-height rows", () => {
    expect(priorityDropIndex(10, [40, 110, 175])).toBe(0);
    expect(priorityDropIndex(80, [40, 110, 175])).toBe(1);
    expect(priorityDropIndex(140, [40, 110, 175])).toBe(2);
    expect(priorityDropIndex(300, [40, 110, 175])).toBe(3);
    expect(priorityDropIndex(100, [])).toBe(0);
  });
});
