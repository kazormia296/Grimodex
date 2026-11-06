import { describe, expect, it } from "vitest";
import {
  compareCase,
  compareMetric,
  renderMarkdown,
  type RunMetrics,
  type RunRecord,
  type Shape,
} from "./comparison";
import { DIAG_SELECTION_SEED, seededPick } from "./selection";

const metrics = (over: Partial<RunMetrics>): RunMetrics => ({
  observationCount: 3,
  hypothesisCount: 2,
  proposalCount: 2,
  passed: 1,
  truePositive: 10,
  falsePositive: 0,
  falseNegative: 0,
  criticalViolationCount: 0,
  parseFailureCount: 0,
  requiredCovered: 1,
  actualityMatch: 1,
  significanceMatch: 1,
  proposalGateMatch: 1,
  forbiddenClaimed: 0,
  ...over,
});

function run(
  shape: Shape,
  n: number,
  over: Partial<RunMetrics> = {},
  digest = "sha256:aaaaaaaaaaaaaaaa",
): RunRecord {
  return {
    caseId: "c1",
    suiteId: "s",
    shape,
    run: n,
    status: "ok",
    failedCallCount: 0,
    shapeMismatchCount: 0,
    metrics: metrics(over),
    graphDigest: digest,
    dispatches: [
      {
        stage: "narrative_event_synthesize",
        invocationIndex: 0,
        roles: shape === "split" ? ["system", "user"] : ["user"],
        segmentCount: shape === "split" ? 1 : 0,
        responseDigest: "sha256:r",
        inputTokens: 5,
        outputTokens: 6,
        cacheReadTokens: shape === "split" ? 7 : 0,
        cacheWriteTokens: 0,
        stopReason: "end_turn",
        attempts: 1,
        elapsedMs: 1,
      },
    ],
  };
}

describe("compareMetric", () => {
  it("平均差が同じ形の run 間の差の最大以下なら within-noise", () => {
    const result = compareMetric("observationCount", {
      split: [
        run("split", 1, { observationCount: 3 }),
        run("split", 2, { observationCount: 5 }),
      ],
      unsplit: [
        run("unsplit", 1, { observationCount: 4 }),
        run("unsplit", 2, { observationCount: 4 }),
      ],
    });
    expect(result.withinMax).toBe(2);
    expect(result.betweenMeanDiff).toBe(0);
    expect(result.betweenMaxPairDiff).toBe(1);
    expect(result.verdict).toBe("within-noise");
  });

  it("run 間に揺れが無く、形の間に差があれば exceeds-noise", () => {
    const result = compareMetric("hypothesisCount", {
      split: [
        run("split", 1, { hypothesisCount: 2 }),
        run("split", 2, { hypothesisCount: 2 }),
      ],
      unsplit: [
        run("unsplit", 1, { hypothesisCount: 3 }),
        run("unsplit", 2, { hypothesisCount: 3 }),
      ],
    });
    expect(result.withinMax).toBe(0);
    expect(result.betweenMeanDiff).toBe(1);
    expect(result.verdict).toBe("exceeds-noise");
  });

  it("失敗した run があれば incomplete", () => {
    const failed: RunRecord = {
      ...run("split", 2),
      status: "failed",
      metrics: undefined,
      failure: "x",
    };
    const result = compareMetric("passed", {
      split: [run("split", 1), failed],
      unsplit: [run("unsplit", 1), run("unsplit", 2)],
    });
    expect(result.verdict).toBe("incomplete");
    expect(result.values.split).toEqual([1, null]);
  });
});

describe("compareCase / renderMarkdown", () => {
  const runs = [
    run("split", 1),
    run("unsplit", 1),
    run("split", 2),
    run("unsplit", 2, {}, "sha256:bbbbbbbbbbbbbbbb"),
  ];
  const comparison = compareCase("c1", "s", runs);

  it("digest の全一致・usage の合計を出す", () => {
    expect(comparison.graphDigestAllEqual).toBe(false);
    expect(comparison.usage.split.cacheReadTokens).toBe(14);
    expect(comparison.usage.unsplit.cacheReadTokens).toBe(0);
    expect(comparison.usage.split.dispatchCount).toBe(2);
  });

  it("Markdown は件数・digest・usage だけで、diagnostic only と明記する", () => {
    const markdown = renderMarkdown({
      runId: "r",
      model: "m",
      startedAt: "a",
      completedAt: "b",
      cases: [comparison],
      runs,
    });
    expect(markdown).toContain("diagnostic only");
    expect(markdown).toContain("observationCount");
    expect(markdown).toContain("within-noise");
    expect(markdown).toContain("失敗した run: 0 件");
  });
});

describe("seededPick", () => {
  it("同じ種で同じ選び、順序や重複は無い", () => {
    const ids = Array.from({ length: 14 }, (_, i) => `case-${i}`);
    const a = seededPick(ids, 3, `${DIAG_SELECTION_SEED}/micro`);
    const b = seededPick([...ids].reverse(), 3, `${DIAG_SELECTION_SEED}/micro`);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
    expect(() => seededPick(ids, 15, "x")).toThrow(RangeError);
  });
});
