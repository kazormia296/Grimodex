import { describe, expect, it, vi } from "vitest";
import {
  ZenGpuTimerSampler,
  type ZenGpuPass,
  type ZenGpuTimerBackend,
} from "./zenGpuTimerSampler";

const ALL_PASSES = [
  "scene",
  "downsample",
  "gaussianHorizontal",
  "gaussianVertical",
  "composite",
] as const satisfies readonly ZenGpuPass[];

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
  passes: readonly ZenGpuPass[] = ALL_PASSES,
): void {
  sampler.beginFrame(drawCount);
  for (const pass of passes) sampler.measure(pass, () => undefined);
  sampler.endFrame();
}

describe("ZenGpuTimerSampler", () => {
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
      ALL_PASSES.filter((pass) => pass !== "downsample"),
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
        composite: 5,
      },
      gpuTimingStatus: "ready",
    });
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

  it("keeps published timing when polling without a pending query", () => {
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
