// Dev-only performance logger. Detects main-thread blocking (>50ms longtasks)
// via the PerformanceObserver Long Task API and attributes them to the most
// expensive instrumented hot paths that overlapped the longtask window.
//
// Toggle from the browser dev-tools console:
//   enablePerfLog()   // persists across reloads via localStorage
//   disablePerfLog()
//
// Hot paths can opt in to attribution by wrapping work with markStart/markEnd.
// When neither the logger nor a perf session is active, the marks are no-ops.
//
// Programmatic measurement (used by playwright perf harness):
//   startPerfSession()  // begins capturing longtasks, slow events (>16ms), marks
//   endPerfSession()    // returns aggregated PerfSessionResult or null
// Sessions work independently of enable/disable so automation does not need
// to flip localStorage state.

type MarkRecord = { label: string; start: number; duration: number };

type SessionState = {
  startedAt: number;
  longtasks: { startTime: number; duration: number }[];
  slowEvents: { duration: number }[];
  marks: MarkRecord[];
  counters: Map<string, number>;
  eventObserver: PerformanceObserver | null;
};

export type PerfSessionResult = {
  durationMs: number;
  longtask: { count: number; totalMs: number; maxMs: number };
  // Slow events are events whose `duration` exceeds 16ms (one frame) per the
  // Event Timing API. This is NOT "p95 of every keystroke" — it is "p95 of
  // events that already exceeded one frame". Below the threshold the API
  // does not emit entries, by design.
  slowEvent: { count: number; p95Ms: number; maxMs: number };
  topMarks: { label: string; totalMs: number; count: number }[];
  markStats: {
    label: string;
    count: number;
    totalMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  }[];
  counters: Record<string, number>;
};

const STORAGE_KEY = "grimodex.perfLog";
const MAX_MARKS = 300;
const SLOW_EVENT_THRESHOLD_MS = 16;

let enabled = false;
let longtaskObserver: PerformanceObserver | null = null;
let session: SessionState | null = null;
const startTimes = new Map<string, number>();
const recentMarks: MarkRecord[] = [];

export function markStart(label: string): void {
  if (!enabled && !session) return;
  startTimes.set(label, performance.now());
}

export function markEnd(label: string): void {
  if (!enabled && !session) return;
  const start = startTimes.get(label);
  if (start == null) return;
  startTimes.delete(label);
  const duration = performance.now() - start;
  const record: MarkRecord = { label, start, duration };
  recentMarks.push(record);
  if (recentMarks.length > MAX_MARKS) recentMarks.shift();
  if (session) session.marks.push(record);
}

/** Direct mark recording when caller already has duration + start time
 *  (e.g. measured via local performance.now() in a React render body).
 *  Avoids the startTimes map so concurrent re-renders don't strand entries. */
export function recordMark(
  label: string,
  duration: number,
  start: number,
): void {
  if (!enabled && !session) return;
  const record: MarkRecord = { label, start, duration };
  recentMarks.push(record);
  if (recentMarks.length > MAX_MARKS) recentMarks.shift();
  if (session) session.marks.push(record);
}

/** Count discrete operations while a performance session is active. */
export function recordCounter(label: string, increment = 1): void {
  if (!session || !Number.isFinite(increment)) return;
  session.counters.set(label, (session.counters.get(label) ?? 0) + increment);
}

function collectLongtaskEntries(
  entries: PerformanceEntry[],
  target: SessionState | null,
): void {
  for (const entry of entries) {
    if (entry.entryType !== "longtask") continue;
    if (target) {
      target.longtasks.push({
        startTime: entry.startTime,
        duration: entry.duration,
      });
    }
    if (enabled) attributeLongtaskToConsole(entry);
  }
}

function collectEventEntries(
  entries: PerformanceEntry[],
  target: SessionState | null,
): void {
  if (!target) return;
  for (const entry of entries) {
    if (entry.entryType !== "event") continue;
    target.slowEvents.push({ duration: entry.duration });
  }
}

function attributeLongtaskToConsole(entry: PerformanceEntry): void {
  const ltStart = entry.startTime;
  const ltEnd = ltStart + entry.duration;
  const now = performance.now();
  const overlap = recentMarks.filter(
    (m) => m.start + m.duration >= ltStart && m.start <= ltEnd,
  );

  // Aggregate by label so 16 GridSceneCard renders show as one line
  // "gridSceneCard.render=24.5ms (16x, max 2.1ms)" instead of 8 lines.
  const byLabel = new Map<
    string,
    { total: number; count: number; max: number }
  >();
  for (const m of overlap) {
    const cur = byLabel.get(m.label) ?? { total: 0, count: 0, max: 0 };
    cur.total += m.duration;
    cur.count += 1;
    if (m.duration > cur.max) cur.max = m.duration;
    byLabel.set(m.label, cur);
  }
  const top = Array.from(byLabel.entries())
    .sort(([, a], [, b]) => b.total - a.total)
    .slice(0, 8)
    .map(([label, v]) =>
      v.count > 1
        ? `${label}=${v.total.toFixed(1)}ms (${v.count}x, max ${v.max.toFixed(1)}ms)`
        : `${label}=${v.total.toFixed(1)}ms`,
    );

  const inFlight: string[] = [];
  startTimes.forEach((start, label) => {
    if (start <= ltEnd) {
      inFlight.push(`${label}@${(now - start).toFixed(0)}ms-running`);
    }
  });

  const parts: string[] = [];
  if (top.length > 0) parts.push(`marks: ${top.join(", ")}`);
  if (inFlight.length > 0) parts.push(`in-flight: ${inFlight.join(", ")}`);
  if (parts.length === 0) parts.push("no instrumented marks overlapped");

  console.warn(
    `[perfLog] longtask ${entry.duration.toFixed(1)}ms (start=${ltStart.toFixed(0)}) — ${parts.join(" | ")}`,
  );
}

function ensureLongtaskObserver(): void {
  if (longtaskObserver) return;
  if (typeof PerformanceObserver === "undefined") return;
  try {
    longtaskObserver = new PerformanceObserver((list) => {
      collectLongtaskEntries(list.getEntries(), session);
    });
    longtaskObserver.observe({ entryTypes: ["longtask"] });
  } catch (e) {
    if (enabled) console.warn("[perfLog] failed to start longtask observer", e);
    longtaskObserver = null;
  }
}

function maybeStopLongtaskObserver(): void {
  if (enabled || session) return;
  longtaskObserver?.disconnect();
  longtaskObserver = null;
}

export function enablePerfLog(): void {
  if (enabled) return;
  enabled = true;
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // ignore storage failures
  }
  if (typeof PerformanceObserver === "undefined") {
    console.warn("[perfLog] PerformanceObserver not available");
    return;
  }
  ensureLongtaskObserver();
  console.info(
    "[perfLog] enabled. Logs main-thread blocks >50ms. Disable with disablePerfLog().",
  );
}

export function disablePerfLog(): void {
  if (!enabled) return;
  enabled = false;
  try {
    localStorage.setItem(STORAGE_KEY, "0");
  } catch {
    // ignore
  }
  // Keep mark/buffer state if a session is still running; otherwise clear.
  if (!session) {
    startTimes.clear();
    recentMarks.length = 0;
  }
  maybeStopLongtaskObserver();
  console.info("[perfLog] disabled.");
}

export function startPerfSession(): void {
  // Replace any in-progress session — the previous one's results are lost.
  if (session) {
    session.eventObserver?.disconnect();
    session = null;
  }
  const next: SessionState = {
    startedAt: performance.now(),
    longtasks: [],
    slowEvents: [],
    marks: [],
    counters: new Map(),
    eventObserver: null,
  };
  ensureLongtaskObserver();
  if (typeof PerformanceObserver !== "undefined") {
    try {
      const obs = new PerformanceObserver((list) => {
        collectEventEntries(list.getEntries(), session);
      });
      obs.observe({
        type: "event",
        durationThreshold: SLOW_EVENT_THRESHOLD_MS,
        buffered: false,
      } as PerformanceObserverInit);
      next.eventObserver = obs;
    } catch {
      // Event Timing API may not be available; session continues without it.
    }
  }
  session = next;
}

export function endPerfSession(): PerfSessionResult | null {
  const s = session;
  if (!s) return null;
  if (longtaskObserver) {
    collectLongtaskEntries(longtaskObserver.takeRecords(), s);
  }
  if (s.eventObserver) {
    collectEventEntries(s.eventObserver.takeRecords(), s);
  }
  session = null;
  s.eventObserver?.disconnect();
  maybeStopLongtaskObserver();

  const durationMs = performance.now() - s.startedAt;

  const ltCount = s.longtasks.length;
  let ltTotal = 0;
  let ltMax = 0;
  for (const lt of s.longtasks) {
    ltTotal += lt.duration;
    if (lt.duration > ltMax) ltMax = lt.duration;
  }

  const evDurations = s.slowEvents.map((e) => e.duration).sort((a, b) => a - b);
  const evCount = evDurations.length;
  const evMax = evCount ? evDurations[evCount - 1] : 0;
  const evP95 = evCount
    ? evDurations[Math.min(evCount - 1, Math.floor(evCount * 0.95))]
    : 0;

  const byLabel = new Map<string, number[]>();
  for (const m of s.marks) {
    const durations = byLabel.get(m.label) ?? [];
    durations.push(m.duration);
    byLabel.set(m.label, durations);
  }
  const percentile = (values: number[], ratio: number): number =>
    values[
      Math.min(
        values.length - 1,
        Math.max(0, Math.ceil(values.length * ratio) - 1),
      )
    ] ?? 0;
  const markStats = Array.from(byLabel.entries())
    .map(([label, unsorted]) => {
      const durations = [...unsorted].sort((a, b) => a - b);
      const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
      return {
        label,
        count: durations.length,
        totalMs,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        p99Ms: percentile(durations, 0.99),
        maxMs: durations[durations.length - 1] ?? 0,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
  const topMarks = markStats
    .slice(0, 10)
    .map(({ label, totalMs, count }) => ({ label, totalMs, count }));

  return {
    durationMs,
    longtask: { count: ltCount, totalMs: ltTotal, maxMs: ltMax },
    slowEvent: { count: evCount, p95Ms: evP95, maxMs: evMax },
    topMarks,
    markStats,
    counters: Object.fromEntries(s.counters),
  };
}

declare global {
  interface Window {
    enablePerfLog?: () => void;
    disablePerfLog?: () => void;
    startPerfSession?: () => void;
    endPerfSession?: () => PerfSessionResult | null;
  }
}

if (typeof window !== "undefined") {
  window.enablePerfLog = enablePerfLog;
  window.disablePerfLog = disablePerfLog;
  window.startPerfSession = startPerfSession;
  window.endPerfSession = endPerfSession;
  try {
    if (localStorage.getItem(STORAGE_KEY) === "1") {
      enablePerfLog();
    }
  } catch {
    // ignore
  }
}
