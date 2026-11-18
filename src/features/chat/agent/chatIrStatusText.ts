/**
 * What the model is told about a failed or empty approved-summary lookup
 * (S1-B design PR-B2 5.2〜5.3, DR-CHATIR-S1-37).
 *
 * The 28 statuses (17 from Native and 13 names on the renderer's side, two of
 * which also exist on Native's; 28 without the overlap) fold into
 * seven classes. The status name itself stays in the tool result (it is exact
 * and useful in logs); a fixed English `note` is added only on the failure side.
 * The wording is fixed text, not a per-locale asset, because the tool
 * descriptions are English only.
 *
 * Two rules the wording keeps:
 * - Only `none` says "the search completed and found nothing". Every failure
 *   class says it is not evidence that nothing exists.
 * - `timeout` is not called an expiry: it also covers a terminal audit that
 *   could not be written.
 *
 * Types only come from the wire file. This module never imports the renderer's
 * wrapper, not even as a type, so that the closure test (B-T6) can hold that no
 * product source imports the wrapper statically.
 */
import {
  CHAT_AGENT_IR_QUERY_UTF16_MAX,
  type ChatAgentIrStatus,
} from "@/../electron/shared/chatAgentIrWire";

/**
 * The statuses that only the renderer makes. The names `no-current-scene` and
 * `query-invalid` also exist on Native's side with another origin; both fold
 * into the same class, so one table serves both.
 */
export type ChatIrRendererStatusName =
  | "disabled"
  | "sub-agent"
  | "no-current-scene"
  | "query-invalid"
  | "no-workspace"
  | "turn-limit"
  | "cap-exceeded"
  | "gate-closed"
  | "egress-denied"
  | "ipc-cancelled"
  | "caller-timeout"
  | "ipc-error"
  | "invalid-response";

export type ChatIrStatusForModel = ChatAgentIrStatus | ChatIrRendererStatusName;

export type ChatIrStatusClass =
  | "answered"
  | "none"
  | "transient"
  | "unavailable"
  | "context"
  | "query"
  | "internal";

/**
 * Every status maps to a class. `satisfies` keeps the table exhaustive: a new
 * status on either side fails the type check until it is classified.
 * `disabled` and `sub-agent` never reach a tool result (those callers keep the
 * plain array); they stay here so that the table is total.
 */
export const CHAT_IR_STATUS_CLASS = {
  // Native
  available: "answered",
  "none-above-threshold": "none",
  timeout: "transient",
  "connection-busy": "transient",
  "embedder-cold": "transient",
  busy: "transient",
  "ledger-full": "unavailable",
  "index-unavailable": "unavailable",
  unsupported: "unavailable",
  "no-current-scene": "context",
  "project-unavailable": "context",
  "project-changed": "context",
  "workspace-unavailable": "context",
  "workspace-changed": "context",
  "query-invalid": "query",
  "inference-failed": "transient",
  internal: "internal",
  // Renderer only (`no-current-scene` and `query-invalid` are above)
  disabled: "unavailable",
  "sub-agent": "unavailable",
  "no-workspace": "context",
  "turn-limit": "unavailable",
  "cap-exceeded": "unavailable",
  "gate-closed": "unavailable",
  "egress-denied": "unavailable",
  "ipc-cancelled": "context",
  "caller-timeout": "transient",
  "ipc-error": "internal",
  "invalid-response": "internal",
} as const satisfies Record<ChatIrStatusForModel, ChatIrStatusClass>;

/** The query bound in the `query` note comes from the one constant. */
export const CHAT_IR_QUERY_MAX_UTF16 = CHAT_AGENT_IR_QUERY_UTF16_MAX;

/**
 * The note of each class. `null` for `answered`: the items speak for
 * themselves and the note would only spend the cap.
 */
export const CHAT_IR_CLASS_NOTE = {
  answered: null,
  none: "No approved scene summary matched this query. The search completed; this does not show that the manuscript lacks the material. Check the manuscript with search_scenes or get_scene before saying something does not exist.",
  transient:
    "The approved-summary lookup did not complete (temporary). This is not evidence that nothing relevant exists. Do not repeat this call in this turn; use other tools or answer without it.",
  unavailable:
    "The approved-summary lookup is not available in this turn. This is not evidence that nothing relevant exists. Use other tools.",
  context:
    "The author's scene, project or workspace is not ready, or it changed during this turn. This is not evidence that nothing relevant exists.",
  query: `The query was rejected: it must not be empty and must be at most ${CHAT_IR_QUERY_MAX_UTF16} characters (UTF-16). Shorten or rephrase it.`,
  internal:
    "The approved-summary lookup failed internally. This is not evidence that nothing relevant exists. Retrying will not help.",
} as const satisfies Record<ChatIrStatusClass, string | null>;

/**
 * `cap-exceeded` is the one status of `unavailable` with its own wording: the
 * lookup worked, the result was too large to include.
 */
export const CHAT_IR_CAP_EXCEEDED_NOTE =
  "The approved summaries were left out because the result would be too large. This is not evidence that nothing relevant exists. Repeating the call will not change this.";

export function chatIrStatusClass(
  status: ChatIrStatusForModel,
): ChatIrStatusClass {
  return CHAT_IR_STATUS_CLASS[status];
}

/** The fixed note for a status, or `null` when none is added (`available`). */
export function chatIrStatusNote(status: ChatIrStatusForModel): string | null {
  if (status === "cap-exceeded") return CHAT_IR_CAP_EXCEEDED_NOTE;
  return CHAT_IR_CLASS_NOTE[CHAT_IR_STATUS_CLASS[status]];
}
