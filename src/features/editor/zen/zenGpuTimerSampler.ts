export type ZenGpuPass =
  | "scene"
  | "downsample"
  | "gaussianHorizontal"
  | "gaussianVertical"
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
  composite: number;
}

export interface ZenGpuTimerSnapshot {
  gpuTimeMs: number | null;
  gpuPassTimesMs: Readonly<ZenGpuPassTimesMs> | null;
  gpuTimingStatus: ZenGpuTimingStatus;
  gpuTimingSampleCount: number;
  gpuTimingSampleDrawCount: number | null;
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
  readonly queries: Map<ZenGpuPass, ZenGpuTimerQuery>;
  sampling: boolean;
}

interface PendingSample {
  readonly drawCount: number;
  readonly queries: ReadonlyMap<ZenGpuPass, ZenGpuTimerQuery>;
}

const SAMPLE_INTERVAL_DRAWS = 30;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const GPU_PASSES: readonly ZenGpuPass[] = [
  "scene",
  "downsample",
  "gaussianHorizontal",
  "gaussianVertical",
  "composite",
];

const emptyPassTimes = (): ZenGpuPassTimesMs => ({
  scene: 0,
  downsample: 0,
  gaussianHorizontal: 0,
  gaussianVertical: 0,
  composite: 0,
});

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
  private currentFrame: FrameSample | null = null;
  private pendingSample: PendingSample | null = null;
  private lastSampleDrawCount: number | null = null;
  private gpuTimeMs: number | null = null;
  private gpuPassTimesMs: ZenGpuPassTimesMs | null = null;
  private gpuTimingStatus: ZenGpuTimingStatus;
  private gpuTimingSampleCount = 0;
  private gpuTimingSampleDrawCount: number | null = null;
  private disposed = false;

  constructor(backend: ZenGpuTimerBackend | null) {
    this.backend = backend;
    this.gpuTimingStatus = backend ? "idle" : "unsupported";
  }

  beginFrame(drawCount: number): boolean {
    if (this.disposed || !this.backend) return false;

    if (this.currentFrame) this.abandonCurrentFrame("error");
    if (this.pendingSample) {
      this.poll();
      if (this.disposed || this.pendingSample) return false;
    }

    if (!this.canSample(drawCount)) return false;

    const contextState = this.readContextState();
    if (contextState !== "available") return false;

    const disjointState = this.readDisjointState();
    if (disjointState !== "clear") {
      if (disjointState === "error") this.clearPublishedTiming();
      this.gpuTimingStatus = disjointState;
      return false;
    }

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

    const previousQuery = frame.queries.get(pass);
    if (previousQuery) this.deleteQueries([previousQuery]);
    frame.queries.set(pass, query);
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

    this.pendingSample = {
      drawCount: frame.drawCount,
      queries: new Map(frame.queries),
    };
    this.gpuTimingStatus = "pending";
  }

  poll(): void {
    const backend = this.backend;
    if (this.disposed || !backend) return;

    const pending = this.pendingSample;
    if (!pending) return;

    const contextState = this.readContextState();
    if (contextState !== "available") return;

    const disjointState = this.readDisjointState();
    if (disjointState === "error") {
      this.failPendingSample();
      return;
    }

    if (disjointState === "disjoint") {
      const pendingQueries = this.takePendingQueries();
      this.clearPublishedTiming();
      this.gpuTimingStatus = "disjoint";
      if (!this.deleteQueries(pendingQueries)) {
        this.gpuTimingStatus = "error";
      }
      return;
    }

    const queries = [...pending.queries.values()];

    try {
      for (const query of queries) {
        if (!backend.isResultAvailable(query)) return;
      }
    } catch {
      this.failPendingSample();
      return;
    }

    const passTimes = emptyPassTimes();
    try {
      for (const [pass, query] of pending.queries) {
        const elapsedNanoseconds = backend.getResult(query);
        if (!Number.isFinite(elapsedNanoseconds) || elapsedNanoseconds < 0) {
          throw new Error("Invalid GPU timer result");
        }
        passTimes[pass] = elapsedNanoseconds / NANOSECONDS_PER_MILLISECOND;
      }
    } catch {
      this.failPendingSample();
      return;
    }

    this.pendingSample = null;
    if (!this.deleteQueries(queries)) {
      this.clearPublishedTiming();
      this.gpuTimingStatus = "error";
      return;
    }

    this.gpuPassTimesMs = passTimes;
    this.gpuTimeMs = GPU_PASSES.reduce(
      (total, pass) => total + passTimes[pass],
      0,
    );
    this.gpuTimingSampleCount += 1;
    this.gpuTimingSampleDrawCount = pending.drawCount;
    this.gpuTimingStatus = "ready";
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

  reset(): void {
    if (this.disposed) return;

    const queries = this.takeAllQueries();
    this.lastSampleDrawCount = null;
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
      drawCount - this.lastSampleDrawCount >= SAMPLE_INTERVAL_DRAWS
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
    this.pendingSample = null;
    this.clearPublishedTiming();
    this.gpuTimingStatus = "context-lost";
    return "lost";
  }

  private readDisjointState(): "clear" | "disjoint" | "error" {
    const backend = this.backend;
    if (!backend) return "error";

    try {
      return backend.isDisjoint() ? "disjoint" : "clear";
    } catch {
      return "error";
    }
  }

  private handleContextError(): void {
    this.currentFrame = null;
    this.pendingSample = null;
    this.clearPublishedTiming();
    this.gpuTimingStatus = "error";
  }

  private abandonCurrentFrame(
    status: ZenGpuTimingStatus,
    additionalQueries: readonly ZenGpuTimerQuery[] = [],
  ): void {
    const frame = this.currentFrame;
    const queries = frame
      ? [...frame.queries.values(), ...additionalQueries]
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

  private failPendingSample(): void {
    const queries = this.takePendingQueries();
    this.clearPublishedTiming();
    this.gpuTimingStatus = "error";
    if (this.readContextState() === "available") this.deleteQueries(queries);
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
    const queries = this.pendingSample
      ? [...this.pendingSample.queries.values()]
      : [];
    this.pendingSample = null;
    return queries;
  }

  private takeAllQueries(): ZenGpuTimerQuery[] {
    const queries = [
      ...(this.currentFrame?.queries.values() ?? []),
      ...(this.pendingSample?.queries.values() ?? []),
    ];
    this.currentFrame = null;
    this.pendingSample = null;
    return queries;
  }

  private clearPublishedTiming(): void {
    this.gpuTimeMs = null;
    this.gpuPassTimesMs = null;
    this.gpuTimingSampleDrawCount = null;
  }
}
