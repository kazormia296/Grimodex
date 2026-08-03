import { recordCounter } from "@/lib/perfLog";

export type EditorAnalysisTaskKind =
  | "save"
  | "codex-match"
  | "lint"
  | "derived"
  | "revision"
  | "semantic"
  | "live-reader";

export interface EditorAnalysisTask {
  /** Stable owner identity. Re-scheduling the same key replaces its payload. */
  key: string;
  kind: EditorAnalysisTaskKind;
  delayMs: number;
  run: () => void | Promise<void>;
  /** Optional terminal observer. It must not throw into the scheduler. */
  onError?: (error: unknown) => void;
}

interface ScheduledEditorAnalysisTask extends EditorAnalysisTask {
  dueAt: number;
  sequence: number;
}

const PRIORITY: Readonly<Record<EditorAnalysisTaskKind, number>> = {
  save: 0,
  "codex-match": 1,
  lint: 2,
  derived: 3,
  revision: 4,
  semantic: 5,
  "live-reader": 6,
};

const tasks = new Map<string, ScheduledEditorAnalysisTask>();
const BACKGROUND_LANE_DEADLINE_MS = 1_000;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let sequence = 0;
let pendingBackgroundTask: ScheduledEditorAnalysisTask | null = null;
let cancelPendingBackgroundLaunch: (() => void) | null = null;
let activeCriticalSaveCount = 0;

function normalizeDelay(delayMs: number): number {
  return Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
}

function clearWakeTimer(): void {
  if (wakeTimer === null) return;
  clearTimeout(wakeTimer);
  wakeTimer = null;
}

function clearPendingBackgroundLaunch(): void {
  cancelPendingBackgroundLaunch?.();
  cancelPendingBackgroundLaunch = null;
  pendingBackgroundTask = null;
}

function nextDueAt(): number | null {
  let earliest: number | null = null;
  for (const task of tasks.values()) {
    if (activeCriticalSaveCount > 0 && task.kind !== "save") continue;
    if (earliest === null || task.dueAt < earliest) earliest = task.dueAt;
  }
  return earliest;
}

function reportTaskFailure(
  task: ScheduledEditorAnalysisTask,
  error: unknown,
): void {
  try {
    task.onError?.(error);
  } catch {
    // A diagnostic callback must never turn a handled task failure into an
    // unhandled exception.
  }
}

function startTask(task: ScheduledEditorAnalysisTask): void {
  try {
    const result = task.run();
    if (result && typeof result.then === "function") {
      void Promise.resolve(result).catch((error: unknown) => {
        reportTaskFailure(task, error);
      });
    }
  } catch (error) {
    reportTaskFailure(task, error);
  }
}

function startCriticalSave(task: ScheduledEditorAnalysisTask): void {
  activeCriticalSaveCount++;
  try {
    const result = task.run();
    if (result && typeof result.then === "function") {
      void Promise.resolve(result)
        .catch((error: unknown) => {
          reportTaskFailure(task, error);
        })
        .finally(() => {
          activeCriticalSaveCount--;
          armWakeTimer();
        });
      return;
    }
  } catch (error) {
    reportTaskFailure(task, error);
  }
  activeCriticalSaveCount--;
}

function compareDueTasks(
  left: ScheduledEditorAnalysisTask,
  right: ScheduledEditorAnalysisTask,
): number {
  return (
    PRIORITY[left.kind] - PRIORITY[right.kind] ||
    left.dueAt - right.dueAt ||
    left.sequence - right.sequence
  );
}

function scheduleAnimationFrameTask(run: () => void): () => void {
  if (typeof requestAnimationFrame !== "function") {
    const timer = setTimeout(run, 16);
    return () => clearTimeout(timer);
  }
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const frame = requestAnimationFrame(() => {
    timeout = setTimeout(run, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timeout !== null) clearTimeout(timeout);
  };
}

function scheduleBackgroundTask(run: () => void): () => void {
  const runtimeScheduler = (
    globalThis as typeof globalThis & {
      scheduler?: {
        postTask: (
          callback: () => void,
          options: { priority: "background"; signal: AbortSignal },
        ) => Promise<void>;
      };
    }
  ).scheduler;
  if (runtimeScheduler?.postTask) {
    const controller = new AbortController();
    let cancelled = false;
    let started = false;
    let cancelFallback: (() => void) | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (cancelled || started) return;
      recordCounter("editor.scheduler.background.deadline");
      controller.abort();
      runOnce();
    }, BACKGROUND_LANE_DEADLINE_MS);
    const runOnce = () => {
      if (cancelled || started) return;
      started = true;
      if (deadline !== null) {
        clearTimeout(deadline);
        deadline = null;
      }
      run();
    };
    void runtimeScheduler
      .postTask(runOnce, {
        priority: "background",
        signal: controller.signal,
      })
      .catch((error: unknown) => {
        if (
          !cancelled &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          cancelFallback = scheduleAnimationFrameTask(runOnce);
        }
      });
    return () => {
      cancelled = true;
      if (deadline !== null) clearTimeout(deadline);
      controller.abort();
      cancelFallback?.();
    };
  }
  if (typeof requestIdleCallback === "function") {
    const idleCallback = requestIdleCallback(run, { timeout: 1_000 });
    return () => cancelIdleCallback(idleCallback);
  }
  return scheduleAnimationFrameTask(run);
}

function launchBackgroundTask(task: ScheduledEditorAnalysisTask): void {
  pendingBackgroundTask = task;
  const launch = () => {
    if (pendingBackgroundTask !== task) return;
    cancelPendingBackgroundLaunch = null;
    pendingBackgroundTask = null;

    // Durable persistence owns the critical lane once it is due and through
    // completion. Non-interactive background work also stays behind an
    // upcoming save, but Codex highlighting is latency-sensitive UI feedback:
    // let it use the idle window before a future autosave while still yielding
    // to a save that is already due or in flight.
    let pendingSaveDueAt: number | null = null;
    for (const candidate of tasks.values()) {
      if (
        candidate.kind === "save" &&
        (pendingSaveDueAt === null || candidate.dueAt < pendingSaveDueAt)
      ) {
        pendingSaveDueAt = candidate.dueAt;
      }
    }
    const pendingSaveIsDue =
      pendingSaveDueAt !== null && pendingSaveDueAt <= Date.now();
    const waitsForFutureSave =
      task.kind !== "codex-match" && pendingSaveDueAt !== null;
    if (activeCriticalSaveCount > 0 || pendingSaveIsDue || waitsForFutureSave) {
      if (!tasks.has(task.key)) {
        tasks.set(task.key, {
          ...task,
          dueAt:
            pendingSaveDueAt === null
              ? task.dueAt
              : Math.max(task.dueAt, pendingSaveDueAt),
        });
      }
      armWakeTimer();
      return;
    }

    recordCounter(`editor.scheduler.${task.kind}.started`);
    startTask(task);
    armWakeTimer();
  };
  cancelPendingBackgroundLaunch =
    task.kind === "lint" || task.kind === "codex-match"
      ? scheduleAnimationFrameTask(launch)
      : scheduleBackgroundTask(launch);
}

function armWakeTimer(): void {
  clearWakeTimer();
  const earliest = nextDueAt();
  if (earliest === null) return;
  const delay = Math.max(0, earliest - Date.now());
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    const now = Date.now();
    const due = [...tasks.values()]
      .filter((task) => task.dueAt <= now)
      .sort(compareDueTasks);
    const next =
      due.find((task) => task.kind === "save") ??
      (pendingBackgroundTask ? undefined : due[0]);

    if (!next) {
      if (!pendingBackgroundTask) armWakeTimer();
      return;
    }

    tasks.delete(next.key);
    recordCounter(`editor.scheduler.${next.kind}.dequeued`);
    if (next.kind === "save") {
      startCriticalSave(next);
    } else {
      launchBackgroundTask(next);
    }
    armWakeTimer();
  }, delay);
}

/**
 * Debounce one editor-analysis task through the process-wide wake timer.
 *
 * The latest schedule for a key replaces both the callback and due time.
 * Different keys remain independent, but only one simultaneously-due task is
 * started per timer tick.
 */
export function scheduleEditorAnalysisTask(task: EditorAnalysisTask): void {
  if (!task.key) return;
  if (pendingBackgroundTask?.key === task.key) {
    clearPendingBackgroundLaunch();
  }
  tasks.set(task.key, {
    ...task,
    delayMs: normalizeDelay(task.delayMs),
    dueAt: Date.now() + normalizeDelay(task.delayMs),
    sequence: sequence++,
  });
  recordCounter(`editor.scheduler.${task.kind}.scheduled`);
  armWakeTimer();
}

export function cancelEditorAnalysisTask(key: string): boolean {
  let removed = tasks.delete(key);
  if (pendingBackgroundTask?.key === key) {
    clearPendingBackgroundLaunch();
    removed = true;
  }
  if (removed) armWakeTimer();
  return removed;
}

export function _pendingEditorAnalysisTaskCount(): number {
  return tasks.size;
}

export function _resetEditorAnalysisSchedulerForTests(): void {
  clearWakeTimer();
  clearPendingBackgroundLaunch();
  tasks.clear();
  sequence = 0;
  activeCriticalSaveCount = 0;
}
