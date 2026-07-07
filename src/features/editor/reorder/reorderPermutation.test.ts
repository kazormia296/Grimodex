import { describe, expect, it } from "vitest";
import {
  currentUnitsFromOrder,
  identityOrder,
  slotAtFlatOffset,
  slotOfOriginal,
  swapSlots,
} from "./reorderPermutation";
import type { ReorderUnit } from "./types";

const U = (from: number, to: number, surface: string): ReorderUnit => ({
  from,
  to,
  surface,
});

// "ABCDEF" を 3 unit に分割: "AB"(0..2) "CDE"(2..5) "F"(5..6)
const units0 = [U(0, 2, "AB"), U(2, 5, "CDE"), U(5, 6, "F")];

describe("identityOrder", () => {
  it("returns [0..n)", () => {
    expect(identityOrder(3)).toEqual([0, 1, 2]);
  });
});

describe("currentUnitsFromOrder", () => {
  it("reconstructs contiguous flat ranges for identity", () => {
    expect(currentUnitsFromOrder(units0, [0, 1, 2])).toEqual(units0);
  });

  it("reconstructs ranges after a permutation, preserving unit lengths/surfaces", () => {
    // order [2,0,1] → 連結 "F"+"AB"+"CDE" = "FABCDE"
    expect(currentUnitsFromOrder(units0, [2, 0, 1])).toEqual([
      U(0, 1, "F"),
      U(1, 3, "AB"),
      U(3, 6, "CDE"),
    ]);
  });
});

describe("slotAtFlatOffset", () => {
  it("finds the slot containing an offset", () => {
    const cur = currentUnitsFromOrder(units0, [2, 0, 1]); // F | AB | CDE
    expect(slotAtFlatOffset(cur, 0)).toBe(0); // F
    expect(slotAtFlatOffset(cur, 2)).toBe(1); // AB
    expect(slotAtFlatOffset(cur, 5)).toBe(2); // CDE
  });

  it("clamps to last slot when offset is at/after end", () => {
    const cur = currentUnitsFromOrder(units0, [0, 1, 2]);
    expect(slotAtFlatOffset(cur, 6)).toBe(2);
    expect(slotAtFlatOffset(cur, 999)).toBe(2);
  });
});

describe("swapSlots / slotOfOriginal", () => {
  it("swaps adjacent slots non-destructively and tracks original index", () => {
    const order = [0, 1, 2];
    const next = swapSlots(order, 0, 1);
    expect(next).toEqual([1, 0, 2]);
    expect(order).toEqual([0, 1, 2]); // 非破壊
    expect(slotOfOriginal(next, 0)).toBe(1);
    expect(slotOfOriginal(next, 1)).toBe(0);
    expect(slotOfOriginal(next, 2)).toBe(2);
  });

  it("dragging original unit 0 to the end via adjacent swaps", () => {
    let order = identityOrder(3);
    // 0 を末尾へ: slot0<->1, slot1<->2
    order = swapSlots(order, 0, 1); // [1,0,2]
    order = swapSlots(order, 1, 2); // [1,2,0]
    expect(order).toEqual([1, 2, 0]);
    expect(slotOfOriginal(order, 0)).toBe(2);
    // 連結は BC... の順で元 surface を保つ
    expect(currentUnitsFromOrder(units0, order).map((u) => u.surface)).toEqual([
      "CDE",
      "F",
      "AB",
    ]);
  });
});
