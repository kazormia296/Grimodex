export interface Nir1InitialUsabilitySnapshot {
  readonly indexUsable: boolean;
  readonly querySupported: boolean;
}

type Nir1StoppedOutcome =
  | "cancelled"
  | "invalidated"
  | "ir-unavailable"
  | "failed";

export interface Nir1RelatedScenesCompletion {
  readonly outcome: "ir-ready" | "timeout" | Nir1StoppedOutcome;
  readonly completedAtMs: number;
  readonly snapshot: Nir1InitialUsabilitySnapshot;
  readonly timeoutDenominator: boolean;
  /** Completion reached or passed the absolute deadline, regardless of outcome. */
  readonly deadlineExceeded: boolean;
  /** Fixed usable/supported denominator member that reached the deadline. */
  readonly timeoutNumerator: boolean;
}

/**
 * All times must come from one renderer monotonic clock. Instantiate with the
 * actual Raw-ready time, never with a later IPC arrival time. The snapshot is
 * the backend's first coherent eligibility snapshot, not renderer entry state.
 * This helper owns one final completion. Production uses remainingMs to arm a
 * timer and calls completeIr only once the final safe fusion is ready to return;
 * IPC arrival alone does not complete the query, and a late timer grants no time.
 */
export function createNir1RelatedScenesDeadline(input: {
  rawReadyAtMs: number;
  additionalWaitMs: number;
  snapshot: Nir1InitialUsabilitySnapshot;
}) {
  if (
    !Number.isFinite(input.rawReadyAtMs) ||
    !Number.isFinite(input.additionalWaitMs) ||
    input.additionalWaitMs < 0
  )
    throw new Error("Invalid NIR1 renderer deadline");
  const rawReadyAtMs = input.rawReadyAtMs;
  const deadlineAtMs = rawReadyAtMs + input.additionalWaitMs;
  if (!Number.isFinite(deadlineAtMs))
    throw new Error("Invalid NIR1 renderer deadline");
  const snapshot = Object.freeze({
    indexUsable: input.snapshot.indexUsable,
    querySupported: input.snapshot.querySupported,
  });
  const timeoutDenominator = snapshot.indexUsable && snapshot.querySupported;
  let completion: Nir1RelatedScenesCompletion | null = null;

  function checkTime(nowMs: number): void {
    if (!Number.isFinite(nowMs) || nowMs < rawReadyAtMs)
      throw new Error("Invalid NIR1 renderer completion time");
  }

  function finish(
    outcome: Nir1RelatedScenesCompletion["outcome"],
    nowMs: number,
  ): Nir1RelatedScenesCompletion | null {
    if (completion) return null;
    checkTime(nowMs);
    // A late failure/cancellation may win the event-loop race against the
    // timer. Keep its reason visible while still recording the elapsed budget.
    const deadlineExceeded = nowMs >= deadlineAtMs;
    completion = Object.freeze({
      outcome,
      completedAtMs: nowMs,
      snapshot,
      timeoutDenominator,
      deadlineExceeded,
      timeoutNumerator: timeoutDenominator && deadlineExceeded,
    });
    return completion;
  }

  return Object.freeze({
    rawReadyAtMs,
    deadlineAtMs,
    get completion() {
      return completion;
    },
    remainingMs(nowMs: number): number {
      checkTime(nowMs);
      return completion ? 0 : Math.max(0, deadlineAtMs - nowMs);
    },
    completeIr(nowMs: number): Nir1RelatedScenesCompletion | null {
      return finish(nowMs < deadlineAtMs ? "ir-ready" : "timeout", nowMs);
    },
    expire(nowMs: number): Nir1RelatedScenesCompletion | null {
      checkTime(nowMs);
      return nowMs < deadlineAtMs ? null : finish("timeout", nowMs);
    },
    stop(
      reason: Nir1StoppedOutcome,
      nowMs: number,
    ): Nir1RelatedScenesCompletion | null {
      return finish(reason, nowMs);
    },
  });
}
