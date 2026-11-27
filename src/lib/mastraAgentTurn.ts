/**
 * The renderer's wrapper of the two Mastra agent turn commands (MP-3b,
 * DR-MP3-4; wire: `electron/shared/mastraAgentTurnWire.ts`).
 *
 * No turn starter reaches it yet: the renderer's engine branch is MP-4
 * (DR-MP3-2), and Main's gate is closed in every product launch, so a start
 * answers `gate-closed` and the legacy route stays the only one. The wrapper holds no
 * state and does no retry. A refusal is a value (`ok:true` on the wire); a
 * restricted profile's denial (an error from the profile gate) is folded into
 * the same `restricted` value, as the chat IR wrapper does. Any other failure of
 * the call is the caller's: it is rethrown, never turned into a refusal.
 *
 * Start uses the normal mutation queue and has no caller timeout. Answer and
 * cancel use its tracked turn-control lane so they do not wait for queue slots;
 * lifecycle drains still wait for their actual IPC settlement.
 */
import {
  parseMastraAgentTurnCancelResult,
  parseMastraAgentTurnProgressPayload,
  parseMastraAgentTurnQuestionPayload,
  parseMastraAgentTurnAnswerResult,
  parseMastraAgentTurnStartResult,
  MASTRA_AGENT_TURN_ANSWER_COMMAND,
  type MastraAgentTurnCancelRequest,
  type MastraAgentTurnAnswerRequest,
  type MastraAgentTurnQuestionPayload,
  type MastraAgentTurnProgressPayload,
  type MastraAgentTurnProgressUsage,
  type MastraAgentTurnRefusalReason,
  type MastraAgentTurnLoopResult,
  type MastraAgentTurnStartRequest,
} from "@/../electron/shared/mastraAgentTurnWire";
import {
  MASTRA_AGENT_TURN_PROGRESS_EVENT,
  MASTRA_AGENT_TURN_QUESTION_EVENT,
} from "@/../electron/shared/ipcContract";
import {
  invoke,
  invokeMastraAgentTurnControl,
  isD2aEgressDenied,
  listen,
} from "@/lib/tauri";

export type MastraAgentTurnStartOutcome =
  | {
      readonly kind: "completed";
      readonly turnId: string;
      readonly executionId: string;
      /** The adapter's raw `AgentWireResponse`; the caller checks it (MP-4). */
      readonly response: Readonly<Record<string, unknown>>;
      readonly loopResult: MastraAgentTurnLoopResult | null;
    }
  | {
      readonly kind: "context-window-exceeded";
      readonly turnId: string;
      readonly usage: MastraAgentTurnProgressUsage;
      readonly overflowTokens: number;
    }
  | { readonly kind: "refused"; readonly reason: MastraAgentTurnRefusalReason }
  /** Main's answer is not an answer of this route. */
  | { readonly kind: "invalid-response" };

export type MastraAgentTurnCancelOutcome =
  | { readonly kind: "ok"; readonly found: boolean }
  | { readonly kind: "refused"; readonly reason: MastraAgentTurnRefusalReason }
  | { readonly kind: "invalid-response" };

export type MastraAgentTurnAnswerOutcome =
  | { readonly kind: "accepted"; readonly requestId: string }
  | { readonly kind: "refused"; readonly reason: "invalid" | "no-pending" }
  | { readonly kind: "invalid-response" };

/** Subscribe to Main's validated, bounded UI-tool question events. */
export async function listenMastraAgentTurnQuestion(
  callback: (payload: MastraAgentTurnQuestionPayload) => void,
): Promise<() => void> {
  let active = true;
  const unlisten = await listen<unknown>(
    MASTRA_AGENT_TURN_QUESTION_EVENT,
    (raw) => {
      if (!active) return;
      const parsed = parseMastraAgentTurnQuestionPayload(raw);
      if (parsed.ok) callback(parsed.value);
    },
  );
  return () => {
    if (!active) return;
    active = false;
    unlisten();
  };
}

/** Answer or refuse one pending question; Main revalidates this payload. */
export async function answerMastraAgentTurnQuestion(
  request: MastraAgentTurnAnswerRequest,
): Promise<MastraAgentTurnAnswerOutcome> {
  const raw = await invokeMastraAgentTurnControl<unknown>(
    MASTRA_AGENT_TURN_ANSWER_COMMAND,
    { ...request },
  );
  const answer = parseMastraAgentTurnAnswerResult(raw);
  if (answer === null) return { kind: "invalid-response" };
  return answer.status === "accepted"
    ? { kind: "accepted", requestId: answer.requestId }
    : { kind: "refused", reason: answer.reason };
}

/** Subscribe to one turn's validated progress events; a sequence gap ends delivery. */
export async function listenMastraAgentTurnProgress(
  turnId: string,
  callback: (payload: MastraAgentTurnProgressPayload) => void,
): Promise<() => void> {
  let active = true;
  let desynced = false;
  let lastSequence = 0;
  const unlisten = await listen<unknown>(
    MASTRA_AGENT_TURN_PROGRESS_EVENT,
    (raw) => {
      if (!active || desynced) return;
      const parsed = parseMastraAgentTurnProgressPayload(raw);
      if (!parsed.ok || parsed.value.turnId !== turnId) return;
      if (parsed.value.sequence !== lastSequence + 1) {
        desynced = true;
        return;
      }
      lastSequence = parsed.value.sequence;
      callback(parsed.value);
    },
  );
  return () => {
    if (!active) return;
    active = false;
    unlisten();
  };
}

/** Starts a turn; settles when the turn does. */
export async function startMastraAgentTurn(
  request: MastraAgentTurnStartRequest,
): Promise<MastraAgentTurnStartOutcome> {
  let raw: unknown;
  try {
    raw = await invoke<unknown>("mastra_agent_turn_start", {
      ...request,
    });
  } catch (error) {
    if (isD2aEgressDenied(error))
      return { kind: "refused", reason: "restricted" };
    throw error;
  }
  const answer = parseMastraAgentTurnStartResult(raw);
  if (answer === null) return { kind: "invalid-response" };
  if (answer.status === "refused") {
    return { kind: "refused", reason: answer.reason };
  }
  if (answer.status === "context-window-exceeded") {
    return {
      kind: "context-window-exceeded",
      turnId: answer.turnId,
      usage: answer.usage,
      overflowTokens: answer.overflowTokens,
    };
  }
  return {
    kind: "completed",
    turnId: answer.turnId,
    executionId: answer.executionId,
    response: answer.response,
    loopResult: answer.loopResult ?? null,
  };
}

/** Stops a turn after its current step. An unknown or finished turn is `found: false`. */
export async function cancelMastraAgentTurn(
  request: MastraAgentTurnCancelRequest,
): Promise<MastraAgentTurnCancelOutcome> {
  const raw = await invokeMastraAgentTurnControl<unknown>(
    "mastra_agent_turn_cancel",
    { turnId: request.turnId },
  );
  const answer = parseMastraAgentTurnCancelResult(raw);
  if (answer === null) return { kind: "invalid-response" };
  if (answer.status === "refused") {
    return { kind: "refused", reason: answer.reason };
  }
  return { kind: "ok", found: answer.found };
}
