import { describe, expect, it } from "vitest";
import {
  buildZenShaderResearchAbbaSchedule,
  buildZenShaderResearchAbbaSummary,
  type ZenShaderResearchAbbaRun,
  type ZenShaderResearchAbbaSequence,
} from "./zenShaderResearchAbba";

const VARIANTS_BY_SEQUENCE = {
  ABBA: ["raw", "full", "full", "raw"],
  BAAB: ["full", "raw", "raw", "full"],
} as const;

function comparisonRun({
  runIndex,
  sequence,
  p50Delta = 3,
  p95Delta = 4,
  contextId = "context-1",
  resourceEpoch = 7,
}: {
  runIndex: number;
  sequence: ZenShaderResearchAbbaSequence;
  p50Delta?: number;
  p95Delta?: number;
  contextId?: string;
  resourceEpoch?: number;
}): ZenShaderResearchAbbaRun {
  const rawSamples = [
    { p50: 1, p95: 2 },
    { p50: 3, p95: 4 },
  ];
  const fullSamples = rawSamples.map(({ p50, p95 }) => ({
    p50: p50 + p50Delta,
    p95: p95 + p95Delta,
  }));
  let rawIndex = 0;
  let fullIndex = 0;

  return {
    runIndex,
    sequence,
    contextId,
    resourceEpoch,
    blocks: VARIANTS_BY_SEQUENCE[sequence].map((variant, blockIndex) => ({
      blockIndex,
      variant,
      frameGpuTimeMs:
        variant === "raw" ? rawSamples[rawIndex++]! : fullSamples[fullIndex++]!,
    })),
  };
}

describe("Zen shader ABBA research statistics", () => {
  it("builds an even, counterbalanced ABBA/BAAB run schedule", () => {
    expect(buildZenShaderResearchAbbaSchedule(6, "ABBA")).toEqual([
      {
        runIndex: 0,
        sequence: "ABBA",
        variants: ["raw", "full", "full", "raw"],
      },
      {
        runIndex: 1,
        sequence: "BAAB",
        variants: ["full", "raw", "raw", "full"],
      },
      {
        runIndex: 2,
        sequence: "ABBA",
        variants: ["raw", "full", "full", "raw"],
      },
      {
        runIndex: 3,
        sequence: "BAAB",
        variants: ["full", "raw", "raw", "full"],
      },
      {
        runIndex: 4,
        sequence: "ABBA",
        variants: ["raw", "full", "full", "raw"],
      },
      {
        runIndex: 5,
        sequence: "BAAB",
        variants: ["full", "raw", "raw", "full"],
      },
    ]);
    expect(buildZenShaderResearchAbbaSchedule(2, "BAAB")).toEqual([
      {
        runIndex: 0,
        sequence: "BAAB",
        variants: ["full", "raw", "raw", "full"],
      },
      {
        runIndex: 1,
        sequence: "ABBA",
        variants: ["raw", "full", "full", "raw"],
      },
    ]);

    expect(() => buildZenShaderResearchAbbaSchedule(5, "ABBA")).toThrow(
      /even/i,
    );
  });

  it("pairs the two raw and two full blocks before calculating p50/p95 deltas", () => {
    const summary = buildZenShaderResearchAbbaSummary({
      runs: [
        comparisonRun({ runIndex: 0, sequence: "ABBA" }),
        comparisonRun({ runIndex: 1, sequence: "BAAB" }),
      ],
      bootstrapIterations: 500,
      bootstrapSeed: 492,
    });

    expect(summary.runs).toHaveLength(2);
    for (const run of summary.runs) {
      expect(run.paired).toEqual({
        rawFrameGpuTimeMs: { p50: 2, p95: 3 },
        fullFrameGpuTimeMs: { p50: 5, p95: 7 },
        fullMinusRawFrameGpuTimeMs: { p50: 3, p95: 4 },
      });
    }
  });

  it("reports deterministic paired-bootstrap confidence intervals and run signs", () => {
    const runs = Array.from({ length: 6 }, (_, runIndex) =>
      comparisonRun({
        runIndex,
        sequence: runIndex % 2 === 0 ? "ABBA" : "BAAB",
        p50Delta: 1,
        p95Delta: 2,
      }),
    );
    const input = {
      runs,
      confidenceLevel: 0.95,
      bootstrapIterations: 1_000,
      bootstrapSeed: 492,
    } as const;

    const summary = buildZenShaderResearchAbbaSummary(input);
    expect(summary.aggregate.frameGpuTimeDeltaMs).toEqual({
      p50: {
        median: 1,
        ci: {
          method: "paired-bootstrap-percentile",
          confidenceLevel: 0.95,
          iterations: 1_000,
          seed: 492,
          lower: 1,
          upper: 1,
        },
        signs: { positive: 6, negative: 0, zero: 0 },
      },
      p95: {
        median: 2,
        ci: {
          method: "paired-bootstrap-percentile",
          confidenceLevel: 0.95,
          iterations: 1_000,
          seed: 492,
          lower: 2,
          upper: 2,
        },
        signs: { positive: 6, negative: 0, zero: 0 },
      },
    });
    expect(buildZenShaderResearchAbbaSummary(input).aggregate).toEqual(
      summary.aggregate,
    );

    const mixedSigns = buildZenShaderResearchAbbaSummary({
      ...input,
      runs: [2, -1, 0, 3, -2, 1].map((p95Delta, runIndex) =>
        comparisonRun({
          runIndex,
          sequence: runIndex % 2 === 0 ? "ABBA" : "BAAB",
          p50Delta: p95Delta,
          p95Delta,
        }),
      ),
    });
    expect(mixedSigns.aggregate.frameGpuTimeDeltaMs.p95.signs).toEqual({
      positive: 3,
      negative: 2,
      zero: 1,
    });
  });

  it("rejects missing blocks, sequence violations, and mixed contexts", () => {
    const validAbba = comparisonRun({ runIndex: 0, sequence: "ABBA" });
    const validBaab = comparisonRun({ runIndex: 1, sequence: "BAAB" });

    expect(() =>
      buildZenShaderResearchAbbaSummary({
        runs: [{ ...validAbba, blocks: validAbba.blocks.slice(0, 3) }],
      }),
    ).toThrow(/four blocks|missing/i);

    expect(() =>
      buildZenShaderResearchAbbaSummary({
        runs: [
          {
            ...validAbba,
            blocks: [
              validAbba.blocks[0]!,
              { ...validAbba.blocks[1]!, variant: "raw" },
              validAbba.blocks[2]!,
              validAbba.blocks[3]!,
            ],
          },
        ],
      }),
    ).toThrow(/ABBA|sequence|order/i);

    expect(() =>
      buildZenShaderResearchAbbaSummary({
        runs: [validAbba, { ...validBaab, contextId: "context-2" }],
      }),
    ).toThrow(/context/i);

    expect(() =>
      buildZenShaderResearchAbbaSummary({
        runs: [validAbba, { ...validBaab, resourceEpoch: 8 }],
      }),
    ).toThrow(/resource|epoch/i);
  });
});
