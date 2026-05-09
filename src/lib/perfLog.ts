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

function attributeLongtaskToConsole(entry: PerformanceEntry): void {
  const ltStart = entry.startTime;
  const ltEnd = ltStart + entry.duration;
  const now = performance.now();
  const overlap = recentMarks.filter(
    (m) => m.start + m.duration >= ltStart && m.start <= ltEnd,
  );
  const top = overlap
    .slice()
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 8)
    .map((m) => `${m.label}=${m.duration.toFixed(1)}ms`);

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
      for (const entry of list.getEntries()) {
        if (entry.entryType !== "longtask") continue;
        if (session) {
          session.longtasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
        if (enabled) attributeLongtaskToConsole(entry);
      }
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
    eventObserver: null,
  };
  ensureLongtaskObserver();
  if (typeof PerformanceObserver !== "undefined") {
    try {
      const obs = new PerformanceObserver((list) => {
        if (!session) return;
        for (const entry of list.getEntries()) {
          if (entry.entryType !== "event") continue;
          session.slowEvents.push({ duration: entry.duration });
        }
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

  const byLabel = new Map<string, { totalMs: number; count: number }>();
  for (const m of s.marks) {
    const cur = byLabel.get(m.label) ?? { totalMs: 0, count: 0 };
    cur.totalMs += m.duration;
    cur.count += 1;
    byLabel.set(m.label, cur);
  }
  const topMarks = Array.from(byLabel.entries())
    .map(([label, v]) => ({ label, totalMs: v.totalMs, count: v.count }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 10);

  return {
    durationMs,
    longtask: { count: ltCount, totalMs: ltTotal, maxMs: ltMax },
    slowEvent: { count: evCount, p95Ms: evP95, maxMs: evMax },
    topMarks,
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
