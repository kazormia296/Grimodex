import { describe, it, expect } from "vitest";
import { computeThreadRuns } from "./plotThreadRuns";

const S = (...n: number[]) => new Set(n);

describe("computeThreadRuns", () => {
  it("離脱/流入が無ければ lo..hi の単一 run", () => {
    expect(computeThreadRuns(0, 3, S(), S(), S(0, 3))).toEqual([
      { start: 0, end: 3, rampOutEnd: false },
    ]);
  });

  it("離脱列で run が切れ、マーカー列で再開する（merge-from→再登場）", () => {
    expect(computeThreadRuns(0, 4, S(1), S(), S(0, 4))).toEqual([
      { start: 0, end: 1, rampOutEnd: true },
      { start: 4, end: 4, rampOutEnd: false },
    ]);
  });

  it("流入列(enter=to)で再開する（マーカー無し区間も流入で復帰）", () => {
    expect(computeThreadRuns(0, 4, S(1), S(3), S(0))).toEqual([
      { start: 0, end: 1, rampOutEnd: true },
      { start: 3, end: 4, rampOutEnd: false },
    ]);
  });

  it("流入かつ即離脱は 1 列 run", () => {
    expect(computeThreadRuns(0, 3, S(1, 3), S(3), S(0))).toEqual([
      { start: 0, end: 1, rampOutEnd: true },
      { start: 3, end: 3, rampOutEnd: true },
    ]);
  });

  it("lo で即離脱（最初の列が leave）", () => {
    expect(computeThreadRuns(0, 2, S(0), S(), S(2))).toEqual([
      { start: 0, end: 0, rampOutEnd: true },
      { start: 2, end: 2, rampOutEnd: false },
    ]);
  });
});
