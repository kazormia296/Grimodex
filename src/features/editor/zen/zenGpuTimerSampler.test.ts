import { describe, expect, it, vi } from "vitest";
import {
  ZenGpuTimerSampler,
  type ZenGpuPass,
  type ZenGpuTimingMode,
  type ZenGpuTimerBackend,
} from "./zenGpuTimerSampler";

const GAUSSIAN_PASSES = [
  "scene",
  "downsample",
  "gaussianHorizontal",
  "gaussianVertical",
  "composite",
] as const satisfies readonly ZenGpuPass[];

const ALL_PASSES = [
  "scene",
  "downsample",
  "gaussianHorizontal",
  "gaussianVertical",
  "kawaseDown",
  "kawaseUp",
  "composite",
] as const satisfies readonly ZenGpuPass[];

const GPU_TIMING_MODES = [
  "pass-breakdown",
  "frame",
  "blur",
] as const satisfies readonly ZenGpuTimingMode[];

const ZERO_PASS_TIMES = {
  scene: 0,
  downsample: 0,
  gaussianHorizontal: 0,
  gaussianVertical: 0,
  kawaseDown: 0,
  kawaseUp: 0,
  composite: 0,
} as const;

type FakeQuery = {
  readonly id: number;
  readonly resultNs: number;
  available: boolean;
};

type TimerOperation =
  | "createQuery"
  | "beginQuery"
  | "endQuery"
  | "isResultAvailable"
  | "getResult"
  | "isDisjoint"
  | "deleteQuery";

class FakeZenGpuTimerBackend {
  readonly queries: FakeQuery[] = [];
  readonly deletedQueries: FakeQuery[] = [];
  readonly resultReads: FakeQuery[] = [];
  contextLost = false;
  disjoint = false;

  private readonly plannedResultsNs: number[] = [];
  private readonly failures = new Set<TimerOperation>();

  asBackend(): ZenGpuTimerBackend {
    return this as unknown as ZenGpuTimerBackend;
  }

  queueResultsNs(...resultsNs: number[]): void {
    this.plannedResultsNs.push(...resultsNs);
  }

  failNext(operation: TimerOperation): void {
    this.failures.add(operation);
  }

  markAvailable(queries: readonly FakeQuery[] = this.queries): void {
    for (const query of queries) query.available = true;
  }

  createQuery(): FakeQuery {
    this.throwIfRequested("createQuery");
    const query = {
      id: this.queries.length + 1,
      resultNs: this.plannedResultsNs.shift() ?? 0,
      available: false,
    };
    this.queries.push(query);
    return query;
  }

  beginQuery(_query: FakeQuery): void {
    this.throwIfRequested("beginQuery");
  }

  endQuery(): void {
    this.throwIfRequested("endQuery");
  }

  isResultAvailable(query: FakeQuery): boolean {
    this.throwIfRequested("isResultAvailable");
    return query.available;
  }

  /** Returns elapsed GPU time in nanoseconds, matching the WebGL extension. */
  getResult(query: FakeQuery): number {
    this.throwIfRequested("getResult");
    this.resultReads.push(query);
    return query.resultNs;
  }

  isDisjoint(): boolean {
    this.throwIfRequested("isDisjoint");
    return this.disjoint;
  }

  deleteQuery(query: FakeQuery): void {
    this.throwIfRequested("deleteQuery");
    this.deletedQueries.push(query);
  }

  isContextLost(): boolean {
    return this.contextLost;
  }

  private throwIfRequested(operation: TimerOperation): void {
    if (!this.failures.delete(operation)) return;
    throw new Error(`fake ${operation} failure`);
  }
}

function drawFrame(
  sampler: ZenGpuTimerSampler,
  drawCount: number,
  passes: readonly ZenGpuPass[] = GAUSSIAN_PASSES,
): void {
  sampler.beginFrame(drawCount);
  for (const pass of passes) sampler.measure(pass, () => undefined);
  sampler.endFrame();
}

describe("ZenGpuTimerSampler", () => {
  it("defines pass-breakdown, frame, and blur measurement modes", () => {
    expect(GPU_TIMING_MODES).toEqual(["pass-breakdown", "frame", "blur"]);
  });

  it("reports unsupported null timing when no timer backend is available", () => {
    const sampler = new ZenGpuTimerSampler(null);
    const draw = vi.fn();

    sampler.beginFrame(1);
    sampler.measure("scene", draw);
    sampler.endFrame();
    sampler.poll();

    expect(draw).toHaveBeenCalledOnce();
    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: null,
      gpuPassTimesMs: null,
      gpuTimingStatus: "unsupported",
      gpuTimingSampleCount: 0,
      gpuTimingSampleDrawCount: null,
    });
  });

  it("publishes all five nanosecond pass results atomically in milliseconds", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(
      1_000_000,
      2_000_000,
      3_000_000,
      4_000_000,
      5_000_000,
    );
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    drawFrame(sampler, 1);
    backend.markAvailable(backend.queries.slice(0, 4));
    sampler.poll();

    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: null,
      gpuPassTimesMs: null,
      gpuTimingStatus: "pending",
      gpuTimingSampleCount: 0,
      gpuTimingSampleDrawCount: null,
    });

    backend.markAvailable(backend.queries.slice(4));
    sampler.poll();

    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: 15,
      gpuPassTimesMs: {
        scene: 1,
        downsample: 2,
        gaussianHorizontal: 3,
        gaussianVertical: 4,
        kawaseDown: 0,
        kawaseUp: 0,
        composite: 5,
      },
      gpuTimingStatus: "ready",
      gpuTimingSampleCount: 1,
      gpuTimingSampleDrawCount: 1,
    });
  });

  it("records an omitted pass as zero without creating a query for it", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(1_000_000, 3_000_000, 4_000_000, 5_000_000);
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    drawFrame(
      sampler,
      1,
      GAUSSIAN_PASSES.filter((pass) => pass !== "downsample"),
    );
    backend.markAvailable();
    sampler.poll();

    expect(backend.queries).toHaveLength(4);
    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: 13,
      gpuPassTimesMs: {
        scene: 1,
        downsample: 0,
        gaussianHorizontal: 3,
        gaussianVertical: 4,
        kawaseDown: 0,
        kawaseUp: 0,
        composite: 5,
      },
      gpuTimingStatus: "ready",
    });
  });

  it("retains and atomically sums repeated measurements for one pass", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(
      1_000_000,
      2_000_000,
      3_000_000,
      5_000_000,
      7_000_000,
      11_000_000,
    );
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    sampler.beginFrame(1);
    sampler.measure("scene", () => undefined);
    sampler.measure("kawaseDown", () => undefined);
    sampler.measure("kawaseDown", () => undefined);
    sampler.measure("kawaseUp", () => undefined);
    sampler.measure("kawaseUp", () => undefined);
    sampler.measure("composite", () => undefined);
    sampler.endFrame();

    expect(backend.queries).toHaveLength(6);
    expect(backend.deletedQueries).toHaveLength(0);

    backend.markAvailable(backend.queries.slice(0, 5));
    sampler.poll();
    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: null,
      gpuPassTimesMs: null,
      gpuTimingStatus: "pending",
    });

    backend.markAvailable(backend.queries.slice(5));
    sampler.poll();
    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: 29,
      gpuPassTimesMs: {
        scene: 1,
        downsample: 0,
        gaussianHorizontal: 0,
        gaussianVertical: 0,
        kawaseDown: 5,
        kawaseUp: 12,
        composite: 11,
      },
      gpuTimingStatus: "ready",
    });
    expect(sampler.getBenchmarkReport().samples[0]).toMatchObject({
      gpuTimeMs: 29,
      blurGpuTimeMs: 17,
    });
  });

  it("records one frame-scope query as total GPU time without pass or blur attribution", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(17_000_000);
    const sampler = new ZenGpuTimerSampler(backend.asBackend(), {
      measurementMode: "frame",
    });
    const sceneDraw = vi.fn();
    const compositeDraw = vi.fn();

    sampler.beginFrame(41);
    const result = sampler.measureScope("frame", () => {
      sampler.measure("scene", sceneDraw);
      sampler.measure("composite", compositeDraw);
      return "frame-result";
    });
    sampler.endFrame();

    expect(result).toBe("frame-result");
    expect(sceneDraw).toHaveBeenCalledOnce();
    expect(compositeDraw).toHaveBeenCalledOnce();
    expect(backend.queries).toHaveLength(1);

    backend.markAvailable();
    sampler.poll();

    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: 17,
      gpuPassTimesMs: ZERO_PASS_TIMES,
      gpuTimingStatus: "ready",
      gpuTimingSampleCount: 1,
      gpuTimingSampleDrawCount: 41,
    });
    expect(sampler.getBenchmarkReport().samples).toEqual([
      {
        drawCount: 41,
        gpuTimeMs: 17,
        blurGpuTimeMs: 0,
        gpuPassTimesMs: ZERO_PASS_TIMES,
      },
    ]);
  });

  it("records one blur-scope query as both total and blur GPU time without pass attribution", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(23_000_000);
    const sampler = new ZenGpuTimerSampler(backend.asBackend(), {
      measurementMode: "blur",
    });
    const sceneDraw = vi.fn();
    const downsampleDraw = vi.fn();
    const horizontalDraw = vi.fn();
    const verticalDraw = vi.fn();
    const compositeDraw = vi.fn();

    sampler.beginFrame(73);
    sampler.measure("scene", sceneDraw);
    const result = sampler.measureScope("blur", () => {
      sampler.measure("downsample", downsampleDraw);
      sampler.measure("gaussianHorizontal", horizontalDraw);
      sampler.measure("gaussianVertical", verticalDraw);
      return "blur-result";
    });
    sampler.measure("composite", compositeDraw);
    sampler.endFrame();

    expect(result).toBe("blur-result");
    expect(sceneDraw).toHaveBeenCalledOnce();
    expect(downsampleDraw).toHaveBeenCalledOnce();
    expect(horizontalDraw).toHaveBeenCalledOnce();
    expect(verticalDraw).toHaveBeenCalledOnce();
    expect(compositeDraw).toHaveBeenCalledOnce();
    expect(backend.queries).toHaveLength(1);

    backend.markAvailable();
    sampler.poll();

    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: 23,
      gpuPassTimesMs: ZERO_PASS_TIMES,
      gpuTimingStatus: "ready",
      gpuTimingSampleCount: 1,
      gpuTimingSampleDrawCount: 73,
    });
    expect(sampler.getBenchmarkReport().samples).toEqual([
      {
        drawCount: 73,
        gpuTimeMs: 23,
        blurGpuTimeMs: 23,
        gpuPassTimesMs: ZERO_PASS_TIMES,
      },
    ]);
  });

  it("samples the first frame and then every thirtieth draw", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(...Array<number>(10).fill(1_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    drawFrame(sampler, 1);
    backend.markAvailable();
    sampler.poll();

    for (let drawCount = 2; drawCount <= 30; drawCount += 1) {
      drawFrame(sampler, drawCount);
    }
    expect(backend.queries).toHaveLength(5);

    drawFrame(sampler, 31);
    expect(backend.queries).toHaveLength(10);
  });

  it("does not poll WebGL state on non-sampled frames without pending queries", () => {
    const backend = new FakeZenGpuTimerBackend();
    const isContextLost = vi.spyOn(backend, "isContextLost");
    const isDisjoint = vi.spyOn(backend, "isDisjoint");
    backend.queueResultsNs(...Array<number>(5).fill(1_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    drawFrame(sampler, 1);
    backend.markAvailable();
    sampler.poll();
    const contextReadCount = isContextLost.mock.calls.length;
    const disjointReadCount = isDisjoint.mock.calls.length;

    for (let drawCount = 2; drawCount <= 30; drawCount += 1) {
      drawFrame(sampler, drawCount);
    }

    expect(isContextLost).toHaveBeenCalledTimes(contextReadCount);
    expect(isDisjoint).toHaveBeenCalledTimes(disjointReadCount);
  });

  it("keeps published timing when polling without pending queries", () => {
    const backend = new FakeZenGpuTimerBackend();
    const isContextLost = vi.spyOn(backend, "isContextLost");
    const isDisjoint = vi.spyOn(backend, "isDisjoint");
    backend.queueResultsNs(...Array<number>(5).fill(1_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    drawFrame(sampler, 1);
    backend.markAvailable();
    sampler.poll();
    const readySnapshot = sampler.getSnapshot();
    const contextReadCount = isContextLost.mock.calls.length;
    const disjointReadCount = isDisjoint.mock.calls.length;
    backend.disjoint = true;

    sampler.poll();

    expect(isContextLost).toHaveBeenCalledTimes(contextReadCount);
    expect(isDisjoint).toHaveBeenCalledTimes(disjointReadCount);
    expect(sampler.getSnapshot()).toEqual(readySnapshot);
  });

  it("preserves the last result and retries when a new sample starts disjoint", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(...Array<number>(10).fill(1_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    drawFrame(sampler, 1);
    backend.markAvailable();
    sampler.poll();

    backend.disjoint = true;
    drawFrame(sampler, 31);

    expect(backend.queries).toHaveLength(5);
    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: 5,
      gpuTimingStatus: "disjoint",
      gpuTimingSampleCount: 1,
      gpuTimingSampleDrawCount: 1,
    });

    backend.disjoint = false;
    drawFrame(sampler, 32);
    const retryBatch = backend.queries.slice(5);
    backend.markAvailable(retryBatch);
    sampler.poll();

    expect(retryBatch).toHaveLength(5);
    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: 5,
      gpuTimingStatus: "ready",
      gpuTimingSampleCount: 2,
      gpuTimingSampleDrawCount: 32,
    });
  });

  it("keeps at most one query batch pending", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(...Array<number>(10).fill(1_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    drawFrame(sampler, 1);
    drawFrame(sampler, 31);
    drawFrame(sampler, 61);

    expect(backend.queries).toHaveLength(5);
    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: null,
      gpuTimingStatus: "pending",
      gpuTimingSampleCount: 0,
    });
  });

  it("samples every draw while the configured pending-batch capacity remains", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(...Array<number>(20).fill(1_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend(), {
      sampleIntervalDraws: 1,
      maxPendingSamples: 3,
      maxRecordedSamples: 10,
    });

    drawFrame(sampler, 1);
    drawFrame(sampler, 2);
    drawFrame(sampler, 3);
    drawFrame(sampler, 4);

    expect(backend.queries).toHaveLength(15);

    backend.markAvailable(backend.queries.slice(0, 5));
    sampler.poll();
    drawFrame(sampler, 5);

    expect(backend.queries).toHaveLength(20);
    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimingSampleCount: 1,
      gpuTimingSampleDrawCount: 1,
    });
  });

  it("bounds completed benchmark history to maxRecordedSamples", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(...Array<number>(15).fill(1_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend(), {
      sampleIntervalDraws: 1,
      maxPendingSamples: 1,
      maxRecordedSamples: 2,
    });

    for (let drawCount = 1; drawCount <= 3; drawCount += 1) {
      const queryStart = backend.queries.length;
      drawFrame(sampler, drawCount);
      backend.markAvailable(backend.queries.slice(queryStart));
      sampler.poll();
    }

    expect(
      sampler.getBenchmarkReport().samples.map((sample) => sample.drawCount),
    ).toEqual([2, 3]);
    expect(sampler.getSnapshot().gpuTimingSampleCount).toBe(3);
  });

  it("reports and drains raw pass samples with nearest-rank percentiles", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(
      ...[1, 2, 3, 4, 5, 6, 7].map((value) => value * 1_000_000),
      ...[2, 4, 6, 8, 10, 12, 14].map((value) => value * 1_000_000),
      ...[3, 6, 9, 12, 15, 18, 21].map((value) => value * 1_000_000),
    );
    const sampler = new ZenGpuTimerSampler(backend.asBackend(), {
      sampleIntervalDraws: 1,
      maxPendingSamples: 3,
      maxRecordedSamples: 10,
    });

    drawFrame(sampler, 11, ALL_PASSES);
    drawFrame(sampler, 12, ALL_PASSES);
    drawFrame(sampler, 13, ALL_PASSES);
    backend.markAvailable();
    sampler.poll();
    sampler.poll();
    sampler.poll();

    const report = sampler.getBenchmarkReport();
    expect(report).toEqual({
      samples: [
        {
          drawCount: 11,
          gpuTimeMs: 28,
          blurGpuTimeMs: 20,
          gpuPassTimesMs: {
            scene: 1,
            downsample: 2,
            gaussianHorizontal: 3,
            gaussianVertical: 4,
            kawaseDown: 5,
            kawaseUp: 6,
            composite: 7,
          },
        },
        {
          drawCount: 12,
          gpuTimeMs: 56,
          blurGpuTimeMs: 40,
          gpuPassTimesMs: {
            scene: 2,
            downsample: 4,
            gaussianHorizontal: 6,
            gaussianVertical: 8,
            kawaseDown: 10,
            kawaseUp: 12,
            composite: 14,
          },
        },
        {
          drawCount: 13,
          gpuTimeMs: 84,
          blurGpuTimeMs: 60,
          gpuPassTimesMs: {
            scene: 3,
            downsample: 6,
            gaussianHorizontal: 9,
            gaussianVertical: 12,
            kawaseDown: 15,
            kawaseUp: 18,
            composite: 21,
          },
        },
      ],
      summary: {
        gpuTimeMs: { p50: 56, p95: 84, p99: 84 },
        blurGpuTimeMs: { p50: 40, p95: 60, p99: 60 },
        gpuPassTimesMs: {
          scene: { p50: 2, p95: 3, p99: 3 },
          downsample: { p50: 4, p95: 6, p99: 6 },
          gaussianHorizontal: { p50: 6, p95: 9, p99: 9 },
          gaussianVertical: { p50: 8, p95: 12, p99: 12 },
          kawaseDown: { p50: 10, p95: 15, p99: 15 },
          kawaseUp: { p50: 12, p95: 18, p99: 18 },
          composite: { p50: 14, p95: 21, p99: 21 },
        },
      },
    });

    expect(sampler.drainBenchmarkReport()).toEqual(report);
    expect(sampler.getBenchmarkReport()).toEqual({
      samples: [],
      summary: null,
    });
  });

  it("clears the benchmark report on reset", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(...Array<number>(5).fill(1_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend(), {
      sampleIntervalDraws: 1,
      maxPendingSamples: 1,
      maxRecordedSamples: 10,
    });

    drawFrame(sampler, 1);
    backend.markAvailable();
    sampler.poll();
    expect(sampler.getBenchmarkReport().samples).toHaveLength(1);

    sampler.reset();

    expect(sampler.getBenchmarkReport()).toEqual({
      samples: [],
      summary: null,
    });
  });

  it("discards an entire disjoint batch and recovers on a later sample", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(...Array<number>(15).fill(1_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    drawFrame(sampler, 1);
    backend.markAvailable();
    sampler.poll();
    expect(sampler.getSnapshot().gpuTimeMs).toBe(5);

    drawFrame(sampler, 31);
    const disjointBatch = backend.queries.slice(5, 10);
    backend.markAvailable(disjointBatch);
    const resultReadCountBeforeDisjoint = backend.resultReads.length;
    backend.disjoint = true;
    sampler.poll();

    expect(backend.resultReads).toHaveLength(resultReadCountBeforeDisjoint);
    expect(backend.deletedQueries).toEqual(
      expect.arrayContaining(disjointBatch),
    );
    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: null,
      gpuPassTimesMs: null,
      gpuTimingStatus: "disjoint",
    });

    backend.disjoint = false;
    drawFrame(sampler, 61);
    const recoveryBatch = backend.queries.slice(10, 15);
    backend.markAvailable(recoveryBatch);
    sampler.poll();

    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: 5,
      gpuPassTimesMs: {
        scene: 1,
        downsample: 1,
        gaussianHorizontal: 1,
        gaussianVertical: 1,
        kawaseDown: 0,
        kawaseUp: 0,
        composite: 1,
      },
      gpuTimingStatus: "ready",
      gpuTimingSampleDrawCount: 61,
    });
  });

  it("prevents results from queries created before reset from flowing back in", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(...Array<number>(5).fill(99_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    drawFrame(sampler, 1);
    const staleQueries = backend.queries.slice();
    sampler.reset();

    expect(backend.deletedQueries).toEqual(
      expect.arrayContaining(staleQueries),
    );
    backend.markAvailable(staleQueries);
    sampler.poll();
    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: null,
      gpuPassTimesMs: null,
      gpuTimingStatus: "idle",
      gpuTimingSampleCount: 0,
      gpuTimingSampleDrawCount: null,
    });

    backend.queueResultsNs(...Array<number>(5).fill(2_000_000));
    drawFrame(sampler, 1);
    const freshQueries = backend.queries.slice(5);
    backend.markAvailable(freshQueries);
    sampler.poll();

    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: 10,
      gpuTimingStatus: "ready",
      gpuTimingSampleCount: 1,
      gpuTimingSampleDrawCount: 1,
    });
  });

  it.each(["createQuery", "beginQuery", "endQuery"] as const)(
    "continues the draw when %s throws",
    (operation) => {
      const backend = new FakeZenGpuTimerBackend();
      backend.failNext(operation);
      const sampler = new ZenGpuTimerSampler(backend.asBackend());
      const draw = vi.fn();

      sampler.beginFrame(1);
      expect(() => sampler.measure("scene", draw)).not.toThrow();
      expect(() => sampler.endFrame()).not.toThrow();

      expect(draw).toHaveBeenCalledOnce();
    },
  );

  it.each(["isDisjoint", "isResultAvailable", "getResult"] as const)(
    "contains a %s polling failure inside the timer sampler",
    (operation) => {
      const backend = new FakeZenGpuTimerBackend();
      backend.queueResultsNs(...Array<number>(5).fill(1_000_000));
      const sampler = new ZenGpuTimerSampler(backend.asBackend());

      drawFrame(sampler, 1);
      backend.markAvailable();
      backend.failNext(operation);

      expect(() => sampler.poll()).not.toThrow();
      expect(sampler.getSnapshot()).toMatchObject({
        gpuTimeMs: null,
        gpuPassTimesMs: null,
        gpuTimingStatus: "error",
      });
    },
  );

  it("rethrows the draw error without replacing it with a timer error", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.failNext("endQuery");
    const sampler = new ZenGpuTimerSampler(backend.asBackend());
    const drawError = new Error("scene draw failed");

    sampler.beginFrame(1);
    expect(() =>
      sampler.measure("scene", () => {
        throw drawError;
      }),
    ).toThrow(drawError);
  });

  it("does not invoke query cleanup after the WebGL context is lost", () => {
    const backend = new FakeZenGpuTimerBackend();
    backend.queueResultsNs(...Array<number>(5).fill(1_000_000));
    const sampler = new ZenGpuTimerSampler(backend.asBackend());

    drawFrame(sampler, 1);
    backend.contextLost = true;
    sampler.poll();

    expect(sampler.getSnapshot()).toMatchObject({
      gpuTimeMs: null,
      gpuPassTimesMs: null,
      gpuTimingStatus: "context-lost",
    });
    expect(backend.deletedQueries).toHaveLength(0);

    sampler.dispose();
    expect(backend.deletedQueries).toHaveLength(0);
  });
});
