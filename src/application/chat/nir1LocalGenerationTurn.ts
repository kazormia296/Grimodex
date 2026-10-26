import type {
  Nir1LocalCancelResult,
  Nir1LocalContinueResult,
  Nir1LocalIpcError,
  Nir1LocalPurpose,
  Nir1LocalReason,
  Nir1LocalRunState,
  Nir1LocalStartResult,
} from "@/features/chat/nir1/nir1LocalGenerationApi";

/**
 * The renderer's state machine of one NIR-1 local generation (DD-1c; DSN §6.3;
 * the owner／lifecycle matrix of
 * `docs/plans/nir1-lane-decisions/dd1c-decisions.md`).
 *
 * After the capture of the user's input is accepted, `start()` dispatches
 * `nir1_local_generation_start` once; the opaque handle it returns is polled
 * with `nir1_local_generation_continue` (one call at a time, each delta at
 * most 64 KiB) until it is drained; the user's stop is
 * `nir1_local_generation_cancel` only (the renderer never cancels the capture
 * itself: Native's cancel does both, K4/3:445-451).
 *
 * - One handle per generation, dropped at the terminal (DR-DD1C-4, -5). It is
 *   never stored or logged; a reloaded document cannot read the output
 *   (DR-DD1B-19).
 * - The start is sent once; a failed start offers no retry of the same capture
 *   (DR-DD1C-6).
 * - The terminal is monotonic: an answer that arrives after it is dropped, and
 *   a `running` continue after an accepted cancel does not undo it.
 * - `NIR1_LOCAL_CANCEL_CAPTURE_FAILED` keeps the handle so the stop can be
 *   pressed again (DR-DD1B-10); three IPC failures in a row end the polling.
 * - A refused cancel while a continue is in flight waits for that continue,
 *   so its last delta is kept (DR-DD1C-20).
 * - An IPC call held by the frozen audit export (`IPC_MUTATION_CANCELLED`,
 *   the typed `held`) never reached Main: it is not a failure. The start,
 *   the continue and the cancel are retried with backoff, bounded by wall
 *   clock time (DR-DD1C-18).
 */

export type Nir1LocalTurnPhase =
  | "idle"
  | "starting"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "refused"
  | "lost"
  | "unknown";

export interface Nir1LocalTurnTarget {
  readonly purpose: Nir1LocalPurpose;
  readonly conversationId: string;
  readonly sceneId: string;
}

export interface Nir1LocalTurnSnapshot extends Nir1LocalTurnTarget {
  readonly phase: Nir1LocalTurnPhase;
  readonly text: string;
  readonly thinking: string;
  /** The typed refusal reason to show, if any. */
  readonly reason: Nir1LocalReason | null;
  /** The IPC failure class to show, if any (never its text). */
  readonly ipcError: Nir1LocalIpcError | null;
  /** Native's closed terminal word (a data attribute, never text). */
  readonly terminalCode: string | null;
  /** Whether the stop is offered now. */
  readonly canCancel: boolean;
  /** Whether a stop was asked for. */
  readonly cancelRequested: boolean;
}

export interface Nir1LocalTurnPorts {
  start(target: Nir1LocalTurnTarget): Promise<Nir1LocalStartResult>;
  continue(handle: string): Promise<Nir1LocalContinueResult>;
  cancel(handle: string): Promise<Nir1LocalCancelResult>;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** Wall clock (ms) that bounds the waits for held IPC. */
  now(): number;
}

export interface Nir1LocalGenerationTurn {
  /** Dispatch the start. Only the first call does anything. */
  start(): void;
  /** Ask for the stop (`nir1_local_generation_cancel`). */
  cancel(): void;
  snapshot(): Nir1LocalTurnSnapshot;
}

/** The wait between continues while nothing new arrived. */
export const NIR1_LOCAL_POLL_IDLE_MS = 250;
/** IPC failures in a row after which the polling ends (`lost`). */
export const NIR1_LOCAL_MAX_IPC_FAILURES = 3;
/** The first and the longest wait while IPC is held (doubling between). */
export const NIR1_LOCAL_HELD_FIRST_BACKOFF_MS = 250;
export const NIR1_LOCAL_HELD_MAX_BACKOFF_MS = 2_000;
/** How long (wall clock) held IPC is waited for before giving up. */
export const NIR1_LOCAL_MAX_HELD_MS = 60_000;

const TERMINAL: ReadonlySet<Nir1LocalTurnPhase> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "refused",
  "lost",
  "unknown",
]);

export function isNir1LocalTurnTerminal(phase: Nir1LocalTurnPhase): boolean {
  return TERMINAL.has(phase);
}

function isFinalState(state: Nir1LocalRunState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function terminalPhaseOf(state: Nir1LocalRunState): Nir1LocalTurnPhase {
  switch (state) {
    case "succeeded":
    case "failed":
    case "cancelled":
      return state;
    default:
      return "unknown";
  }
}

const IPC_FAILED = { status: "error", error: "failed" } as const;

export function createNir1LocalGenerationTurn(
  target: Nir1LocalTurnTarget,
  ports: Nir1LocalTurnPorts,
  onChange: (snapshot: Nir1LocalTurnSnapshot) => void = () => {},
): Nir1LocalGenerationTurn {
  const { purpose, conversationId, sceneId } = target;
  let phase: Nir1LocalTurnPhase = "idle";
  let handle: string | null = null;
  let text = "";
  let thinking = "";
  let reason: Nir1LocalReason | null = null;
  let ipcError: Nir1LocalIpcError | null = null;
  let terminalCode: string | null = null;
  let cancelRequested = false;
  let cancelInFlight = false;
  let continueInFlight = false;
  let timer: unknown = null;
  let cancelTimer: unknown = null;
  let ipcFailures = 0;
  /** A refused cancel's reason, applied after the in-flight continue. */
  let pendingLoss: Nir1LocalReason | null = null;

  /** One wall-clock-bounded backoff per held call kind. */
  const heldWait = () => {
    let since: number | null = null;
    let backoff = NIR1_LOCAL_HELD_FIRST_BACKOFF_MS;
    return {
      /** The next wait, or null once the hold outlasted the bound. */
      next(): number | null {
        const now = ports.now();
        since ??= now;
        if (now - since > NIR1_LOCAL_MAX_HELD_MS) return null;
        const wait = backoff;
        backoff = Math.min(backoff * 2, NIR1_LOCAL_HELD_MAX_BACKOFF_MS);
        return wait;
      },
      reset() {
        since = null;
        backoff = NIR1_LOCAL_HELD_FIRST_BACKOFF_MS;
      },
    };
  };
  const startHeld = heldWait();
  const continueHeld = heldWait();
  const cancelHeld = heldWait();

  const snapshot = (): Nir1LocalTurnSnapshot => ({
    purpose,
    conversationId,
    sceneId,
    phase,
    text,
    thinking,
    reason,
    ipcError,
    terminalCode,
    canCancel:
      !isNir1LocalTurnTerminal(phase) &&
      phase !== "idle" &&
      phase !== "cancelling" &&
      !cancelInFlight &&
      cancelTimer === null &&
      pendingLoss === null &&
      !(phase === "starting" && cancelRequested),
    cancelRequested,
  });

  const emit = (): void => {
    onChange(snapshot());
  };

  const terminal = (): boolean => isNir1LocalTurnTerminal(phase);

  const finish = (
    next: Nir1LocalTurnPhase,
    detail: {
      reason?: Nir1LocalReason | null;
      ipcError?: Nir1LocalIpcError | null;
      terminalCode?: string | null;
    } = {},
  ): void => {
    phase = next;
    handle = null;
    if (timer !== null) {
      ports.clearTimer(timer);
      timer = null;
    }
    if (cancelTimer !== null) {
      ports.clearTimer(cancelTimer);
      cancelTimer = null;
    }
    pendingLoss = null;
    reason = detail.reason ?? null;
    ipcError = detail.ipcError ?? null;
    terminalCode = detail.terminalCode ?? null;
    emit();
  };

  const schedule = (ms: number): void => {
    if (terminal() || timer !== null || continueInFlight) return;
    timer = ports.setTimer(() => {
      timer = null;
      poll();
    }, ms);
  };

  const onContinue = (result: Nir1LocalContinueResult): void => {
    continueInFlight = false;
    // A continue that returns after the terminal is dropped (late answer).
    if (terminal()) return;
    switch (result.status) {
      case "ok": {
        ipcFailures = 0;
        ipcError = null;
        continueHeld.reset();
        text += result.text;
        thinking += result.thinking;
        if (result.drained) {
          finish(terminalPhaseOf(result.state), {
            terminalCode: result.terminalCode,
          });
          return;
        }
        if (pendingLoss !== null) {
          finish("lost", { reason: pendingLoss });
          return;
        }
        emit();
        const moved =
          result.text.length > 0 ||
          result.thinking.length > 0 ||
          isFinalState(result.state);
        schedule(moved ? 0 : NIR1_LOCAL_POLL_IDLE_MS);
        return;
      }
      case "refused":
        finish("lost", { reason: result.reason });
        return;
      case "error": {
        if (pendingLoss !== null) {
          finish("lost", { reason: pendingLoss });
          return;
        }
        if (result.error === "held") {
          const wait = continueHeld.next();
          if (wait === null) {
            loseWithStop("held");
            return;
          }
          ipcError = "held";
          emit();
          schedule(wait);
          return;
        }
        ipcFailures += 1;
        if (ipcFailures >= NIR1_LOCAL_MAX_IPC_FAILURES) {
          loseWithStop(result.error);
          return;
        }
        ipcError = result.error;
        emit();
        schedule(NIR1_LOCAL_POLL_IDLE_MS);
        return;
      }
      default:
        finish("unknown");
    }
  };

  /** End the polling; one best-effort stop, since nobody polls any more. */
  const loseWithStop = (error: Nir1LocalIpcError): void => {
    const lostHandle = handle;
    finish("lost", { ipcError: error });
    if (lostHandle !== null) void ports.cancel(lostHandle).catch(noop);
  };

  const poll = (): void => {
    if (terminal() || handle === null || continueInFlight) return;
    continueInFlight = true;
    ports.continue(handle).then(onContinue, () => onContinue(IPC_FAILED));
  };

  const onCancel = (result: Nir1LocalCancelResult): void => {
    cancelInFlight = false;
    if (terminal()) return;
    switch (result.status) {
      case "ok":
        // The stop is accepted; the terminal comes with the drained continue.
        cancelHeld.reset();
        phase = "cancelling";
        reason = null;
        ipcError = null;
        emit();
        schedule(0);
        return;
      case "refused":
        if (result.reason === "NIR1_LOCAL_CANCEL_CAPTURE_FAILED") {
          // The handle stays so the stop can be pressed again (DR-DD1B-10).
          reason = result.reason;
          emit();
          return;
        }
        if (continueInFlight) {
          // Keep the in-flight continue's last delta (DR-DD1C-20).
          pendingLoss = result.reason;
          emit();
          return;
        }
        finish("lost", { reason: result.reason });
        return;
      case "error": {
        ipcError = result.error;
        const wait = result.error === "held" ? cancelHeld.next() : null;
        if (wait !== null) {
          // Held before Main: send the stop again by itself.
          cancelTimer = ports.setTimer(() => {
            cancelTimer = null;
            if (!terminal() && handle !== null && phase !== "cancelling") {
              sendCancel(handle);
            }
          }, wait);
        }
        emit();
        return;
      }
      default:
        reason = "unknown";
        emit();
    }
  };

  const sendCancel = (stopHandle: string): void => {
    cancelInFlight = true;
    cancelRequested = true;
    if (reason === "NIR1_LOCAL_CANCEL_CAPTURE_FAILED") reason = null;
    emit();
    ports.cancel(stopHandle).then(onCancel, () => onCancel(IPC_FAILED));
  };

  const onStart = (result: Nir1LocalStartResult): void => {
    switch (result.status) {
      case "started":
        ipcError = null;
        handle = result.handle;
        phase = "running";
        emit();
        if (cancelRequested) sendCancel(result.handle);
        schedule(0);
        return;
      case "unavailable":
        finish("refused", { reason: result.reason });
        return;
      case "error": {
        const wait = result.error === "held" ? startHeld.next() : null;
        if (wait !== null) {
          // Held before Main, so nothing started: send the start again.
          ipcError = "held";
          emit();
          timer = ports.setTimer(() => {
            timer = null;
            dispatchStart();
          }, wait);
          return;
        }
        finish("refused", { ipcError: result.error });
        return;
      }
      default:
        finish("unknown");
    }
  };

  const dispatchStart = (): void => {
    ports.start(target).then(onStart, () => onStart(IPC_FAILED));
  };

  return {
    start() {
      if (phase !== "idle") return;
      phase = "starting";
      emit();
      dispatchStart();
    },
    cancel() {
      if (terminal() || phase === "idle" || cancelInFlight) return;
      if (handle === null) {
        // The start is in flight: stop as soon as the handle arrives.
        if (!cancelRequested) {
          cancelRequested = true;
          emit();
        }
        return;
      }
      if (phase === "cancelling") return;
      sendCancel(handle);
    },
    snapshot,
  };
}

function noop(): void {}
