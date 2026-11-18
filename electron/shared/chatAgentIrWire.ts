/**
 * The wire of the chat IR one-shot (S1-B, DR-CHATIR-S1-31／32): the request
 * the renderer sends, the answer Native returns and the check of that answer.
 *
 * This file has no import: the renderer and `electron/tsconfig.json` both
 * compile it. `ipcContract.ts` does not type the answer (`Promise<string>`), and
 * the Rust side is the source of the values below. A drift test
 * (`chatAgentIrWire.test.ts`, B-T1) reads the Rust source text and holds:
 *   - the 17 statuses against `chat_ir/status.rs` (`as_str`),
 *   - the 9 item keys against `chat_ir/item.rs` (`build_item`),
 *   - the 5 top-level keys of the answer against `chat_ir/flow.rs` (`to_wire`),
 *   - the 5 keys of the request against `chat_ir/request.rs` (`Request`),
 *   - the query bound against `chat_ir/request.rs` (`QUERY_MAX_UTF16`) and
 *     `ipcContract.ts`,
 *   - the candidate bounds (30 IDs, 200 UTF-16 units each) against
 *     `chat_ir/request.rs` and `ipcContract.ts`,
 *   - the item cap against `policies/narrative/nir1-related-scenes-ranking.json`
 *     (`irMaxScenes`).
 *
 * The answer is closed in both directions. An unknown top-level key of the
 * answer is `invalid-response`, like an unknown item key: a drift is never
 * passed silently. S1-A2 added two top-level fields to the answer
 * (`eventIds`, `excludedEventIds`) and one to the request
 * (`chronicleEventIds`); Native, this parser and B-T1 changed in the same PR.
 * `eventId`, `generation` and `quote` are not item keys: one that appears is
 * rejected, so a field of the audit or of the ledger never reaches the model.
 */

/** The statuses Native returns, in the order of `ChatIrStatus::as_str`. */
export const CHAT_AGENT_IR_STATUSES = [
  "available",
  "none-above-threshold",
  "timeout",
  "connection-busy",
  "embedder-cold",
  "busy",
  "ledger-full",
  "index-unavailable",
  "unsupported",
  "no-current-scene",
  "project-unavailable",
  "project-changed",
  "workspace-unavailable",
  "workspace-changed",
  "query-invalid",
  "inference-failed",
  "internal",
] as const;

export type ChatAgentIrStatus = (typeof CHAT_AGENT_IR_STATUSES)[number];

/**
 * The query bound in UTF-16 code units (`string.length`). Native
 * (`QUERY_MAX_UTF16`) is the authority; `ipcContract.ts` holds the same value.
 */
export const CHAT_AGENT_IR_QUERY_UTF16_MAX = 500;

/** The most items one answer carries (`irMaxScenes` of the ranking policy). */
export const CHAT_AGENT_IR_MAX_ITEMS = 8;

/**
 * The most candidate Chronicle event IDs one request carries
 * (`CHRONICLE_EVENT_IDS_MAX` of `request.rs`; the year table's own over-fetch
 * bound), and the longest one in UTF-16 code units
 * (`CHRONICLE_EVENT_ID_MAX_UTF16`). Native is the authority; `ipcContract.ts`
 * holds the same values.
 */
export const CHAT_AGENT_IR_CHRONICLE_IDS_MAX = 30;
export const CHAT_AGENT_IR_CHRONICLE_ID_UTF16_MAX = 200;

/**
 * The only keys of the request. The renderer sends no limit, no reading order.
 * `chronicleEventIds` is required: an empty array is "no candidate", a missing
 * key is a request error. At most 30 distinct IDs of 1 to 200 UTF-16 units.
 */
export interface ChatAgentIrRequest {
  readonly query: string;
  readonly projectId: string;
  readonly expectedWorkspacePath: string;
  readonly currentSceneId: string;
  readonly chronicleEventIds: readonly string[];
}

/** Whether `ids` meets the bounds of `chronicleEventIds` (Native checks the same). */
export function isChronicleEventIdList(ids: unknown): ids is readonly string[] {
  return (
    Array.isArray(ids) &&
    // A hole (`[, "a"]`) is refused: `every` skips it, `Object.keys` does not.
    ids.length === Object.keys(ids).length &&
    ids.length <= CHAT_AGENT_IR_CHRONICLE_IDS_MAX &&
    ids.every(
      (id) =>
        typeof id === "string" &&
        // U+0085 is white space for Native's Rust `trim`, not for JS `trim`:
        // refused here too (the stricter side).
        !/^[\s\u0085]*$/u.test(id) &&
        id.length <= CHAT_AGENT_IR_CHRONICLE_ID_UTF16_MAX,
    ) &&
    new Set(ids).size === ids.length
  );
}

/** The mark of an item of this route (`IR_MARK` of `item.rs`). */
export const CHAT_AGENT_IR_ITEM_MARK = "$grimodexIr";

/** The only keys of an item. Sorted as `Object.keys(...).sort()` returns them. */
export const CHAT_AGENT_IR_ITEM_KEYS = [
  "$grimodexIr",
  "origin",
  "quotes",
  "review",
  "revisionId",
  "sceneId",
  "sceneTitle",
  "score",
  "summary",
] as const;

export interface ChatAgentIrItem {
  readonly $grimodexIr: 1;
  readonly origin: "manuscript";
  readonly revisionId: string;
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly summary: string;
  readonly review: "human-approved";
  /** One element today; the check asks for at least one. */
  readonly quotes: readonly string[];
  readonly score: number;
}

export interface ChatAgentIrResponse {
  readonly status: ChatAgentIrStatus;
  readonly success: boolean;
  readonly items: readonly ChatAgentIrItem[];
  /**
   * revisionId -> the Chronicle event its payload names. Always an object
   * (`{}` outside `available`); its keys are a subset of the items' revisionIds.
   */
  readonly eventIds: Readonly<Record<string, string>>;
  /**
   * The request's candidate event IDs that the IR rule excludes. An array only
   * on a success (`available`, `none-above-threshold`), `null` otherwise:
   * `null` is "not judged", never "nothing was excluded". That the array is a
   * subset of the IDs the request sent is the wrapper's check, not this
   * parser's (it does not hold the request).
   */
  readonly excludedEventIds: readonly string[] | null;
}

const RESPONSE_KEYS = [
  "eventIds",
  "excludedEventIds",
  "items",
  "status",
  "success",
];

/** `available` and `none-above-threshold` are the successes (`is_success`). */
function isSuccessStatus(status: ChatAgentIrStatus): boolean {
  return status === "available" || status === "none-above-threshold";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(record: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(record).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

function isAgentIrItem(value: unknown): value is ChatAgentIrItem {
  if (!isPlainObject(value)) return false;
  if (!sameKeys(value, CHAT_AGENT_IR_ITEM_KEYS)) return false;
  return (
    value.$grimodexIr === 1 &&
    value.origin === "manuscript" &&
    value.review === "human-approved" &&
    typeof value.revisionId === "string" &&
    typeof value.sceneId === "string" &&
    typeof value.sceneTitle === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.quotes) &&
    value.quotes.length >= 1 &&
    value.quotes.every((quote) => typeof quote === "string") &&
    typeof value.score === "number" &&
    Number.isFinite(value.score)
  );
}

/** `eventIds`: an object whose keys are revisionIds of `items` and whose values are non-empty strings. */
function isEventIdMap(
  value: unknown,
  items: readonly ChatAgentIrItem[],
): boolean {
  if (!isPlainObject(value)) return false;
  const revisionIds = new Set(items.map((item) => item.revisionId));
  return Object.entries(value).every(
    ([revisionId, eventId]) =>
      revisionIds.has(revisionId) &&
      typeof eventId === "string" &&
      eventId.length > 0,
  );
}

/** `excludedEventIds` of a success: an array of at most 30 distinct non-empty strings. */
function isExcludedList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= CHAT_AGENT_IR_CHRONICLE_IDS_MAX &&
    value.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(value).size === value.length
  );
}

/**
 * Checks the answer of Native and returns the same object (never a copy: the
 * text the model sees must be exactly what Native sent, B-T4), or `null` when
 * it is not an answer of this route (the caller reports `invalid-response`).
 * Nothing is rewritten, trimmed or filled in.
 */
export function parseChatAgentIrResponse(
  value: unknown,
): ChatAgentIrResponse | null {
  if (!isPlainObject(value)) return null;
  if (!sameKeys(value, RESPONSE_KEYS)) return null;
  const { status, success, items, eventIds, excludedEventIds } = value;
  if (
    typeof status !== "string" ||
    !(CHAT_AGENT_IR_STATUSES as readonly string[]).includes(status)
  ) {
    return null;
  }
  const known = status as ChatAgentIrStatus;
  if (typeof success !== "boolean" || success !== isSuccessStatus(known)) {
    return null;
  }
  if (!Array.isArray(items) || items.length > CHAT_AGENT_IR_MAX_ITEMS) {
    return null;
  }
  // Only `available` carries items. The check does not ask for at least one:
  // an `available` without an item is not a drift of the shape.
  if (known !== "available" && items.length > 0) return null;
  if (!items.every(isAgentIrItem)) return null;
  if (!isEventIdMap(eventIds, items)) return null;
  // An array only on a success; `null` (not judged) on every other status.
  if (isSuccessStatus(known)) {
    if (!isExcludedList(excludedEventIds)) return null;
  } else if (excludedEventIds !== null) {
    return null;
  }
  return value as unknown as ChatAgentIrResponse;
}
