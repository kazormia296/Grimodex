export type EditorAnalysisTaskKind =
  | "save"
  | "codex-match"
  | "lint"
  | "semantic";

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
  semantic: 3,
};

/**
 * Keep simultaneously-due work in separate macrotasks. One millisecond is
 * enough to avoid a single callback burst while remaining imperceptible next
 * to the 150ms-2.5s producer debounces.
 */
const DUE_TASK_SPACING_MS = 1;

const tasks = new Map<string, ScheduledEditorAnalysisTask>();
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let sequence = 0;
let nextLaunchAt = 0;

function normalizeDelay(delayMs: number): number {
  return Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
}

function clearWakeTimer(): void {
  if (wakeTimer === null) return;
  clearTimeout(wakeTimer);
  wakeTimer = null;
}

function nextDueAt(): number | null {
  let earliest: number | null = null;
  for (const task of tasks.values()) {
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

function armWakeTimer(): void {
  clearWakeTimer();
  const earliest = nextDueAt();
  if (earliest === null) return;
  const delay = Math.max(0, Math.max(earliest, nextLaunchAt) - Date.now());
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    const now = Date.now();
    const next = [...tasks.values()]
      .filter((task) => task.dueAt <= now)
      .sort(compareDueTasks)[0];

    if (!next) {
      armWakeTimer();
      return;
    }

    tasks.delete(next.key);
    // Store this globally before invoking producer code. A synchronous run or
    // Promise continuation may re-enter scheduleEditorAnalysisTask(), and
    // every such re-arm must retain the inter-task launch spacing.
    nextLaunchAt = now + DUE_TASK_SPACING_MS;
    startTask(next);
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
  tasks.set(task.key, {
    ...task,
    delayMs: normalizeDelay(task.delayMs),
    dueAt: Date.now() + normalizeDelay(task.delayMs),
    sequence: sequence++,
  });
  armWakeTimer();
}

export function cancelEditorAnalysisTask(key: string): boolean {
  const removed = tasks.delete(key);
  if (removed) armWakeTimer();
  return removed;
}

export function _pendingEditorAnalysisTaskCount(): number {
  return tasks.size;
}

export function _resetEditorAnalysisSchedulerForTests(): void {
  clearWakeTimer();
  tasks.clear();
  sequence = 0;
  nextLaunchAt = 0;
}
