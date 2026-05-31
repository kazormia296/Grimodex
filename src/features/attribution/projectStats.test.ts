// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbSelectMock } = vi.hoisted(() => ({ dbSelectMock: vi.fn() }));

vi.mock("@/db/client", () => ({
  db: {
    select: dbSelectMock,
  },
}));

import { loadProjectAttributionStats } from "./projectStats";

type SpanRow = {
  nodeId: string | null;
  fromPos: number;
  toPos: number;
  source: string;
  model?: string | null;
};

type NodeCharRow = { id: string; charCount: number };

function setupDb(spanRows: SpanRow[], nodeRows: NodeCharRow[]): void {
  dbSelectMock.mockImplementation((fields?: unknown) => {
    const isCharCountQuery = fields != null && typeof fields === "object";
    return {
      from: () => ({
        where: () => Promise.resolve(isCharCountQuery ? nodeRows : spanRows),
      }),
    };
  });
}

function span(
  nodeId: string,
  fromPos: number,
  toPos: number,
  source: string,
  model?: string,
): SpanRow {
  return { nodeId, fromPos, toPos, source, model };
}

describe("loadProjectAttributionStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses char_count as total when there are no spans", async () => {
    setupDb([], [{ id: "s1", charCount: 1000 }]);

    const result = await loadProjectAttributionStats(["s1"]);

    expect(result.s1).toEqual({
      human: 1000,
      ai: 0,
      unknown: 0,
      unmarked: 0,
      total: 1000,
      modelBreakdown: {},
    });
  });

  it("derives human from total minus ai and unknown spans", async () => {
    setupDb(
      [span("s1", 0, 200, "ai", "gpt-4"), span("s1", 200, 250, "unknown")],
      [{ id: "s1", charCount: 1000 }],
    );

    const result = await loadProjectAttributionStats(["s1"]);

    expect(result.s1).toEqual({
      human: 750,
      ai: 200,
      unknown: 50,
      unmarked: 0,
      total: 1000,
      modelBreakdown: { "gpt-4": 200 },
    });
  });

  it("clips human to zero when ai spans exceed char_count", async () => {
    setupDb([span("s1", 0, 200, "ai")], [{ id: "s1", charCount: 100 }]);

    const result = await loadProjectAttributionStats(["s1"]);

    expect(result.s1?.human).toBe(0);
    expect(result.s1?.ai).toBe(200);
    expect(result.s1?.total).toBe(100);
  });

  it("returns separate stats per scene", async () => {
    setupDb(
      [span("s1", 0, 100, "ai"), span("s2", 0, 50, "unknown")],
      [
        { id: "s1", charCount: 500 },
        { id: "s2", charCount: 300 },
      ],
    );

    const result = await loadProjectAttributionStats(["s1", "s2"]);

    expect(result.s1).toMatchObject({
      total: 500,
      ai: 100,
      unknown: 0,
      human: 400,
    });
    expect(result.s2).toMatchObject({
      total: 300,
      ai: 0,
      unknown: 50,
      human: 250,
    });
  });

  it("returns empty map for empty scene id list", async () => {
    const result = await loadProjectAttributionStats([]);
    expect(result).toEqual({});
    expect(dbSelectMock).not.toHaveBeenCalled();
  });
});
