import { invoke } from "@/lib/tauri";
import {
  NIR1_LOCAL_REFUSAL_REASONS,
  type Nir1LocalRefusalReason,
} from "@/../electron/shared/ipcContract";

/**
 * The typed renderer wrapper of the NIR-1 local generation route's six
 * commands (DD-1c; K5/3 "IPC の command"; DSN §6.3).
 *
 * Only the argument shapes of DD-1b's contract leave (DR-DD1B-2): the renderer
 * never sends a route, an endpoint, messages, a policy decision or a key
 * verdict. A malformed request is refused here without IPC. Main has already
 * checked every answer (DR-DD1B-2, -9, -20); the renderer parses it again as a
 * closed shape: an unknown status becomes the typed `unknown`, a reason outside
 * `NIR1_LOCAL_REFUSAL_REASONS` becomes `"unknown"`, and a thrown error is only
 * classified (its text is never shown). See DR-DD1C-3.
 *
 * This module is part of the lazy chunks behind
 * `NIR1_LOCAL_GENERATION_UI_ENABLED` only.
 */

export type Nir1LocalPurpose = "writing" | "review";
export type Nir1LocalReason = Nir1LocalRefusalReason | "unknown";
export type Nir1LocalIpcError =
  | "egress-denied"
  | "invalid-result"
  | "invalid-request"
  | "failed";

export type Nir1LocalFailure =
  | { readonly status: "error"; readonly error: Nir1LocalIpcError }
  | { readonly status: "unknown" };

export type Nir1LocalRefused = {
  readonly status: "refused";
  readonly reason: Nir1LocalReason;
};

export type Nir1LocalStartResult =
  | { readonly status: "started"; readonly handle: string }
  | { readonly status: "unavailable"; readonly reason: Nir1LocalReason }
  | Nir1LocalFailure;

export type Nir1LocalRunState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type Nir1LocalContinueResult =
  | {
      readonly status: "ok";
      readonly text: string;
      readonly thinking: string;
      readonly state: Nir1LocalRunState;
      /** Native's closed terminal word or code; never shown as text. */
      readonly terminalCode: string | null;
      readonly drained: boolean;
    }
  | Nir1LocalRefused
  | Nir1LocalFailure;

export type Nir1LocalCancelResult =
  | { readonly status: "ok" }
  | Nir1LocalRefused
  | Nir1LocalFailure;

export interface Nir1LocalConversationView {
  readonly conversationId: string;
  readonly purpose: Nir1LocalPurpose;
  readonly createdAt: string | null;
}

export type Nir1LocalCreateResult =
  | {
      readonly status: "created";
      readonly conversation: Nir1LocalConversationView;
    }
  | Nir1LocalRefused
  | Nir1LocalFailure;

export type Nir1LocalListResult =
  | {
      readonly status: "ok";
      readonly conversations: readonly Nir1LocalConversationView[];
      readonly truncated: boolean;
    }
  | Nir1LocalRefused
  | Nir1LocalFailure;

export interface Nir1LocalConversationRow {
  readonly messageId: string;
  readonly kind: "input" | "output";
  readonly createdAtMs: number;
  /** null for a row Native could not verify (`unavailable`). */
  readonly text: string | null;
  /** The number of verified thinking blocks (the content is not drawn). */
  readonly thinkingCount: number;
  readonly attemptStatus: string | null;
  readonly unavailable: string | null;
}

export type Nir1LocalReadResult =
  | {
      readonly status: "ok";
      readonly purpose: Nir1LocalPurpose;
      readonly rows: readonly Nir1LocalConversationRow[];
      readonly total: number;
      readonly truncated: boolean;
    }
  | Nir1LocalRefused
  | Nir1LocalFailure;

/** Native's `NIR1_LOCAL_CONVERSATION_PAGE_ROWS`, Main's read limit. */
export const NIR1_LOCAL_READ_PAGE_ROWS = 64;
/** Native's `NIR1_LOCAL_CONTINUE_MAX_BYTES` (text and thinking each). */
const CONTINUE_MAX_BYTES = 64 * 1024;
const READ_PAGE_BYTES = 4 * 1024 * 1024;
const LIST_LIMIT = 256;
const MAX_ID_BYTES = 256;
const MAX_OFFSET = 0xffff_ffff;
const HANDLE = /^[0-9a-f]{32}$/u;
const CONVERSATION_ID =
  /^nir1-local-(writing|review)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CLOSED_WORD = /^[a-z][a-z0-9-]{0,63}$/u;
const CLOSED_CODE = /^NIR1_[A-Z0-9_]{1,80}$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const RUN_STATES: readonly string[] = [
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];
const UTF8 = new TextEncoder();

const INVALID_RESULT = { status: "error", error: "invalid-result" } as const;
const INVALID_REQUEST = { status: "error", error: "invalid-request" } as const;
const UNKNOWN = { status: "unknown" } as const;

function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

/** The purpose of a conversation ID Native created, or null for any other. */
export function nir1LocalPurposeOfConversation(
  conversationId: string | null | undefined,
): Nir1LocalPurpose | null {
  const match =
    typeof conversationId === "string"
      ? CONVERSATION_ID.exec(conversationId)
      : null;
  return match ? (match[1] as Nir1LocalPurpose) : null;
}

/** Native's `wire_id`: non-empty, trimmed, ≤256 UTF-8 bytes, no control. */
function isWireId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    utf8Bytes(value) <= MAX_ID_BYTES &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function isPurpose(value: unknown): value is Nir1LocalPurpose {
  return value === "writing" || value === "review";
}

function isClosedWord(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (CLOSED_WORD.test(value) || CLOSED_CODE.test(value))
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** A refusal reason of the closed list, or the typed `unknown`. */
export function nir1LocalReasonOf(value: unknown): Nir1LocalReason {
  return typeof value === "string" &&
    (NIR1_LOCAL_REFUSAL_REASONS as readonly string[]).includes(value)
    ? (value as Nir1LocalRefusalReason)
    : "unknown";
}

/** Classify a thrown IPC failure without keeping its text. */
export function classifyNir1LocalIpcError(error: unknown): Nir1LocalIpcError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("D2A_EGRESS_DENIED")) return "egress-denied";
  if (message.includes("invalid result for command")) return "invalid-result";
  if (
    message.includes("invalid args") ||
    message.includes("IPC_INVALID") ||
    message.includes("IPC_NIR1_LOCAL_")
  ) {
    return "invalid-request";
  }
  return "failed";
}

/**
 * `{status:"refused"|"unavailable", reason}` as Main answers it, or null when
 * the status is another one. Extra keys make the answer invalid.
 */
function refusalOf<S extends "refused" | "unavailable">(
  value: Record<string, unknown>,
  status: S,
): { readonly status: S; readonly reason: Nir1LocalReason } | null | "invalid" {
  if (value.status !== status) return null;
  if (!hasOnlyKeys(value, ["status", "reason"])) return "invalid";
  return { status, reason: nir1LocalReasonOf(value.reason) };
}

async function call<T>(
  command: string,
  args: Record<string, unknown>,
  parse: (value: Record<string, unknown>) => T | Nir1LocalFailure,
): Promise<T | Nir1LocalFailure> {
  let raw: unknown;
  try {
    raw = await invoke<unknown>(command, args);
  } catch (error) {
    return { status: "error", error: classifyNir1LocalIpcError(error) };
  }
  const value = record(raw);
  if (value === null || typeof value.status !== "string") {
    return INVALID_RESULT;
  }
  return parse(value);
}

export function parseNir1LocalStartResult(
  value: Record<string, unknown>,
): Nir1LocalStartResult {
  const refused = refusalOf(value, "unavailable");
  if (refused === "invalid") return INVALID_RESULT;
  if (refused) return refused;
  if (value.status !== "started") return UNKNOWN;
  if (!hasOnlyKeys(value, ["status", "handle"])) return INVALID_RESULT;
  return typeof value.handle === "string" && HANDLE.test(value.handle)
    ? { status: "started", handle: value.handle }
    : INVALID_RESULT;
}

export function parseNir1LocalContinueResult(
  value: Record<string, unknown>,
): Nir1LocalContinueResult {
  const refused = refusalOf(value, "refused");
  if (refused === "invalid") return INVALID_RESULT;
  if (refused) return refused;
  if (value.status !== "ok") return UNKNOWN;
  if (
    !hasOnlyKeys(value, [
      "status",
      "text",
      "thinking",
      "state",
      "reason",
      "drained",
    ])
  ) {
    return INVALID_RESULT;
  }
  const { text, thinking, state, reason, drained } = value;
  if (
    typeof text !== "string" ||
    typeof thinking !== "string" ||
    utf8Bytes(text) > CONTINUE_MAX_BYTES ||
    utf8Bytes(thinking) > CONTINUE_MAX_BYTES ||
    typeof state !== "string" ||
    !RUN_STATES.includes(state) ||
    (reason !== undefined && !isClosedWord(reason)) ||
    typeof drained !== "boolean"
  ) {
    return INVALID_RESULT;
  }
  return {
    status: "ok",
    text,
    thinking,
    state: state as Nir1LocalRunState,
    terminalCode: reason === undefined ? null : reason,
    drained,
  };
}

export function parseNir1LocalCancelResult(
  value: Record<string, unknown>,
): Nir1LocalCancelResult {
  const refused = refusalOf(value, "refused");
  if (refused === "invalid") return INVALID_RESULT;
  if (refused) return refused;
  if (value.status !== "ok") return UNKNOWN;
  return hasOnlyKeys(value, ["status"]) ? { status: "ok" } : INVALID_RESULT;
}

function conversationViewOf(
  value: unknown,
  purpose?: Nir1LocalPurpose,
): Nir1LocalConversationView | null {
  const view = record(value);
  if (!view || !hasOnlyKeys(view, ["conversationId", "displayName"])) {
    return null;
  }
  const idPurpose = nir1LocalPurposeOfConversation(
    view.conversationId as string,
  );
  if (idPurpose === null || (purpose !== undefined && idPurpose !== purpose)) {
    return null;
  }
  const name = record(view.displayName);
  if (!name || !hasOnlyKeys(name, ["purpose", "createdAt"])) return null;
  if (name.purpose !== idPurpose) return null;
  const createdAt = name.createdAt;
  if (
    createdAt !== null &&
    (typeof createdAt !== "string" || !RFC3339.test(createdAt))
  ) {
    return null;
  }
  return {
    conversationId: view.conversationId as string,
    purpose: idPurpose,
    createdAt,
  };
}

export function parseNir1LocalCreateResult(
  value: Record<string, unknown>,
  purpose: Nir1LocalPurpose,
): Nir1LocalCreateResult {
  const refused = refusalOf(value, "refused");
  if (refused === "invalid") return INVALID_RESULT;
  if (refused) return refused;
  if (value.status !== "created") return UNKNOWN;
  const { status: _status, ...view } = value;
  const conversation = conversationViewOf(view, purpose);
  return conversation ? { status: "created", conversation } : INVALID_RESULT;
}

export function parseNir1LocalListResult(
  value: Record<string, unknown>,
): Nir1LocalListResult {
  const refused = refusalOf(value, "refused");
  if (refused === "invalid") return INVALID_RESULT;
  if (refused) return refused;
  if (value.status !== "ok") return UNKNOWN;
  if (!hasOnlyKeys(value, ["status", "conversations", "truncated"])) {
    return INVALID_RESULT;
  }
  const { conversations, truncated } = value;
  if (
    !Array.isArray(conversations) ||
    conversations.length > LIST_LIMIT ||
    typeof truncated !== "boolean"
  ) {
    return INVALID_RESULT;
  }
  const views: Nir1LocalConversationView[] = [];
  for (const entry of conversations) {
    const view = conversationViewOf(entry);
    if (!view) return INVALID_RESULT;
    views.push(view);
  }
  return { status: "ok", conversations: views, truncated };
}

function rowOf(value: unknown): Nir1LocalConversationRow | null {
  const row = record(value);
  if (
    !row ||
    !hasOnlyKeys(row, [
      "messageId",
      "kind",
      "createdAtMs",
      "text",
      "thinking",
      "attemptStatus",
      "unavailable",
    ]) ||
    typeof row.messageId !== "string" ||
    row.messageId.length === 0 ||
    utf8Bytes(row.messageId) > MAX_ID_BYTES ||
    (row.kind !== "input" && row.kind !== "output") ||
    typeof row.createdAtMs !== "number" ||
    !Number.isSafeInteger(row.createdAtMs)
  ) {
    return null;
  }
  if (row.unavailable !== undefined) {
    if (
      !isClosedWord(row.unavailable) ||
      row.text !== undefined ||
      row.thinking !== undefined ||
      row.attemptStatus !== undefined
    ) {
      return null;
    }
  } else if (typeof row.text !== "string") {
    return null;
  }
  if (row.attemptStatus !== undefined && !isClosedWord(row.attemptStatus)) {
    return null;
  }
  if (
    row.thinking !== undefined &&
    (row.kind !== "output" || !Array.isArray(row.thinking))
  ) {
    return null;
  }
  return {
    messageId: row.messageId,
    kind: row.kind,
    createdAtMs: row.createdAtMs,
    text: typeof row.text === "string" ? row.text : null,
    thinkingCount: Array.isArray(row.thinking) ? row.thinking.length : 0,
    attemptStatus:
      typeof row.attemptStatus === "string" ? row.attemptStatus : null,
    unavailable: typeof row.unavailable === "string" ? row.unavailable : null,
  };
}

export function parseNir1LocalReadResult(
  value: Record<string, unknown>,
  limit: number,
): Nir1LocalReadResult {
  const refused = refusalOf(value, "refused");
  if (refused === "invalid") return INVALID_RESULT;
  if (refused) return refused;
  if (value.status !== "ok") return UNKNOWN;
  if (
    !hasOnlyKeys(value, ["status", "purpose", "rows", "total", "truncated"])
  ) {
    return INVALID_RESULT;
  }
  const { purpose, rows, total, truncated } = value;
  if (
    !isPurpose(purpose) ||
    !Array.isArray(rows) ||
    rows.length > limit ||
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    typeof truncated !== "boolean"
  ) {
    return INVALID_RESULT;
  }
  const checked: Nir1LocalConversationRow[] = [];
  let pageBytes = 0;
  for (const [index, entry] of rows.entries()) {
    const row = rowOf(entry);
    if (!row) return INVALID_RESULT;
    const thinking = (record(rows[index]) ?? {}).thinking;
    pageBytes +=
      (row.text === null ? 0 : utf8Bytes(row.text)) +
      (thinking === undefined ? 0 : utf8Bytes(JSON.stringify(thinking)));
    if (pageBytes > READ_PAGE_BYTES) return INVALID_RESULT;
    checked.push(row);
  }
  return { status: "ok", purpose, rows: checked, total, truncated };
}

export function startNir1LocalGeneration(request: {
  readonly purpose: Nir1LocalPurpose;
  readonly conversationId: string;
  readonly sceneId: string;
}): Promise<Nir1LocalStartResult> {
  const { purpose, conversationId, sceneId } = request;
  if (!isPurpose(purpose) || !isWireId(conversationId) || !isWireId(sceneId)) {
    return Promise.resolve(INVALID_REQUEST);
  }
  return call(
    "nir1_local_generation_start",
    { purpose, conversationId, sceneId },
    parseNir1LocalStartResult,
  );
}

export function continueNir1LocalGeneration(
  handle: string,
): Promise<Nir1LocalContinueResult> {
  if (!HANDLE.test(handle)) return Promise.resolve(INVALID_REQUEST);
  return call(
    "nir1_local_generation_continue",
    { handle },
    parseNir1LocalContinueResult,
  );
}

export function cancelNir1LocalGeneration(
  handle: string,
): Promise<Nir1LocalCancelResult> {
  if (!HANDLE.test(handle)) return Promise.resolve(INVALID_REQUEST);
  return call(
    "nir1_local_generation_cancel",
    { handle },
    parseNir1LocalCancelResult,
  );
}

export function createNir1LocalConversation(request: {
  readonly purpose: Nir1LocalPurpose;
  readonly sceneId: string;
}): Promise<Nir1LocalCreateResult> {
  const { purpose, sceneId } = request;
  if (!isPurpose(purpose) || !isWireId(sceneId)) {
    return Promise.resolve(INVALID_REQUEST);
  }
  return call("nir1_local_conversation_create", { purpose, sceneId }, (value) =>
    parseNir1LocalCreateResult(value, purpose),
  );
}

export function listNir1LocalConversations(): Promise<Nir1LocalListResult> {
  return call("nir1_local_conversation_list", {}, parseNir1LocalListResult);
}

export function readNir1LocalConversation(request: {
  readonly conversationId: string;
  readonly offset: number;
  readonly limit: number;
}): Promise<Nir1LocalReadResult> {
  const { conversationId, offset, limit } = request;
  if (
    !isWireId(conversationId) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_OFFSET ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > NIR1_LOCAL_READ_PAGE_ROWS
  ) {
    return Promise.resolve(INVALID_REQUEST);
  }
  return call(
    "nir1_local_conversation_read",
    { conversationId, offset, limit },
    (value) => parseNir1LocalReadResult(value, limit),
  );
}
