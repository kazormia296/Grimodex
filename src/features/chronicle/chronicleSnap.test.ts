import { describe, it, expect } from "vitest";
import { snapDayToTicks } from "./chronicleSnap";

describe("snapDayToTicks", () => {
  const ticks = [0, 7, 14, 21, 28];
  it("閾値内なら最近傍の目盛りへ吸着", () => {
    expect(snapDayToTicks(6.4, ticks, 1)).toBe(7);
    expect(snapDayToTicks(13.7, ticks, 1)).toBe(14);
  });
  it("閾値外なら整数日へ丸める", () => {
    expect(snapDayToTicks(10.2, ticks, 1)).toBe(10);
    expect(snapDayToTicks(3.6, ticks, 1)).toBe(4);
  });
  it("目盛りが空なら整数日へ丸める", () => {
    expect(snapDayToTicks(12.3, [], 5)).toBe(12);
  });
  it("負の日も扱える", () => {
    expect(snapDayToTicks(-0.3, ticks, 1)).toBe(0);
    expect(snapDayToTicks(-5.4, ticks, 1)).toBe(-5);
  });
});
