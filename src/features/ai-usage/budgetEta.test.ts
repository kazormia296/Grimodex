import { describe, expect, it } from "vitest";
import {
  monthRange,
  computeBudgetEta,
  type BudgetEtaInput,
  type CostPoint,
} from "./budgetEta";

/** ローカル時刻で固定の "now" を作る (テスト決定性のため)。 */
function at(iso: string): Date {
  return new Date(iso);
}

/** ローカル日付 (00:00) の ISO 文字列を返すヘルパ。 */
function localDay(year: number, monthIdx0: number, day: number): string {
  return new Date(year, monthIdx0, day, 12, 0, 0).toISOString();
}

function point(iso: string, costUsd: number): CostPoint {
  return { createdAt: iso, costUsd };
}

function input(partial: Partial<BudgetEtaInput>): BudgetEtaInput {
  return {
    points: [],
    budgetUsd: 0,
    now: at("2026-06-15T12:00:00"),
    ...partial,
  };
}

describe("monthRange", () => {
  it("returns the first instant of the month and the first instant of next month", () => {
    const { startMs, endMs } = monthRange(at("2026-06-15T08:30:00"));
    expect(new Date(startMs).getFullYear()).toBe(2026);
    expect(new Date(startMs).getMonth()).toBe(5); // June (0-indexed)
    expect(new Date(startMs).getDate()).toBe(1);
    expect(new Date(startMs).getHours()).toBe(0);
    // next month start = July 1
    expect(new Date(endMs).getMonth()).toBe(6);
    expect(new Date(endMs).getDate()).toBe(1);
  });

  it("rolls the year over for December", () => {
    const { endMs } = monthRange(at("2026-12-20T00:00:00"));
    expect(new Date(endMs).getFullYear()).toBe(2027);
    expect(new Date(endMs).getMonth()).toBe(0); // January
  });
});

describe("computeBudgetEta — month accumulation", () => {
  it("sums only rows inside the current calendar month", () => {
    const r = computeBudgetEta(
      input({
        now: at("2026-06-15T12:00:00"),
        points: [
          point(localDay(2026, 4, 30), 5), // May → excluded
          point(localDay(2026, 5, 1), 2), // June 1 → included
          point(localDay(2026, 5, 10), 3), // June 10 → included
          point(localDay(2026, 6, 1), 9), // July → excluded
        ],
      }),
    );
    expect(r.monthCostUsd).toBeCloseTo(5, 6);
  });

  it("ignores points with a non-finite or unparseable timestamp", () => {
    const r = computeBudgetEta(
      input({
        now: at("2026-06-15T12:00:00"),
        points: [point("not-a-date", 100), point(localDay(2026, 5, 3), 4)],
      }),
    );
    expect(r.monthCostUsd).toBeCloseTo(4, 6);
  });
});

describe("computeBudgetEta — burn rate & projections", () => {
  it("computes daily burn rate over elapsed days (inclusive of today)", () => {
    // June 1..June 15 = 15 elapsed days. $30 → $2/day.
    const r = computeBudgetEta(
      input({
        now: at("2026-06-15T12:00:00"),
        points: [point(localDay(2026, 5, 5), 30)],
      }),
    );
    expect(r.elapsedDays).toBe(15);
    expect(r.daysInMonth).toBe(30);
    expect(r.dailyRateUsd).toBeCloseTo(2, 6);
    // month-end projection (avg pace) = rate * daysInMonth = $60.
    expect(r.projectedMonthEndUsd).toBeCloseTo(60, 6);
  });

  it("treats the first day of the month as 1 elapsed day (no divide-by-zero)", () => {
    const r = computeBudgetEta(
      input({
        now: at("2026-06-01T00:00:00"),
        points: [point(localDay(2026, 5, 1), 4)],
      }),
    );
    expect(r.elapsedDays).toBe(1);
    expect(r.dailyRateUsd).toBeCloseTo(4, 6);
    expect(Number.isFinite(r.projectedMonthEndUsd)).toBe(true);
  });

  it("recent-pace projection uses the trailing 7-day window", () => {
    // now = June 30. Trailing 7 days = June 24..June 30.
    // Put $14 in that window (→ $2/day) but $100 earlier in the month.
    const r = computeBudgetEta(
      input({
        now: at("2026-06-30T12:00:00"),
        points: [
          point(localDay(2026, 5, 5), 100), // outside 7-day window
          point(localDay(2026, 5, 25), 7),
          point(localDay(2026, 5, 28), 7),
        ],
      }),
    );
    expect(r.recentDailyRateUsd).toBeCloseTo(2, 6);
    // recent-pace month-end = monthCost + recentRate * remainingDays.
    // monthCost = 114, remainingDays after June 30 = 0 → projection == monthCost.
    expect(r.recentProjectedMonthEndUsd).toBeCloseTo(114, 6);
  });

  it("recent-pace month-end adds remaining days at the recent rate", () => {
    // now = June 15. monthCost so far, recent rate projects the rest of June.
    const r = computeBudgetEta(
      input({
        now: at("2026-06-15T12:00:00"),
        points: [
          point(localDay(2026, 5, 9), 10),
          point(localDay(2026, 5, 12), 4), // in 7-day window (June 9..15)
          point(localDay(2026, 5, 10), 10), // in window
        ],
      }),
    );
    // window June 9..15: all three rows (9,10,12) → $24 / 7 ≈ 3.4286/day
    expect(r.recentDailyRateUsd).toBeCloseTo(24 / 7, 6);
    // monthCost = 24, remaining days = 30 - 15 = 15
    expect(r.recentProjectedMonthEndUsd).toBeCloseTo(24 + (24 / 7) * 15, 6);
  });
});

describe("computeBudgetEta — budget consumption & days-left", () => {
  it("computes percent consumed and days until budget hit", () => {
    // budget $60, month cost $30 at $2/day → 50% used, ($60-$30)/$2 = 15 days left.
    const r = computeBudgetEta(
      input({
        now: at("2026-06-15T12:00:00"),
        budgetUsd: 60,
        points: [point(localDay(2026, 5, 5), 30)],
      }),
    );
    expect(r.budgetSet).toBe(true);
    expect(r.percentConsumed).toBeCloseTo(50, 6);
    expect(r.daysUntilBudget).toBeCloseTo(15, 6);
    expect(r.overBudget).toBe(false);
    expect(r.projectedOverBudget).toBe(false); // projected $60 == budget, not over
  });

  it("flags over-budget and clamps days-left to 0 when already exceeded", () => {
    const r = computeBudgetEta(
      input({
        now: at("2026-06-15T12:00:00"),
        budgetUsd: 20,
        points: [point(localDay(2026, 5, 5), 30)],
      }),
    );
    expect(r.overBudget).toBe(true);
    expect(r.percentConsumed).toBeGreaterThan(100);
    expect(r.daysUntilBudget).toBe(0);
  });

  it("flags projected-over-budget when the month-end projection exceeds budget", () => {
    // $30 by June 15 → projected $60. budget $50 → not yet over but projected over.
    const r = computeBudgetEta(
      input({
        now: at("2026-06-15T12:00:00"),
        budgetUsd: 50,
        points: [point(localDay(2026, 5, 5), 30)],
      }),
    );
    expect(r.overBudget).toBe(false);
    expect(r.projectedOverBudget).toBe(true);
  });

  it("returns null days-left when the burn rate is zero (no spend)", () => {
    const r = computeBudgetEta(
      input({
        now: at("2026-06-15T12:00:00"),
        budgetUsd: 60,
        points: [],
      }),
    );
    expect(r.monthCostUsd).toBe(0);
    expect(r.dailyRateUsd).toBe(0);
    expect(r.percentConsumed).toBe(0);
    expect(r.daysUntilBudget).toBeNull();
    expect(r.projectedOverBudget).toBe(false);
  });
});

describe("computeBudgetEta — budget unset (0) boundary", () => {
  it("never flags over-budget and leaves consumption/days-left unset when budget is 0", () => {
    const r = computeBudgetEta(
      input({
        now: at("2026-06-15T12:00:00"),
        budgetUsd: 0,
        points: [point(localDay(2026, 5, 5), 30)],
      }),
    );
    expect(r.budgetSet).toBe(false);
    expect(r.monthCostUsd).toBeCloseTo(30, 6);
    expect(r.percentConsumed).toBeNull();
    expect(r.daysUntilBudget).toBeNull();
    expect(r.overBudget).toBe(false);
    expect(r.projectedOverBudget).toBe(false);
    // burn-rate fields still computed (they don't depend on budget).
    expect(r.dailyRateUsd).toBeCloseTo(2, 6);
  });

  it("treats a negative budget as unset (defensive)", () => {
    const r = computeBudgetEta(
      input({ budgetUsd: -10, points: [point(localDay(2026, 5, 5), 5)] }),
    );
    expect(r.budgetSet).toBe(false);
    expect(r.percentConsumed).toBeNull();
  });
});

describe("computeBudgetEta — defensive numeric guards", () => {
  it("ignores negative or NaN cost values (clamped to 0 contribution)", () => {
    const r = computeBudgetEta(
      input({
        now: at("2026-06-15T12:00:00"),
        points: [
          point(localDay(2026, 5, 5), -5),
          point(localDay(2026, 5, 6), NaN),
          point(localDay(2026, 5, 7), 3),
        ],
      }),
    );
    expect(r.monthCostUsd).toBeCloseTo(3, 6);
    expect(Number.isFinite(r.dailyRateUsd)).toBe(true);
    expect(r.dailyRateUsd).toBeGreaterThanOrEqual(0);
  });

  it("produces only finite, non-negative outputs across the board", () => {
    const r = computeBudgetEta(
      input({
        now: at("2026-06-10T12:00:00"),
        budgetUsd: 100,
        points: [
          point(localDay(2026, 5, 2), 12),
          point(localDay(2026, 5, 8), 8),
        ],
      }),
    );
    for (const v of [
      r.monthCostUsd,
      r.dailyRateUsd,
      r.recentDailyRateUsd,
      r.projectedMonthEndUsd,
      r.recentProjectedMonthEndUsd,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(r.percentConsumed).not.toBeNull();
    expect(Number.isFinite(r.percentConsumed as number)).toBe(true);
  });
});
