/**
 * Grid drag-and-drop diagnostic logger.
 *
 * Off by default. Toggle from the DevTools console:
 *
 *   gridDndLog.on()      // enable
 *   gridDndLog.off()     // disable
 *   gridDndLog.toggle()  // flip
 *   gridDndLog.status()  // -> boolean
 *
 * State is persisted in localStorage ("grimodex.gridDndLog"), so the setting
 * survives reloads. Output goes to the browser console — no DebugLogViewer
 * integration.
 *
 * Logging at call sites should funnel through `glog(area, message, data?)`,
 * which is a no-op when disabled (so leaving the calls in is essentially free).
 */

const STORAGE_KEY = "grimodex.gridDndLog";

function readInitial(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = readInitial();

function persist(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // localStorage unavailable (private mode, etc.) — keep in-memory only
  }
}

/** Log a Grid DnD diagnostic line. No-op when logging is disabled. */
export function glog(area: string, message: string, data?: unknown): void {
  if (!enabled) return;
  if (data === undefined) {
    console.log(`[GridDnD/${area}] ${message}`);
  } else {
    console.log(`[GridDnD/${area}] ${message}`, data);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Performance instrumentation                                                */
/* ────────────────────────────────────────────────────────────────────────── */
//
// Hot paths during a drag gesture (pointermove → recomputeAxisLock, etc.) fire
// dozens of times per second. Logging each call would flood the console and
// itself skew the measurement.
//
// Strategy:
// - `gperfStart()` is called at DragStart to open a "session". It clears the
//   accumulator and flips the perf flag (only if logging is already enabled).
// - `gperfMark(label, fn)` wraps a synchronous block. Time is accumulated
//   per `label`; nothing logs until flush. Free no-op when logging is off
//   (avoids paying `performance.now()` × 60Hz × N labels).
// - `gperfMarkAsync(label, promise)` records the round-trip time of an async
//   commit (`moveNode`, `moveScenesToChapter`, etc.). Logs inline because the
//   resolution happens after `gperfFlush()`.
// - `gperfFlush(extra?)` dumps the per-label summary (count / total / min /
//   avg / max) as one console.log line at DragEnd. The session flag is reset.
//
// Toggle with the same `gridDndLog.on()` / `off()` controls — there's no
// separate flag because perf data is only useful alongside the diagnostic
// breadcrumbs that `glog` provides.

interface PerfStat {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

const perfStats = new Map<string, PerfStat>();
let perfSessionActive = false;

function recordPerf(label: string, durationMs: number): void {
  const s = perfStats.get(label);
  if (s) {
    s.count++;
    s.totalMs += durationMs;
    if (durationMs < s.minMs) s.minMs = durationMs;
    if (durationMs > s.maxMs) s.maxMs = durationMs;
  } else {
    perfStats.set(label, {
      count: 1,
      totalMs: durationMs,
      minMs: durationMs,
      maxMs: durationMs,
    });
  }
}

/** Open a perf measurement session. Idempotent. */
export function gperfStart(): void {
  perfStats.clear();
  perfSessionActive = enabled;
}

/**
 * Wrap a synchronous block and accumulate its timing under `label`. Returns
 * the wrapped function's result so call sites stay clean. No-op (zero overhead
 * beyond one branch) when the perf session is inactive.
 */
export function gperfMark<T>(label: string, fn: () => T): T {
  if (!perfSessionActive) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    recordPerf(label, performance.now() - t0);
  }
}

/**
 * Measure an async promise's resolution time. Unlike `gperfMark`, the result
 * is logged inline (with the per-call duration) because resolution often
 * happens AFTER `gperfFlush()` — the DragEnd handler kicks off `moveNode` with
 * `void`-fire-and-forget semantics and then flushes the sync session.
 *
 * Returns the same promise so callers can `await` or `void` it as before.
 */
export function gperfMarkAsync<T>(label: string, p: Promise<T>): Promise<T> {
  if (!enabled) return p;
  const t0 = performance.now();
  return p.then(
    (v) => {
      console.log(
        `[GridDnD/perf] ${label} (async) took ${(performance.now() - t0).toFixed(2)}ms`,
      );
      return v;
    },
    (err) => {
      console.log(
        `[GridDnD/perf] ${label} (async) rejected after ${(performance.now() - t0).toFixed(2)}ms`,
        err,
      );
      throw err;
    },
  );
}

/** Dump the per-label summary and close the perf session. */
export function gperfFlush(extra?: unknown): void {
  if (!perfSessionActive) return;
  perfSessionActive = false;
  if (perfStats.size === 0) return;
  const summary: Record<
    string,
    {
      count: number;
      totalMs: string;
      avgMs: string;
      minMs: string;
      maxMs: string;
    }
  > = {};
  for (const [label, s] of perfStats) {
    summary[label] = {
      count: s.count,
      totalMs: s.totalMs.toFixed(2),
      avgMs: (s.totalMs / s.count).toFixed(2),
      minMs: s.minMs.toFixed(2),
      maxMs: s.maxMs.toFixed(2),
    };
  }
  console.log("[GridDnD/perf] drag session summary", extra ?? {}, summary);
  perfStats.clear();
}

export const gridDndLogControl = {
  on(): void {
    enabled = true;
    persist();
    console.log("[GridDnD] logging ON");
  },
  off(): void {
    enabled = false;
    persist();
    console.log("[GridDnD] logging OFF");
  },
  toggle(): boolean {
    enabled = !enabled;
    persist();
    console.log(`[GridDnD] logging ${enabled ? "ON" : "OFF"}`);
    return enabled;
  },
  status(): boolean {
    return enabled;
  },
};

// Expose on window so users can type `gridDndLog.on()` in the DevTools console.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).gridDndLog = gridDndLogControl;
}
