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
 * - Merge (S1-A2b, DR-CHATIR-S1-44): an item whose event is also in the year
 *   table is kept and the year table's entry is dropped. The merge is decided
 *   for every trial of the item count, so an item the cap drops leaves its
 *   year-table entry in place. Only a merged item gets its `eventId`, in
 *   `chronicleIr.eventIds` (outside the item, so B-T4 holds). Without `merge`
 *   the content is the same as before.
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
    /** revisionId -> eventId, only for the items merged with a year-table event. */
    readonly eventIds?: Readonly<Record<string, string>>;
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
  /**
   * revisionId -> eventId of the merged items: what the model was shown in
   * `chronicleIr.eventIds` (`{}` when nothing was merged).
   */
  readonly eventIds: Readonly<Record<string, string>>;
}

/**
 * How an item and a year-table entry are seen to be the same event. Absent:
 * nothing is merged and no `eventIds` is added.
 */
export interface ChatIrMerge<TEvent> {
  /** The event of an item's revision (Native's `eventIds`), if it has one. */
  readonly eventIdOfItem: (item: ChatAgentIrItem) => string | undefined;
  readonly eventIdOfEvent: (event: TEvent) => string;
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
  eventIds?: Readonly<Record<string, string>>,
): ChatIrToolContent<TEvent> {
  return {
    chronicleIr: {
      status,
      items,
      ...(eventIds && Object.keys(eventIds).length > 0 ? { eventIds } : {}),
      ...(note ? { note } : {}),
    },
    events,
  };
}

function measure(content: unknown, countTokens: CountTokens): number {
  return countTokens(JSON.stringify(content));
}

/**
 * The `cap-exceeded` result for the given year table. `called` says whether
 * Native was asked. Exported for the executor, which builds it from the
 * year table it settled on (S1-A2b), not from the one the precheck measured.
 */
export function capExceededResult<TEvent>(
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
  return { content, status, called, items: [], eventIds: {} };
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
  return capExceededResult(events, tokenCap, countTokens, false);
}

/**
 * After Native answered: cut to `min(limit, 8)` items, then, while the content
 * is over the cap, drop one item from the tail. When items were dropped and
 * none is left, the answer is `cap-exceeded` (called). A failure or an empty
 * answer carries its class note unless the note would exceed the cap.
 *
 * With `merge`, every trial of the item count builds its own year table: the
 * entries of the events the first k items stand for are left out and those
 * items get `chronicleIr.eventIds`. An item whose event is not in the year
 * table is not merged and shows no eventId.
 */
export function fitChatIrContent<TEvent>(input: {
  readonly outcome: ChatIrOutcomeShape;
  readonly events: readonly TEvent[];
  /** The model's `limit` for the tool call. */
  readonly limit: number;
  readonly tokenCap: number;
  readonly countTokens: CountTokens;
  readonly merge?: ChatIrMerge<TEvent>;
}): ChatIrToolContentResult<TEvent> {
  const { outcome, events, limit, tokenCap, countTokens, merge } = input;
  const itemLimit = Number.isFinite(limit)
    ? Math.min(Math.max(0, Math.floor(limit)), CHAT_AGENT_IR_MAX_ITEMS)
    : CHAT_AGENT_IR_MAX_ITEMS;
  const candidates = (outcome.items ?? []).slice(0, itemLimit);
  const note = chatIrStatusNote(outcome.status);
  const tableIds = merge
    ? new Set(events.map((event) => merge.eventIdOfEvent(event)))
    : null;

  // The year table and the eventIds of one item count (the merge).
  const mergedFor = (items: readonly ChatAgentIrItem[]) => {
    if (!merge || !tableIds) return { events, eventIds: {} };
    const eventIds: Record<string, string> = {};
    const gone = new Set<string>();
    for (const item of items) {
      const eventId = merge.eventIdOfItem(item);
      if (eventId === undefined || !tableIds.has(eventId)) continue;
      eventIds[item.revisionId] = eventId;
      gone.add(eventId);
    }
    if (gone.size === 0) return { events, eventIds };
    return {
      events: events.filter((event) => !gone.has(merge.eventIdOfEvent(event))),
      eventIds,
    };
  };

  // Tries the content of one item count: with the note, then without it.
  const attempt = (items: readonly ChatAgentIrItem[]) => {
    const merged = mergedFor(items);
    const withNote = buildChatIrContent(
      outcome.status,
      items,
      merged.events,
      note,
      merged.eventIds,
    );
    if (measure(withNote, countTokens) <= tokenCap) {
      return { content: withNote, eventIds: merged.eventIds };
    }
    if (!note) return null;
    const bare = buildChatIrContent(
      outcome.status,
      items,
      merged.events,
      null,
      merged.eventIds,
    );
    return measure(bare, countTokens) <= tokenCap
      ? { content: bare, eventIds: merged.eventIds }
      : null;
  };
  const result = (
    content: ChatIrToolContent<TEvent>,
    items: readonly ChatAgentIrItem[],
    eventIds: Readonly<Record<string, string>>,
  ): ChatIrToolContentResult<TEvent> => ({
    content,
    status: outcome.status,
    called: true,
    items,
    eventIds,
  });

  if (candidates.length === 0) {
    // Nothing to drop. If even the status does not fit, the agent loop's own
    // truncation takes over (the events are what use the cap).
    const fitted = attempt(candidates);
    return result(
      fitted?.content ?? buildChatIrContent(outcome.status, candidates, events),
      candidates,
      {},
    );
  }
  // The tail goes one at a time (at most 8 attempts). While at least one item
  // is left the status stays Native's.
  for (let count = candidates.length; count >= 1; count -= 1) {
    const items = candidates.slice(0, count);
    const fitted = attempt(items);
    if (fitted) return result(fitted.content, items, fitted.eventIds);
  }
  // Items were dropped and none is left: the IR did not fit.
  return capExceededResult(events, tokenCap, countTokens, true);
}
