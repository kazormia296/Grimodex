// Dev-only performance logger. Detects main-thread blocking (>50ms longtasks)
// via the PerformanceObserver Long Task API and attributes them to the most
// expensive instrumented hot paths that overlapped the longtask window.
//
// Toggle from the browser dev-tools console:
//   enablePerfLog()   // persists across reloads via localStorage
//   disablePerfLog()
//
// Hot paths can opt in to attribution by wrapping work with markStart/markEnd.
// When the logger is disabled the marks are no-ops.

type MarkRecord = { label: string; start: number; duration: number };

const STORAGE_KEY = "grimodex.perfLog";
const MAX_MARKS = 300;

let enabled = false;
let observer: PerformanceObserver | null = null;
const startTimes = new Map<string, number>();
const recentMarks: MarkRecord[] = [];

export function markStart(label: string): void {
  if (!enabled) return;
  startTimes.set(label, performance.now());
}

export function markEnd(label: string): void {
  if (!enabled) return;
  const start = startTimes.get(label);
  if (start == null) return;
  startTimes.delete(label);
  const duration = performance.now() - start;
  recentMarks.push({ label, start, duration });
  if (recentMarks.length > MAX_MARKS) recentMarks.shift();
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
  try {
    observer = new PerformanceObserver((list) => {
      const now = performance.now();
      for (const entry of list.getEntries()) {
        if (entry.entryType !== "longtask") continue;
        const ltStart = entry.startTime;
        const ltEnd = ltStart + entry.duration;
        const overlap = recentMarks.filter(
          (m) => m.start + m.duration >= ltStart && m.start <= ltEnd,
        );
        const top = overlap
          .slice()
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 8)
          .map((m) => `${m.label}=${m.duration.toFixed(1)}ms`);

        // Also report any marks still in progress that started before the
        // longtask ended. Long-running async functions (e.g. coreSave) only
        // hit markEnd after all awaits resolve, so their completed entry may
        // not be in `recentMarks` when the longtask observer fires.
        const inFlight: string[] = [];
        startTimes.forEach((start, label) => {
          if (start <= ltEnd) {
            inFlight.push(`${label}@${(now - start).toFixed(0)}ms-running`);
          }
        });

        const parts: string[] = [];
        if (top.length > 0) parts.push(`marks: ${top.join(", ")}`);
        if (inFlight.length > 0)
          parts.push(`in-flight: ${inFlight.join(", ")}`);
        if (parts.length === 0) parts.push("no instrumented marks overlapped");

        console.warn(
          `[perfLog] longtask ${entry.duration.toFixed(1)}ms (start=${ltStart.toFixed(0)}) — ${parts.join(" | ")}`,
        );
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch (e) {
    console.warn("[perfLog] failed to start longtask observer", e);
    observer = null;
  }
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
  observer?.disconnect();
  observer = null;
  startTimes.clear();
  recentMarks.length = 0;
  console.info("[perfLog] disabled.");
}

declare global {
  interface Window {
    enablePerfLog?: () => void;
    disablePerfLog?: () => void;
  }
}

if (typeof window !== "undefined") {
  window.enablePerfLog = enablePerfLog;
  window.disablePerfLog = disablePerfLog;
  try {
    if (localStorage.getItem(STORAGE_KEY) === "1") {
      enablePerfLog();
    }
  } catch {
    // ignore
  }
}
