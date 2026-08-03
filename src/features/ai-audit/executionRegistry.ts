import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";

interface PendingAiAuditExecution {
  readonly executionId: string;
  persistenceFailure: unknown | null;
  waitForTerminalAttempt: Promise<void>;
  signalTerminalAttempt: () => void;
}

const pendingExecutions = new Map<string, PendingAiAuditExecution>();

function terminalSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function replaceTerminalSignal(entry: PendingAiAuditExecution): void {
  const signal = terminalSignal();
  entry.waitForTerminalAttempt = signal.promise;
  entry.signalTerminalAttempt = signal.resolve;
}

/** Reserve synchronously before the first begin append can yield. */
export function reservePendingAiAuditExecution(executionId: string): void {
  if (pendingExecutions.has(executionId)) {
    throw new Error(`AI audit execution is already pending: ${executionId}`);
  }
  const signal = terminalSignal();
  pendingExecutions.set(executionId, {
    executionId,
    persistenceFailure: null,
    waitForTerminalAttempt: signal.promise,
    signalTerminalAttempt: signal.resolve,
  });
}

/** True only while the execution still requires a durable terminal event. */
export function isPendingAiAuditExecution(executionId: string): boolean {
  return pendingExecutions.has(executionId);
}

/** A begin that could not durably establish its handle cannot be terminalized. */
export function abandonPendingAiAuditExecution(executionId: string): void {
  const entry = pendingExecutions.get(executionId);
  if (!entry) return;
  pendingExecutions.delete(executionId);
  entry.signalTerminalAttempt();
}

/** Clears an earlier failed terminal attempt before a deliberate retry. */
export function markAiAuditTerminalAppendStarted(executionId: string): void {
  const entry = pendingExecutions.get(executionId);
  if (!entry) return;
  if (entry.persistenceFailure !== null) replaceTerminalSignal(entry);
  entry.persistenceFailure = null;
}

/** Resolve only after the terminal/cache-hit/skip batch is durably acknowledged. */
export function completePendingAiAuditExecution(executionId: string): void {
  const entry = pendingExecutions.get(executionId);
  if (!entry) return;
  pendingExecutions.delete(executionId);
  entry.signalTerminalAttempt();
}

/** Wake a waiter fail-closed instead of hanging forever on a storage outage. */
export function failPendingAiAuditPersistence(
  executionId: string,
  error: unknown,
): void {
  const entry = pendingExecutions.get(executionId);
  if (!entry) return;
  entry.persistenceFailure = error;
  entry.signalTerminalAttempt();
}

/**
 * Waits to a fixed point because completing one attempt may synchronously
 * reserve a retry/fallback child before the current waiter resumes.
 */
export async function awaitPendingAiAuditExecutions(): Promise<void> {
  while (pendingExecutions.size > 0) {
    const snapshot = [...pendingExecutions.values()];
    const failed = snapshot.find((entry) => entry.persistenceFailure !== null);
    if (failed) {
      throw new Error(
        `AI audit execution ${failed.executionId} did not persist required audit evidence`,
        { cause: failed.persistenceFailure },
      );
    }
    await Promise.all(snapshot.map((entry) => entry.waitForTerminalAttempt));
  }
}

registerQuiescenceProvider({
  id: "ai-audit-executions",
  stage: "ai-executions",
  flush: awaitPendingAiAuditExecutions,
});

export function _pendingAiAuditExecutionCountForTests(): number {
  return pendingExecutions.size;
}

export function _resetPendingAiAuditExecutionsForTests(): void {
  for (const entry of pendingExecutions.values()) {
    entry.signalTerminalAttempt();
  }
  pendingExecutions.clear();
}
