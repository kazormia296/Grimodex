// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadProjectAttributionStatsMock } = vi.hoisted(() => ({
  loadProjectAttributionStatsMock: vi.fn(),
}));

vi.mock("./projectStats", () => ({
  loadProjectAttributionStats: loadProjectAttributionStatsMock,
}));

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

import { loadBatchAiRatio } from "./api";

function stats(ai: number, total: number) {
  return {
    human: Math.max(0, total - ai),
    ai,
    unknown: 0,
    unmarked: 0,
    total,
    modelBreakdown: {},
  };
}

describe("loadBatchAiRatio delegation contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes nodeIds verbatim to loadProjectAttributionStats", async () => {
    loadProjectAttributionStatsMock.mockResolvedValue({});

    await loadBatchAiRatio(["s1", "s2", "s3"]);

    expect(loadProjectAttributionStatsMock).toHaveBeenCalledExactlyOnceWith([
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("maps stats to rounded ai percentage and omits total 0", async () => {
    loadProjectAttributionStatsMock.mockResolvedValue({
      s1: stats(1, 3), // 33.33... → 33
      s2: stats(2, 3), // 66.66... → 67
      s3: stats(0, 0), // 空シーン → 省略
    });

    const result = await loadBatchAiRatio(["s1", "s2", "s3"]);

    expect(result).toEqual({ s1: 33, s2: 67 });
  });

  it("does not query for empty input", async () => {
    const result = await loadBatchAiRatio([]);

    expect(result).toEqual({});
    expect(loadProjectAttributionStatsMock).not.toHaveBeenCalled();
  });
});
