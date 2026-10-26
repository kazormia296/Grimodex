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
  let ipcFailures = 0;

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
        text += result.text;
        thinking += result.thinking;
        if (result.drained) {
          finish(terminalPhaseOf(result.state), {
            terminalCode: result.terminalCode,
          });
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
        ipcFailures += 1;
        if (ipcFailures >= NIR1_LOCAL_MAX_IPC_FAILURES) {
          const lostHandle = handle;
          finish("lost", { ipcError: result.error });
          // One best-effort stop: nobody polls this handle any more.
          if (lostHandle !== null) void ports.cancel(lostHandle).catch(noop);
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
        finish("lost", { reason: result.reason });
        return;
      case "error":
        ipcError = result.error;
        emit();
        return;
      default:
        reason = "unknown";
        emit();
    }
  };

  const sendCancel = (stopHandle: string): void => {
    cancelInFlight = true;
    cancelRequested = true;
    emit();
    ports.cancel(stopHandle).then(onCancel, () => onCancel(IPC_FAILED));
  };

  const onStart = (result: Nir1LocalStartResult): void => {
    switch (result.status) {
      case "started":
        handle = result.handle;
        phase = "running";
        emit();
        if (cancelRequested) sendCancel(result.handle);
        schedule(0);
        return;
      case "unavailable":
        finish("refused", { reason: result.reason });
        return;
      case "error":
        finish("refused", { ipcError: result.error });
        return;
      default:
        finish("unknown");
    }
  };

  return {
    start() {
      if (phase !== "idle") return;
      phase = "starting";
      emit();
      ports.start(target).then(onStart, () => onStart(IPC_FAILED));
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
