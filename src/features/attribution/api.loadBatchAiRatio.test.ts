// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbSelectMock } = vi.hoisted(() => ({ dbSelectMock: vi.fn() }));

vi.mock("@/db/client", () => ({
  db: {
    select: dbSelectMock,
  },
}));

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { loadBatchAiRatio } from "./api";

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
): SpanRow {
  return { nodeId, fromPos, toPos, source };
}

describe("loadBatchAiRatio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts unmarked body text in the denominator (parity with Attribution panel)", async () => {
    // 旧テキスト等でマークが無い本文 90 字 + AI 10 字。
    // Attribution パネルは ai / charCount = 10% を表示する。
    // バッジ側がマーク付き span 合計を分母にすると 100% に化ける。
    setupDb([span("s1", 0, 10, "ai")], [{ id: "s1", charCount: 100 }]);

    const result = await loadBatchAiRatio(["s1"]);

    expect(result.s1).toBe(10);
  });

  it("matches panel pct when human text is marked", async () => {
    setupDb(
      [span("s1", 0, 30, "ai"), span("s1", 30, 100, "human")],
      [{ id: "s1", charCount: 100 }],
    );

    const result = await loadBatchAiRatio(["s1"]);

    expect(result.s1).toBe(30);
  });

  it("caps at 100% when sceneBeat-internal spans exceed body charCount", async () => {
    // sceneBeat 内テキストは charCount に入らないが spans は覆う。
    // パネル同様 total を ai+unknown まで bump して <=100% を保つ。
    setupDb(
      [span("s1", 0, 200, "ai"), span("s1", 200, 230, "unknown")],
      [{ id: "s1", charCount: 100 }],
    );

    const result = await loadBatchAiRatio(["s1"]);

    expect(result.s1).toBe(Math.round((200 / 230) * 100));
  });

  it("does not count unknown spans as AI", async () => {
    setupDb([span("s1", 0, 50, "unknown")], [{ id: "s1", charCount: 100 }]);

    const result = await loadBatchAiRatio(["s1"]);

    expect(result.s1).toBe(0);
  });

  it("returns 0 (not omitted) for scenes with body text and no AI spans", async () => {
    setupDb([], [{ id: "s1", charCount: 1000 }]);

    const result = await loadBatchAiRatio(["s1"]);

    expect(result.s1).toBe(0);
  });

  it("omits scenes with empty body (charCount 0, no spans)", async () => {
    setupDb([], [{ id: "s1", charCount: 0 }]);

    const result = await loadBatchAiRatio(["s1"]);

    expect(result.s1).toBeUndefined();
  });

  it("returns per-scene ratios for a batch", async () => {
    setupDb(
      [span("s1", 0, 100, "ai"), span("s2", 0, 50, "ai")],
      [
        { id: "s1", charCount: 500 },
        { id: "s2", charCount: 100 },
      ],
    );

    const result = await loadBatchAiRatio(["s1", "s2"]);

    expect(result.s1).toBe(20);
    expect(result.s2).toBe(50);
  });

  it("returns empty map for empty input without querying", async () => {
    const result = await loadBatchAiRatio([]);
    expect(result).toEqual({});
    expect(dbSelectMock).not.toHaveBeenCalled();
  });
});
