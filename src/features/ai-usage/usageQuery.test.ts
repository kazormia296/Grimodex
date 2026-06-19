import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

interface Row {
  surface: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

vi.mock("@/db/client", () => ({ db: { select: selectMock } }));

import { getProjectUsageSummary, getProjectUsageInRange } from "./usageQuery";

function setRows(rows: Row[]) {
  selectMock.mockReturnValue({
    from: () => ({ where: () => Promise.resolve(rows) }),
  });
}

describe("getProjectUsageSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty summary (and skips the query) for an empty project id", async () => {
    const s = await getProjectUsageSummary("");
    expect(s.totalCount).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("aggregates totals and per-surface, preferring provider cost over estimate", async () => {
    setRows([
      // provider cost present (not estimated)
      {
        surface: "chat",
        model: "claude-sonnet-4-6",
        tokensIn: 1000,
        tokensOut: 500,
        costUsd: 0.02,
      },
      // no provider cost → estimated: 2000/1e6*3 + 1000/1e6*15 = 0.021
      {
        surface: "chat",
        model: "claude-sonnet-4-6",
        tokensIn: 2000,
        tokensOut: 1000,
        costUsd: null,
      },
      // different surface, estimated (opus 5/25): 100/1e6*5 + 100/1e6*25 = 0.003
      {
        surface: "map_branch",
        model: "claude-opus-4-7",
        tokensIn: 100,
        tokensOut: 100,
        costUsd: null,
      },
    ]);

    const s = await getProjectUsageSummary("p1");
    expect(s.totalCount).toBe(3);
    expect(s.totalTokensIn).toBe(3100);
    expect(s.totalTokensOut).toBe(1600);
    expect(s.anyCostEstimated).toBe(true);
    expect(s.totalCostUsd).toBeCloseTo(0.02 + 0.021 + 0.003, 5);

    const chat = s.bySurface.find((x) => x.surface === "chat");
    expect(chat?.count).toBe(2);
    expect(chat?.costEstimated).toBe(true); // row 2 was estimated
    expect(chat?.costUsd).toBeCloseTo(0.041, 5);
  });

  it("aggregates prompt-cache read/write tokens (null treated as 0)", async () => {
    setRows([
      {
        surface: "chat",
        model: "claude-sonnet-4-6",
        tokensIn: 1500,
        tokensOut: 200,
        costUsd: 0.02,
        cacheReadTokens: 1200,
        cacheWriteTokens: 300,
      },
      {
        surface: "chat",
        model: "claude-sonnet-4-6",
        tokensIn: 800,
        tokensOut: 100,
        costUsd: 0.01,
        cacheReadTokens: 600,
        cacheWriteTokens: null,
      },
      {
        surface: "agent",
        model: "claude-sonnet-4-6",
        tokensIn: 50,
        tokensOut: 50,
        costUsd: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    ]);

    const s = await getProjectUsageSummary("p1");
    expect(s.totalCacheReadTokens).toBe(1800);
    expect(s.totalCacheWriteTokens).toBe(300);

    const chat = s.bySurface.find((x) => x.surface === "chat");
    expect(chat?.cacheReadTokens).toBe(1800);
    expect(chat?.cacheWriteTokens).toBe(300);
  });

  it("counts unmetered rows (no tokens, no cost) without adding cost", async () => {
    setRows([
      {
        surface: "chat",
        model: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
      },
    ]);
    const s = await getProjectUsageSummary("p1");
    expect(s.unmeteredCount).toBe(1);
    expect(s.totalCostUsd).toBe(0);
    expect(s.anyCostEstimated).toBe(false);
  });
});

interface RangeRow {
  createdAt: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

function setRangeRows(rows: RangeRow[]) {
  // getProjectUsageInRange builds .from().where(and(...)) — same shape mock works.
  selectMock.mockReturnValue({
    from: () => ({ where: () => Promise.resolve(rows) }),
  });
}

describe("getProjectUsageInRange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty result (and skips the query) for an empty project id", async () => {
    const r = await getProjectUsageInRange("", "2026-06-01T00:00:00.000Z");
    expect(r.points).toEqual([]);
    expect(r.totalCostUsd).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("maps rows to cost points, preferring provider cost over estimate", async () => {
    setRangeRows([
      {
        createdAt: "2026-06-05T10:00:00.000Z",
        model: "claude-sonnet-4-6",
        tokensIn: 1000,
        tokensOut: 500,
        costUsd: 0.02, // provider value
      },
      {
        // estimated: 2000/1e6*3 + 1000/1e6*15 = 0.021
        createdAt: "2026-06-06T10:00:00.000Z",
        model: "claude-sonnet-4-6",
        tokensIn: 2000,
        tokensOut: 1000,
        costUsd: null,
      },
    ]);

    const r = await getProjectUsageInRange("p1", "2026-06-01T00:00:00.000Z");
    expect(r.points).toHaveLength(2);
    expect(r.points[0].costUsd).toBeCloseTo(0.02, 6);
    expect(r.points[0].estimated).toBe(false);
    expect(r.points[1].costUsd).toBeCloseTo(0.021, 6);
    expect(r.points[1].estimated).toBe(true);
    expect(r.anyCostEstimated).toBe(true);
    expect(r.totalCostUsd).toBeCloseTo(0.041, 6);
  });

  it("treats an unpriceable / unmetered row as cost 0 (still a point)", async () => {
    setRangeRows([
      {
        createdAt: "2026-06-05T10:00:00.000Z",
        model: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
      },
    ]);
    const r = await getProjectUsageInRange("p1", "2026-06-01T00:00:00.000Z");
    expect(r.points).toHaveLength(1);
    expect(r.points[0].costUsd).toBe(0);
    expect(r.totalCostUsd).toBe(0);
    expect(r.anyCostEstimated).toBe(false);
  });
});
