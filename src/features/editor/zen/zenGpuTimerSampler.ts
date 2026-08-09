export type ZenGpuPass =
  | "scene"
  | "downsample"
  | "gaussianHorizontal"
  | "gaussianVertical"
  | "kawaseDown"
  | "kawaseUp"
  | "composite";

export type ZenGpuTimingStatus =
  | "unsupported"
  | "idle"
  | "pending"
  | "ready"
  | "disjoint"
  | "error"
  | "context-lost";

export interface ZenGpuPassTimesMs {
  scene: number;
  downsample: number;
  gaussianHorizontal: number;
  gaussianVertical: number;
  kawaseDown: number;
  kawaseUp: number;
  composite: number;
}

export interface ZenGpuTimerSnapshot {
  gpuTimeMs: number | null;
  gpuPassTimesMs: Readonly<ZenGpuPassTimesMs> | null;
  gpuTimingStatus: ZenGpuTimingStatus;
  gpuTimingSampleCount: number;
  gpuTimingSampleDrawCount: number | null;
}

export interface ZenGpuTimerSamplerOptions {
  readonly sampleIntervalDraws?: number;
  readonly maxPendingSamples?: number;
  readonly maxRecordedSamples?: number;
}

export interface ZenGpuTimingPercentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export type ZenGpuPassTimingSummary = Readonly<
  Record<ZenGpuPass, Readonly<ZenGpuTimingPercentiles>>
>;

export interface ZenGpuBenchmarkSample {
  readonly drawCount: number;
  readonly gpuTimeMs: number;
  readonly blurGpuTimeMs: number;
  readonly gpuPassTimesMs: Readonly<ZenGpuPassTimesMs>;
}

export interface ZenGpuBenchmarkSummary {
  readonly gpuTimeMs: Readonly<ZenGpuTimingPercentiles>;
  readonly blurGpuTimeMs: Readonly<ZenGpuTimingPercentiles>;
  readonly gpuPassTimesMs: ZenGpuPassTimingSummary;
}

export interface ZenGpuBenchmarkReport {
  readonly samples: readonly Readonly<ZenGpuBenchmarkSample>[];
  readonly summary: Readonly<ZenGpuBenchmarkSummary> | null;
}

export type ZenGpuTimerQuery = unknown;

export interface ZenGpuTimerBackend<Query = ZenGpuTimerQuery> {
  createQuery(): Query | null;
  beginQuery(query: Query): void;
  endQuery(): void;
  isResultAvailable(query: Query): boolean;
  /** Return the elapsed GPU time in nanoseconds. */
  getResult(query: Query): number;
  isDisjoint(): boolean;
  deleteQuery(query: Query): void;
  isContextLost(): boolean;
}

interface DisjointTimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

interface FrameSample {
  readonly drawCount: number;
  readonly queries: Map<ZenGpuPass, ZenGpuTimerQuery[]>;
  sampling: boolean;
}

interface PendingSample {
  readonly drawCount: number;
  readonly queries: ReadonlyMap<ZenGpuPass, readonly ZenGpuTimerQuery[]>;
}

const DEFAULT_SAMPLE_INTERVAL_DRAWS = 30;
const DEFAULT_MAX_PENDING_SAMPLES = 1;
const DEFAULT_MAX_RECORDED_SAMPLES = 600;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const GPU_PASSES: readonly ZenGpuPass[] = [
  "scene",
  "downsample",
  "gaussianHorizontal",
  "gaussianVertical",
  "kawaseDown",
  "kawaseUp",
  "composite",
];
const BLUR_GPU_PASSES: readonly ZenGpuPass[] = [
  "downsample",
  "gaussianHorizontal",
  "gaussianVertical",
  "kawaseDown",
  "kawaseUp",
];

const emptyPassTimes = (): ZenGpuPassTimesMs => ({
  scene: 0,
  downsample: 0,
  gaussianHorizontal: 0,
  gaussianVertical: 0,
  kawaseDown: 0,
  kawaseUp: 0,
  composite: 0,
});

const normalizePositiveInteger = (
  value: number | undefined,
  fallback: number,
): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;

const flattenQueries = (
  queryGroups: Iterable<readonly ZenGpuTimerQuery[]>,
): ZenGpuTimerQuery[] => [...queryGroups].flatMap((queries) => [...queries]);

const nearestRankPercentiles = (
  values: readonly number[],
): ZenGpuTimingPercentiles => {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;

  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
};

const cloneBenchmarkSample = (
  sample: Readonly<ZenGpuBenchmarkSample>,
): ZenGpuBenchmarkSample => ({
  ...sample,
  gpuPassTimesMs: { ...sample.gpuPassTimesMs },
});

const summarizeBenchmarkSamples = (
  samples: readonly Readonly<ZenGpuBenchmarkSample>[],
): ZenGpuBenchmarkSummary | null => {
  if (samples.length === 0) return null;

  const gpuPassTimesMs = {} as Record<ZenGpuPass, ZenGpuTimingPercentiles>;
  for (const pass of GPU_PASSES) {
    gpuPassTimesMs[pass] = nearestRankPercentiles(
      samples.map((sample) => sample.gpuPassTimesMs[pass]),
    );
  }

  return {
    gpuTimeMs: nearestRankPercentiles(
      samples.map((sample) => sample.gpuTimeMs),
    ),
    blurGpuTimeMs: nearestRankPercentiles(
      samples.map((sample) => sample.blurGpuTimeMs),
    ),
    gpuPassTimesMs,
  };
};

/**
 * Adapts EXT_disjoint_timer_query_webgl2 to the small surface the sampler uses.
 * Extension probing is best-effort so telemetry support can never block drawing.
 */
export function createZenGpuTimerBackend(
  gl: WebGL2RenderingContext,
): ZenGpuTimerBackend<WebGLQuery> | null {
  let extension: DisjointTimerQueryExtension | null;
  try {
    extension = gl.getExtension(
      "EXT_disjoint_timer_query_webgl2",
    ) as DisjointTimerQueryExtension | null;
  } catch {
    return null;
  }
  if (!extension) return null;

  return {
    createQuery: () => gl.createQuery(),
    beginQuery: (query) => gl.beginQuery(extension.TIME_ELAPSED_EXT, query),
    endQuery: () => gl.endQuery(extension.TIME_ELAPSED_EXT),
    isResultAvailable: (query) =>
      Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)),
    getResult: (query) => Number(gl.getQueryParameter(query, gl.QUERY_RESULT)),
    isDisjoint: () => Boolean(gl.getParameter(extension.GPU_DISJOINT_EXT)),
    deleteQuery: (query) => gl.deleteQuery(query),
    isContextLost: () => gl.isContextLost(),
  };
}

export class ZenGpuTimerSampler {
  private readonly backend: ZenGpuTimerBackend | null;
  private readonly sampleIntervalDraws: number;
  private readonly maxPendingSamples: number;
  private readonly maxRecordedSamples: number;
  private currentFrame: FrameSample | null = null;
  private readonly pendingSamples: PendingSample[] = [];
  private readonly recordedSamples: ZenGpuBenchmarkSample[] = [];
  private lastSampleDrawCount: number | null = null;
  private gpuTimeMs: number | null = null;
  private gpuPassTimesMs: ZenGpuPassTimesMs | null = null;
  private gpuTimingStatus: ZenGpuTimingStatus;
  private gpuTimingSampleCount = 0;
  private gpuTimingSampleDrawCount: number | null = null;
  private disposed = false;

  constructor(
    backend: ZenGpuTimerBackend | null,
    options: Readonly<ZenGpuTimerSamplerOptions> = {},
  ) {
    this.backend = backend;
    this.sampleIntervalDraws = normalizePositiveInteger(
      options.sampleIntervalDraws,
      DEFAULT_SAMPLE_INTERVAL_DRAWS,
    );
    this.maxPendingSamples = normalizePositiveInteger(
      options.maxPendingSamples,
      DEFAULT_MAX_PENDING_SAMPLES,
    );
    this.maxRecordedSamples = normalizePositiveInteger(
      options.maxRecordedSamples,
      DEFAULT_MAX_RECORDED_SAMPLES,
    );
    this.gpuTimingStatus = backend ? "idle" : "unsupported";
  }

  beginFrame(drawCount: number): boolean {
    if (this.disposed || !this.backend) return false;

    if (this.currentFrame) this.abandonCurrentFrame("error");
    this.poll();
    if (this.disposed || this.pendingSamples.length >= this.maxPendingSamples) {
      return false;
    }

    const contextState = this.readContextState();
    if (contextState !== "available") return false;
    if (!this.canSample(drawCount)) return false;

    this.lastSampleDrawCount = drawCount;
    this.currentFrame = {
      drawCount,
      queries: new Map(),
      sampling: true,
    };
    return true;
  }

  measure<Result>(pass: ZenGpuPass, draw: () => Result): Result {
    const frame = this.currentFrame;
    const backend = this.backend;
    if (!frame?.sampling || !backend || this.disposed) return draw();

    if (this.readContextState() !== "available") return draw();

    let query: ZenGpuTimerQuery | null = null;
    try {
      query = backend.createQuery();
      if (!query) {
        this.abandonCurrentFrame("error");
        return draw();
      }
      backend.beginQuery(query);
    } catch {
      this.abandonCurrentFrame("error", query ? [query] : []);
      return draw();
    }

    let result: Result;
    try {
      result = draw();
    } catch (drawError) {
      try {
        backend.endQuery();
      } catch {
        // The draw error is the primary failure and must remain observable.
      }
      this.abandonCurrentFrame("error", [query]);
      throw drawError;
    }

    try {
      backend.endQuery();
    } catch {
      this.abandonCurrentFrame("error", [query]);
      return result;
    }

    const passQueries = frame.queries.get(pass);
    if (passQueries) {
      passQueries.push(query);
    } else {
      frame.queries.set(pass, [query]);
    }
    return result;
  }

  endFrame(): void {
    const frame = this.currentFrame;
    this.currentFrame = null;
    if (!frame?.sampling || frame.queries.size === 0) return;

    if (this.readContextState() !== "available") {
      frame.queries.clear();
      return;
    }

    this.pendingSamples.push({
      drawCount: frame.drawCount,
      queries: new Map(
        [...frame.queries].map(([pass, queries]) => [pass, [...queries]]),
      ),
    });
    this.gpuTimingStatus = "pending";
  }

  poll(): void {
    const backend = this.backend;
    if (this.disposed || !backend) return;

    const contextState = this.readContextState();
    if (contextState !== "available") return;

    let disjoint: boolean;
    try {
      disjoint = backend.isDisjoint();
    } catch {
      this.failPendingSamples();
      return;
    }

    if (disjoint) {
      const pendingQueries = this.takePendingQueries();
      this.clearPublishedTiming();
      this.gpuTimingStatus = "disjoint";
      if (!this.deleteQueries(pendingQueries)) {
        this.gpuTimingStatus = "error";
      }
      return;
    }

    while (this.pendingSamples.length > 0) {
      const pending = this.pendingSamples[0];
      const queries = flattenQueries(pending.queries.values());

      try {
        for (const query of queries) {
          if (!backend.isResultAvailable(query)) {
            this.gpuTimingStatus = "pending";
            return;
          }
        }
      } catch {
        this.failPendingSamples();
        return;
      }

      const passTimes = emptyPassTimes();
      try {
        for (const [pass, passQueries] of pending.queries) {
          for (const query of passQueries) {
            const elapsedNanoseconds = backend.getResult(query);
            if (
              !Number.isFinite(elapsedNanoseconds) ||
              elapsedNanoseconds < 0
            ) {
              throw new Error("Invalid GPU timer result");
            }
            passTimes[pass] += elapsedNanoseconds / NANOSECONDS_PER_MILLISECOND;
          }
        }
      } catch {
        this.failPendingSamples();
        return;
      }

      this.pendingSamples.shift();
      if (!this.deleteQueries(queries)) {
        const remainingQueries = this.takePendingQueries();
        this.deleteQueries(remainingQueries);
        this.clearPublishedTiming();
        this.gpuTimingStatus = "error";
        return;
      }

      const gpuTimeMs = GPU_PASSES.reduce(
        (total, pass) => total + passTimes[pass],
        0,
      );
      const blurGpuTimeMs = BLUR_GPU_PASSES.reduce(
        (total, pass) => total + passTimes[pass],
        0,
      );

      this.gpuPassTimesMs = passTimes;
      this.gpuTimeMs = gpuTimeMs;
      this.gpuTimingSampleCount += 1;
      this.gpuTimingSampleDrawCount = pending.drawCount;
      this.gpuTimingStatus = "ready";
      this.recordSample({
        drawCount: pending.drawCount,
        gpuTimeMs,
        blurGpuTimeMs,
        gpuPassTimesMs: passTimes,
      });
    }
  }

  getSnapshot(): ZenGpuTimerSnapshot {
    return {
      gpuTimeMs: this.gpuTimeMs,
      gpuPassTimesMs: this.gpuPassTimesMs ? { ...this.gpuPassTimesMs } : null,
      gpuTimingStatus: this.gpuTimingStatus,
      gpuTimingSampleCount: this.gpuTimingSampleCount,
      gpuTimingSampleDrawCount: this.gpuTimingSampleDrawCount,
    };
  }

  getBenchmarkReport(): ZenGpuBenchmarkReport {
    const samples = this.recordedSamples.map(cloneBenchmarkSample);
    return {
      samples,
      summary: summarizeBenchmarkSamples(samples),
    };
  }

  drainBenchmarkReport(): ZenGpuBenchmarkReport {
    const report = this.getBenchmarkReport();
    this.recordedSamples.length = 0;
    return report;
  }

  reset(): void {
    if (this.disposed) return;

    const queries = this.takeAllQueries();
    this.lastSampleDrawCount = null;
    this.recordedSamples.length = 0;
    this.clearPublishedTiming();
    this.gpuTimingSampleCount = 0;

    if (!this.backend) {
      this.gpuTimingStatus = "unsupported";
      return;
    }

    const contextState = this.readContextState();
    if (contextState === "lost") return;
    if (contextState === "error") return;
    this.gpuTimingStatus = this.deleteQueries(queries) ? "idle" : "error";
  }

  dispose(): void {
    if (this.disposed) return;

    const queries = this.takeAllQueries();
    if (this.backend) {
      const contextState = this.readContextState();
      if (contextState === "available") this.deleteQueries(queries);
    }
    this.disposed = true;
  }

  private canSample(drawCount: number): boolean {
    return (
      this.lastSampleDrawCount === null ||
      drawCount - this.lastSampleDrawCount >= this.sampleIntervalDraws
    );
  }

  private readContextState(): "available" | "lost" | "error" {
    const backend = this.backend;
    if (!backend) return "error";

    try {
      if (!backend.isContextLost()) return "available";
    } catch {
      this.handleContextError();
      return "error";
    }

    this.currentFrame = null;
    this.pendingSamples.length = 0;
    this.clearPublishedTiming();
    this.gpuTimingStatus = "context-lost";
    return "lost";
  }

  private handleContextError(): void {
    this.currentFrame = null;
    this.pendingSamples.length = 0;
    this.clearPublishedTiming();
    this.gpuTimingStatus = "error";
  }

  private abandonCurrentFrame(
    status: ZenGpuTimingStatus,
    additionalQueries: readonly ZenGpuTimerQuery[] = [],
  ): void {
    const frame = this.currentFrame;
    const queries = frame
      ? [...flattenQueries(frame.queries.values()), ...additionalQueries]
      : [...additionalQueries];
    if (frame) {
      frame.queries.clear();
      frame.sampling = false;
    }
    this.clearPublishedTiming();
    this.gpuTimingStatus = status;

    if (
      this.readContextState() === "available" &&
      !this.deleteQueries(queries)
    ) {
      this.gpuTimingStatus = "error";
    }
  }

  private failPendingSamples(): void {
    const queries = this.takePendingQueries();
    this.clearPublishedTiming();
    this.gpuTimingStatus = "error";
    if (this.readContextState() === "available") this.deleteQueries(queries);
  }

  private recordSample(sample: Readonly<ZenGpuBenchmarkSample>): void {
    this.recordedSamples.push(cloneBenchmarkSample(sample));
    const overflow = this.recordedSamples.length - this.maxRecordedSamples;
    if (overflow > 0) this.recordedSamples.splice(0, overflow);
  }

  private deleteQueries(queries: readonly ZenGpuTimerQuery[]): boolean {
    const backend = this.backend;
    if (!backend) return true;

    let succeeded = true;
    for (const query of new Set(queries)) {
      try {
        backend.deleteQuery(query);
      } catch {
        succeeded = false;
      }
    }
    return succeeded;
  }

  private takePendingQueries(): ZenGpuTimerQuery[] {
    const queries = this.pendingSamples.flatMap((pending) =>
      flattenQueries(pending.queries.values()),
    );
    this.pendingSamples.length = 0;
    return queries;
  }

  private takeAllQueries(): ZenGpuTimerQuery[] {
    const queries = [
      ...(this.currentFrame
        ? flattenQueries(this.currentFrame.queries.values())
        : []),
      ...this.pendingSamples.flatMap((pending) =>
        flattenQueries(pending.queries.values()),
      ),
    ];
    this.currentFrame = null;
    this.pendingSamples.length = 0;
    return queries;
  }

  private clearPublishedTiming(): void {
    this.gpuTimeMs = null;
    this.gpuPassTimesMs = null;
    this.gpuTimingSampleDrawCount = null;
  }
}
