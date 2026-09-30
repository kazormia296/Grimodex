import { describe, expect, it } from "vitest";
import {
  aggregateZenShaderCadenceRunReports,
  buildZenShaderCadenceRunReport,
  type ZenShaderCadenceRunInput,
} from "./zenShaderCadenceResearchReport";

function baseInput(
  overrides: Partial<ZenShaderCadenceRunInput> = {},
): ZenShaderCadenceRunInput {
  return {
    cadenceMode: "raf-skip-60",
    wallStartedAtMs: 100,
    wallEndedAtMs: 220,
    rafCallbackCount: 5,
    rafTimestampsMs: [100, 110, 130, 160, 200],
    schedulerWakeupCount: 5,
    drawCount: 5,
    drawCallCount: 10,
    drawTimestampsMs: [100, 120, 140, 180, 200],
    frameStart: 1_000,
    frameEnd: 1_120,
    animationElapsedMs: 120,
    animationSpeed: 1,
    visibilityState: "visible",
    focused: true,
    ...overrides,
  };
}

function regularTimestamps(stepMs: number) {
  const timestamps: number[] = [];
  for (let timestamp = stepMs; timestamp <= 1_000; timestamp += stepMs) {
    timestamps.push(timestamp);
  }
  return timestamps;
}

describe("Zen shader cadence run report", () => {
  it("preserves raw timestamps and derives wall rate, refresh Hz, and nearest-rank percentiles", () => {
    const report = buildZenShaderCadenceRunReport(baseInput());

    expect(report).toMatchObject({
      cadenceMode: "raf-skip-60",
      wallDurationMs: 120,
      displayRaf: {
        callbackCount: 5,
        timestampsMs: [100, 110, 130, 160, 200],
        intervalMs: {
          samples: [10, 20, 30, 40],
          summary: { p50: 20, p95: 40, p99: 40, max: 40 },
        },
        inferredHz: 50,
      },
      schedulerWakeupCount: 5,
      draw: {
        count: 5,
        drawCallCount: 10,
        timestampsMs: [100, 120, 140, 180, 200],
        effectiveHz: 5_000 / 120,
        intervalMs: {
          samples: [20, 20, 40, 20],
          summary: { p50: 20, p95: 40, p99: 40, max: 40 },
        },
      },
      skippedRafCount: 0,
      skippedRafRatio: 0,
      frame: {
        start: 1_000,
        end: 1_120,
        advance: 120,
        accountedDurationMs: 120,
        wallCoveragePercent: 100,
        expectedAdvance: 120,
        driftPercent: 0,
      },
      lifecycle: { visibilityState: "visible", focused: true },
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("separates scheduler-accounted animation time from outer wall boundaries", () => {
    const report = buildZenShaderCadenceRunReport(
      baseInput({
        frameEnd: 1_100,
        animationElapsedMs: 100,
      }),
    );

    expect(report.frame).toMatchObject({
      advance: 100,
      accountedDurationMs: 100,
      wallCoveragePercent: (100 / 120) * 100,
      expectedAdvance: 100,
      driftPercent: 0,
    });
  });

  it.each([
    ["rAF count mismatch", { rafCallbackCount: 4 }, /raf|callback|count/i],
    ["draw count mismatch", { drawCount: 4 }, /draw|count/i],
    [
      "non-monotonic rAF timestamps",
      { rafTimestampsMs: [100, 110, 105, 160, 200] },
      /raf|timestamp|monotonic|increasing/i,
    ],
    [
      "draw timestamp outside the wall interval",
      { drawTimestampsMs: [99, 120, 140, 180, 200] },
      /draw|timestamp|wall|range/i,
    ],
    ["empty wall interval", { wallEndedAtMs: 100 }, /wall|duration|end/i],
  ] as const)("rejects %s", (_label, overrides, expected) => {
    expect(() => buildZenShaderCadenceRunReport(baseInput(overrides))).toThrow(
      expected,
    );
  });

  it("accepts a fully quiescent retained canvas and reports a 100% skipped display opportunity ratio", () => {
    const rafTimestampsMs = regularTimestamps(1_000 / 60);
    const report = buildZenShaderCadenceRunReport(
      baseInput({
        cadenceMode: "stopped-retained",
        wallStartedAtMs: 0,
        wallEndedAtMs: 1_000,
        rafCallbackCount: rafTimestampsMs.length,
        rafTimestampsMs,
        schedulerWakeupCount: 0,
        drawCount: 0,
        drawCallCount: 0,
        drawTimestampsMs: [],
        frameStart: 250,
        frameEnd: 250,
        animationElapsedMs: 0,
        animationSpeed: 0,
      }),
    );

    expect(report.draw).toMatchObject({
      count: 0,
      drawCallCount: 0,
      effectiveHz: 0,
      intervalMs: null,
    });
    expect(report.skippedRafCount).toBe(rafTimestampsMs.length);
    expect(report.skippedRafRatio).toBe(1);
    expect(report.frame).toEqual({
      start: 250,
      end: 250,
      advance: 0,
      accountedDurationMs: 0,
      wallCoveragePercent: 0,
      expectedAdvance: 0,
      driftPercent: 0,
    });
  });

  it.each([
    ["scheduler wakeup", { schedulerWakeupCount: 1 }],
    [
      "GPU draw",
      {
        drawCount: 1,
        drawCallCount: 2,
        drawTimestampsMs: [500],
      },
    ],
    ["draw call", { drawCallCount: 1 }],
    ["frame advance", { frameEnd: 251 }],
    ["animation speed", { animationSpeed: 1 }],
  ] as const)(
    "rejects stopped-retained with a non-zero %s",
    (_label, state) => {
      const rafTimestampsMs = regularTimestamps(20);
      expect(() =>
        buildZenShaderCadenceRunReport(
          baseInput({
            cadenceMode: "stopped-retained",
            wallStartedAtMs: 0,
            wallEndedAtMs: 1_000,
            rafCallbackCount: rafTimestampsMs.length,
            rafTimestampsMs,
            schedulerWakeupCount: 0,
            drawCount: 0,
            drawCallCount: 0,
            drawTimestampsMs: [],
            frameStart: 250,
            frameEnd: 250,
            animationElapsedMs: 0,
            animationSpeed: 0,
            ...state,
          }),
        ),
      ).toThrow(/stopped|quiescent|zero/i);
    },
  );
});

describe("Zen shader cadence run aggregation", () => {
  function regularRun(drawStepMs: number) {
    const rafTimestampsMs = regularTimestamps(10);
    const drawTimestampsMs = regularTimestamps(drawStepMs);
    return buildZenShaderCadenceRunReport(
      baseInput({
        wallStartedAtMs: 0,
        wallEndedAtMs: 1_000,
        rafCallbackCount: rafTimestampsMs.length,
        rafTimestampsMs,
        schedulerWakeupCount: rafTimestampsMs.length,
        drawCount: drawTimestampsMs.length,
        drawCallCount: drawTimestampsMs.length * 2,
        drawTimestampsMs,
        frameStart: 0,
        frameEnd: 1_000,
        animationElapsedMs: 1_000,
        animationSpeed: 1,
      }),
    );
  }

  it("uses each run as the statistical unit and reports median/min/max ranges", () => {
    const aggregate = aggregateZenShaderCadenceRunReports([
      regularRun(20),
      regularRun(25),
      regularRun(50),
    ]);

    expect(aggregate).toEqual({
      cadenceMode: "raf-skip-60",
      runCount: 3,
      displayRafHz: { median: 100, min: 100, max: 100 },
      effectiveDrawHz: { median: 40, min: 20, max: 50 },
      drawIntervalP95Ms: { median: 25, min: 20, max: 50 },
      skippedRafRatio: { median: 0.6, min: 0.5, max: 0.8 },
      frameDriftPercent: { median: 0, min: 0, max: 0 },
    });
  });

  it("rejects empty or mixed-mode run collections", () => {
    expect(() => aggregateZenShaderCadenceRunReports([])).toThrow(
      /run|empty|required/i,
    );

    const active = regularRun(20);
    const stopped = buildZenShaderCadenceRunReport({
      ...baseInput(),
      cadenceMode: "stopped-retained",
      schedulerWakeupCount: 0,
      drawCount: 0,
      drawCallCount: 0,
      drawTimestampsMs: [],
      frameEnd: 1_000,
      frameStart: 1_000,
      animationElapsedMs: 0,
      animationSpeed: 0,
    });
    expect(() =>
      aggregateZenShaderCadenceRunReports([active, stopped]),
    ).toThrow(/mode|cadence|mixed/i);
  });
});
