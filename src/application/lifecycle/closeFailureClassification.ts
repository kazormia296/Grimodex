import {
  StrictQuiescenceError,
  type QuiescenceFailure,
} from "./quiescenceCoordinator";

const CLOSE_FAILURE_FALLBACK_MESSAGE =
  "Document lifecycle did not reach quiescence";

/**
 * Convert a close rejection into the state consumed by the existing failure
 * dialog. Classification is observability/UI plumbing: hostile rejected
 * values must not escape a Proxy trap or replace the original reference kept
 * for recovery bookkeeping.
 */
export function classifyCloseFailure(
  error: unknown,
): readonly QuiescenceFailure[] {
  try {
    if (error instanceof StrictQuiescenceError) {
      const failures = error.failures;
      if (failures !== undefined && failures !== null) return failures;
    }
  } catch {
    // A rejected IPC value may be a revoked/hostile Proxy.
  }
  return [
    {
      stage: "participants",
      error: new Error(CLOSE_FAILURE_FALLBACK_MESSAGE),
      originalError: error,
    },
  ];
}

export function applyCloseFailureToDialogState(
  setCloseFailures: (failures: readonly QuiescenceFailure[] | null) => void,
  error: unknown,
): void {
  setCloseFailures(classifyCloseFailure(error));
}
