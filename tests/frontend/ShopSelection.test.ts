import { describe, expect, test } from "bun:test";
import { toggleShopSlot } from "../../src/shared/ShopSelection";

describe("shop selection slots", () => {
  test("pads a short legacy selection with zero only after an explicit late-slot toggle", () => {
    const original = [1, 0];
    expect(toggleShopSlot(original, 5)).toEqual([1, 0, 0, 0, 0, 1]);
    expect(JSON.stringify(toggleShopSlot(original, 5))).toBe("[1,0,0,0,0,1]");
    expect(original).toEqual([1, 0]);
  });
  test("preserves slot order and trailing values while toggling one item", () => {
    expect(toggleShopSlot([1, 0, 1, 0, 1, 1], 1)).toEqual([1, 1, 1, 0, 1, 1]);
    expect(toggleShopSlot([1, 0, 1, 0, 1, 1], 2)).toEqual([1, 0, 0, 0, 1, 1]);
  });
});
