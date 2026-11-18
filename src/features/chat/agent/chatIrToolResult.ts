/**
 * The content of `search_events` when it carries approved IR, and how it fits
 * the result cap (S1-B design PR-B2 4.3 and 6.1, DR-CHATIR-S1-36).
 *
 * Pure functions: `countTokens` is an argument, nothing is called here and
 * nothing is stored. The caller (the executor) calls Native only when
 * `precheckChatIrContent` says it may.
 *
 * Rules kept here:
 * - `chronicleIr` comes before `events`, so that the tail truncation of the
 *   agent loop keeps the status and the items.
 * - An item is never rewritten: the same object is placed in the content, and
 *   the only thing dropped is a whole item from the tail (B-T4: the content has
 *   every kept item's `JSON.stringify(item)` as a substring).
 * - The cap is the agent loop's: `max(1, floor(tokenBudget * 0.25))`, measured
 *   as `countTokens(JSON.stringify(content))` with the same function. An IR
 *   that cannot fit is dropped (`cap-exceeded`), never squeezed.
 * - A `note` that would push the content over the cap is left out; the status
 *   alone stays.
 *
 * Types only come from the wire file and `chatIrStatusText.ts`. This module
 * never imports the renderer's wrapper, not even as a type (closure test B-T6).
 */
import {
  CHAT_AGENT_IR_MAX_ITEMS,
  type ChatAgentIrItem,
} from "@/../electron/shared/chatAgentIrWire";
import {
  chatIrStatusNote,
  type ChatIrStatusForModel,
} from "./chatIrStatusText";

/** The share of the token budget one tool result may use (the agent loop's). */
const TOOL_RESULT_TOKEN_CAP_RATIO = 0.25;

/** The cap, with the same formula as the agent loop's tool result cap. */
export function chatIrTokenCap(tokenBudget: number): number {
  return Math.max(1, Math.floor(tokenBudget * TOOL_RESULT_TOKEN_CAP_RATIO));
}

/**
 * The cumulative limits of one turn (△11, DR-CHATIR-S1-38). Provisional values:
 * lowering them is a technical decision, raising them is a threshold change that
 * needs the owner's confirmation (decided with the S2 measurement).
 * - calls: how many times one turn may ask Native for IR;
 * - chars: the UTF-16 `length` of the IR items kept in the turn's tool results.
 *   Native counts scalars, so `length` counts an astral character more than
 *   Native does, which reaches the limit earlier (the safe side).
 */
export const CHAT_IR_MAX_CALLS_PER_TURN = 6;
export const CHAT_IR_MAX_CHARS_PER_TURN = 20_000;

export type CountTokens = (text: string) => number;

export interface ChatIrToolContent<TEvent> {
  readonly chronicleIr: {
    readonly status: ChatIrStatusForModel;
    readonly items: readonly ChatAgentIrItem[];
    readonly note?: string;
  };
  readonly events: readonly TEvent[];
}

export interface ChatIrToolContentResult<TEvent> {
  readonly content: ChatIrToolContent<TEvent>;
  /** The status the model sees (`cap-exceeded` for both kinds of that). */
  readonly status: ChatIrStatusForModel;
  /**
   * Whether Native was called. `false` only for the precheck's
   * `cap-exceeded`; a test tells "not called" from "called, did not fit".
   */
  readonly called: boolean;
  /** The items that are in the content (what `noteUsedIds` is given). */
  readonly items: readonly ChatAgentIrItem[];
}

/** What the fit needs from the wrapper's outcome (a structural subset). */
export interface ChatIrOutcomeShape {
  readonly status: ChatIrStatusForModel;
  /** Absent or empty for a status that carries no item. */
  readonly items?: readonly ChatAgentIrItem[];
}

export function buildChatIrContent<TEvent>(
  status: ChatIrStatusForModel,
  items: readonly ChatAgentIrItem[],
  events: readonly TEvent[],
  note?: string | null,
): ChatIrToolContent<TEvent> {
  return {
    chronicleIr: {
      status,
      items,
      ...(note ? { note } : {}),
    },
    events,
  };
}

function measure(content: unknown, countTokens: CountTokens): number {
  return countTokens(JSON.stringify(content));
}

function capExceeded<TEvent>(
  events: readonly TEvent[],
  tokenCap: number,
  countTokens: CountTokens,
  called: boolean,
): ChatIrToolContentResult<TEvent> {
  const status = "cap-exceeded" as const;
  const withNote = buildChatIrContent(
    status,
    [],
    events,
    chatIrStatusNote(status),
  );
  // The note is left out when it alone would push the content over the cap.
  const content =
    measure(withNote, countTokens) <= tokenCap
      ? withNote
      : buildChatIrContent(status, [], events);
  return { content, status, called, items: [] };
}

/**
 * Before Native is called: when even the status-only wrapper reaches the cap
 * (the Chronicle events already use it up), no item could be added, so Native
 * is not called. Returns the `cap-exceeded` result with `called: false`, or
 * `null` when the call may go on.
 */
export function precheckChatIrContent<TEvent>(input: {
  readonly events: readonly TEvent[];
  readonly tokenCap: number;
  readonly countTokens: CountTokens;
}): ChatIrToolContentResult<TEvent> | null {
  const { events, tokenCap, countTokens } = input;
  const bare = buildChatIrContent("cap-exceeded", [], events);
  if (measure(bare, countTokens) < tokenCap) return null;
  return capExceeded(events, tokenCap, countTokens, false);
}

/**
 * After Native answered: cut to `min(limit, 8)` items, then, while the content
 * is over the cap, drop one item from the tail. When items were dropped and
 * none is left, the answer is `cap-exceeded` (called). A failure or an empty
 * answer carries its class note unless the note would exceed the cap.
 */
export function fitChatIrContent<TEvent>(input: {
  readonly outcome: ChatIrOutcomeShape;
  readonly events: readonly TEvent[];
  /** The model's `limit` for the tool call. */
  readonly limit: number;
  readonly tokenCap: number;
  readonly countTokens: CountTokens;
}): ChatIrToolContentResult<TEvent> {
  const { outcome, events, limit, tokenCap, countTokens } = input;
  const itemLimit = Number.isFinite(limit)
    ? Math.min(Math.max(0, Math.floor(limit)), CHAT_AGENT_IR_MAX_ITEMS)
    : CHAT_AGENT_IR_MAX_ITEMS;
  const candidates = (outcome.items ?? []).slice(0, itemLimit);
  const note = chatIrStatusNote(outcome.status);

  // Tries the content of one item count: with the note, then without it.
  const attempt = (items: readonly ChatAgentIrItem[]) => {
    const withNote = buildChatIrContent(outcome.status, items, events, note);
    if (measure(withNote, countTokens) <= tokenCap) return withNote;
    if (!note) return null;
    const bare = buildChatIrContent(outcome.status, items, events);
    return measure(bare, countTokens) <= tokenCap ? bare : null;
  };
  const result = (
    content: ChatIrToolContent<TEvent>,
    items: readonly ChatAgentIrItem[],
  ): ChatIrToolContentResult<TEvent> => ({
    content,
    status: outcome.status,
    called: true,
    items,
  });

  if (candidates.length === 0) {
    // Nothing to drop. If even the status does not fit, the agent loop's own
    // truncation takes over (the events are what use the cap).
    const content =
      attempt(candidates) ??
      buildChatIrContent(outcome.status, candidates, events);
    return result(content, candidates);
  }
  // The tail goes one at a time (at most 8 attempts). While at least one item
  // is left the status stays Native's.
  for (let count = candidates.length; count >= 1; count -= 1) {
    const items = candidates.slice(0, count);
    const content = attempt(items);
    if (content) return result(content, items);
  }
  // Items were dropped and none is left: the IR did not fit.
  return capExceeded(events, tokenCap, countTokens, true);
}
