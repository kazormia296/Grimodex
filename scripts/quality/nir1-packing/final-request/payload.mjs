// Pure helpers that mirror the Native final-request renderer for the
// final-request scorer (DP-H, K6/2 nir1-final-request-packing-eval).
//
// Nothing here runs Native, a model or a database. Each helper re-derives, in
// JavaScript, a rule that the Rust renderer applies so the scorer can check a
// receipt without trusting it:
//   - `estimateTokens`  = `estimate_nir1_context_tokens`
//     (src-tauri/crates/grimodex-core/src/narrative_nir1.rs) and the TS
//     `estimateTokens` (src/features/chat/contextBuilder.ts).
//   - `escapeReservedPromptTags` = `escape_reserved_prompt_tags`
//     (electron/native/grimodex-node/src/nir1_prepared_request.rs).
//   - the context budget terms of `context_budget_for_user` and
//     `final_plain_chat_budget_usage` (same file).
//   - the system message layout of `render_plain_chat_payload_from_material`.
//   - the messages of a request: the system message, the adopted history
//     messages (zero or more, oldest first, each `user` or `assistant`) and
//     the current Human (DI-1b). A request without history is the two-message
//     request of before, byte for byte.
// The constants below are existing product constants copied for recomputation;
// DP-H adds no limit of its own.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const ESTIMATOR_VERSION = "nir1-context-estimator-v1";
export const FIXED_TEMPLATE_VERSION = "nir1-local-chat-system-ja-v1";
export const FIXED_TEMPLATE_REF =
  "src/prompts/ja/chatSystemBase.txt+src/prompts/ja/chatSystemDataBoundaryReminder.txt";
export const TEMPLATE_BASE_PATH = "src/prompts/ja/chatSystemBase.txt";
export const TEMPLATE_REMINDER_PATH =
  "src/prompts/ja/chatSystemDataBoundaryReminder.txt";

/** `TOKEN_ESTIMATOR_SAFETY_MARGIN` in nir1_prepared_request.rs. */
export const SAFETY_MARGIN_TOKENS = 32;
/**
 * `LOCAL_PLAIN_CHAT_MESSAGE_COUNT` in nir1_prepared_request.rs: the messages of
 * a request besides its history (the system message and the current Human).
 * A request holds this many plus the history messages.
 */
export const PLAIN_CHAT_MESSAGE_COUNT = 2;
/**
 * `PLAIN_CHAT_MESSAGE_ENVELOPE_TOKENS` in nir1_prepared_request.rs: what one
 * message costs besides its text. A history message adds exactly this much to
 * the envelope of the request.
 */
export const PLAIN_CHAT_MESSAGE_ENVELOPE_TOKENS = 4;
/** The roles a history message can have (a past Human, a generated reply). */
export const HISTORY_ROLES = Object.freeze(["user", "assistant"]);
/** `MAX_PACKING_ITEMS` (Packing's item cap; only used for the separator reserve). */
export const MAX_PACKING_ITEMS = 512;

export const CODEX_ENTRY_SEPARATOR = "\n";

export class PayloadShapeError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "PayloadShapeError";
    this.code = code;
  }
}

function isBmpCjk(unit) {
  return (
    (unit >= 0x3000 && unit <= 0x30ff) ||
    (unit >= 0x3400 && unit <= 0x9fff) ||
    (unit >= 0xf900 && unit <= 0xfaff) ||
    (unit >= 0xff00 && unit <= 0xffef)
  );
}

/** `ceil((utf16Length + 2 * cjkCount) / 3)`; identical to the Rust estimator. */
export function estimateTokens(text) {
  let cjk = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (isBmpCjk(unit)) {
      cjk += 1;
      continue;
    }
    if (unit >= 0xd840 && unit <= 0xd87f && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cjk += 1;
        index += 1;
      }
    }
  }
  return Math.floor((text.length + cjk * 2 + 2) / 3);
}

const RESERVED_PROMPT_TAGS = Object.freeze([
  "author_instructions",
  "project_info",
  "story_so_far",
  "current_scene",
  "focus_subject",
  "codex_entries",
  "plot_thread_scenes",
  "chronicle_snapshot",
  "related_scenes",
  "chat_history",
  "conversation_summary",
]);

function isEcmascriptWhitespace(character) {
  const code = character.codePointAt(0);
  return (
    (code >= 0x0009 && code <= 0x000d) ||
    code === 0x0020 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function trimStartWhitespace(text) {
  let index = 0;
  for (const character of text) {
    if (!isEcmascriptWhitespace(character)) break;
    index += character.length;
  }
  return text.slice(index);
}

function asciiLower(text) {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function isReservedTagStart(afterOpen) {
  const afterWhitespace = trimStartWhitespace(afterOpen);
  const afterSlash = afterWhitespace.startsWith("/")
    ? afterWhitespace.slice(1)
    : afterWhitespace;
  const candidate = trimStartWhitespace(afterSlash);
  return RESERVED_PROMPT_TAGS.some((name) => {
    if (candidate.length < name.length) return false;
    if (asciiLower(candidate.slice(0, name.length)) !== name) return false;
    const rest = candidate.slice(name.length);
    if (rest.length === 0) return true;
    const next = String.fromCodePoint(rest.codePointAt(0));
    return !/^[A-Za-z0-9_]$/.test(next);
  });
}

/** Escapes `<` before a reserved prompt tag with a backslash, like the renderer. */
export function escapeReservedPromptTags(text) {
  let output = "";
  let cursor = 0;
  for (;;) {
    const open = text.indexOf("<", cursor);
    if (open < 0) break;
    output += text.slice(cursor, open + 1);
    if (isReservedTagStart(text.slice(open + 1))) output += "\\";
    cursor = open + 1;
  }
  return output + text.slice(cursor);
}

export function plainChatEnvelopeTokens(
  messageCount = PLAIN_CHAT_MESSAGE_COUNT,
) {
  return (
    messageCount * PLAIN_CHAT_MESSAGE_ENVELOPE_TOKENS +
    (messageCount > 0 ? 2 : 0)
  );
}

/** What one history message takes in the request: its text and its envelope. */
export function historyMessageTokens(content) {
  return estimateTokens(content) + PLAIN_CHAT_MESSAGE_ENVELOPE_TOKENS;
}

/** The tokens of a list of history messages (`{ content }`), envelopes included. */
export function historyTokens(history) {
  return history.reduce(
    (sum, message) => sum + historyMessageTokens(message.content),
    0,
  );
}

/** Estimate of the newline separators a full item cap would render. */
export function contextSeparatorReserveTokens() {
  return estimateTokens("\n".repeat(MAX_PACKING_ITEMS));
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Loads the two fixed-template files the renderer includes at compile time
 * and returns them with their identity. The scorer compares this identity
 * with the receipt, so a template change invalidates old receipts.
 */
export async function loadFixedTemplate(repoRoot) {
  const base = await readFile(path.join(repoRoot, TEMPLATE_BASE_PATH), "utf8");
  const reminder = await readFile(
    path.join(repoRoot, TEMPLATE_REMINDER_PATH),
    "utf8",
  );
  return makeFixedTemplate(base, reminder);
}

export function makeFixedTemplate(base, reminder) {
  return Object.freeze({
    version: FIXED_TEMPLATE_VERSION,
    ref: FIXED_TEMPLATE_REF,
    base,
    reminder,
    sha256: sha256Hex(`${base}\u0000${reminder}`),
  });
}

/** `fixed_system_prompt()` of the renderer: the template around empty blocks. */
export function fixedSystemPrompt(template) {
  return `${template.base}\n\n<current_scene>\n\n</current_scene>\n\n<codex_entries>\n\n</codex_entries>\n\n${template.reminder}`;
}

export function fixedSystemTokens(template) {
  return estimateTokens(fixedSystemPrompt(template));
}

/**
 * The terms the context budget subtracts from the route's window
 * (`non_context_budget_for_user`). The terms are those of the system message,
 * the current Human and the envelope of those two messages only: the budget
 * (and so the Raw and the accepted IR the selector keeps) is the same with or
 * without a history. The fixture's freeze record writes the same
 * formula; the scorer recomputes it from the fixture's user message.
 */
export function nonContextBudgetTerms({ template, userMessage, outputTokens }) {
  return {
    fixedSystemTokens: fixedSystemTokens(template),
    userTokens: estimateTokens(userMessage),
    envelopeTokens: plainChatEnvelopeTokens(),
    outputTokens,
    safetyMarginTokens: SAFETY_MARGIN_TOKENS,
    separatorReserveTokens: contextSeparatorReserveTokens(),
  };
}

export function contextBudgetTokens({
  template,
  userMessage,
  contextWindowTokens,
  outputTokens,
}) {
  const terms = nonContextBudgetTerms({ template, userMessage, outputTokens });
  const reserved =
    terms.fixedSystemTokens +
    terms.userTokens +
    terms.envelopeTokens +
    terms.outputTokens +
    terms.safetyMarginTokens +
    terms.separatorReserveTokens;
  return contextWindowTokens - reserved;
}

/**
 * `final_plain_chat_budget_usage(...).reserved_total_tokens`. `history` is the
 * list of history messages (`{ content }`, zero or more): their text is part
 * of the conversation and the envelope counts every message of the request.
 * The selector's budget (`contextBudgetTokens`) does not depend on the
 * history; the history is counted here, in the whole request, and in
 * `historyRoomTokens`, in what the selector's budget leaves.
 */
export function reservedTotalTokens({
  system,
  user,
  history = [],
  outputTokens,
}) {
  return (
    estimateTokens(system) +
    estimateTokens(user) +
    history.reduce((sum, message) => sum + estimateTokens(message.content), 0) +
    plainChatEnvelopeTokens(PLAIN_CHAT_MESSAGE_COUNT + history.length) +
    outputTokens +
    SAFETY_MARGIN_TOKENS
  );
}

/**
 * What the selector's budget leaves for the history after the selected
 * context (the Raw and the accepted IR): the history is placed after the
 * selection, in this room, with the envelope of each message (DR-DI1B-7).
 */
export function historyRoomTokens({ contextBudgetTokens, selectedTokens }) {
  return Math.max(0, contextBudgetTokens - selectedTokens);
}

/**
 * Reads the canonical payload JSON of a plain local chat request. The
 * renderer emits exactly the keys `model`, `messages` and `max_tokens`
 * (DF+ adds `"stream": true`, and only that value); anything else is a
 * different request shape.
 */
export function parsePlainChatPayload(canonicalPayload) {
  let value;
  try {
    value = JSON.parse(canonicalPayload);
  } catch {
    throw new PayloadShapeError("payload-not-json");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PayloadShapeError("payload-not-object");
  }
  const keys = Object.keys(value);
  for (const required of ["model", "messages", "max_tokens"]) {
    if (!keys.includes(required)) {
      throw new PayloadShapeError("payload-key-missing", required);
    }
  }
  const extra = keys.filter(
    (key) => !["model", "messages", "max_tokens", "stream"].includes(key),
  );
  if (extra.length > 0) {
    throw new PayloadShapeError("payload-key-unknown", extra.join(","));
  }
  // The only flag K5/3 adds (DF+ DR-DFP-21) is `"stream": true`. A key with
  // any other value is a different request shape, not the confirmed one.
  if (keys.includes("stream") && value.stream !== true) {
    throw new PayloadShapeError("payload-stream-value", String(value.stream));
  }
  const messages = value.messages;
  // `[system, ...history, user]`: the first message is the system message,
  // the last is the current Human, and each message between them is a history
  // message of a past Human (`user`) or a generated reply (`assistant`).
  if (
    !Array.isArray(messages) ||
    messages.length < PLAIN_CHAT_MESSAGE_COUNT ||
    messages[0]?.role !== "system" ||
    messages[messages.length - 1]?.role !== "user" ||
    messages.some(
      (message) =>
        message === null ||
        typeof message !== "object" ||
        typeof message.content !== "string",
    ) ||
    messages
      .slice(1, -1)
      .some((message) => !HISTORY_ROLES.includes(message.role))
  ) {
    throw new PayloadShapeError("payload-messages-shape");
  }
  if (typeof value.model !== "string" || !Number.isInteger(value.max_tokens)) {
    throw new PayloadShapeError("payload-route-fields");
  }
  return {
    model: value.model,
    maxTokens: value.max_tokens,
    system: messages[0].content,
    history: messages
      .slice(1, -1)
      .map((message) => ({ role: message.role, content: message.content })),
    user: messages[messages.length - 1].content,
  };
}

/**
 * Cuts the history messages of a parsed payload the way the renderer places
 * them and checks them against the render correspondence: the rows named
 * `history-message` have the indexes 0..n-1 exactly once (n is the number of
 * history messages in the payload), each names an input row that is a message
 * with the role the payload message has, and the input rows follow the
 * rendered order. A payload message without a row, a row without a message,
 * a role that differs, or an input that is not a message is a FAIL.
 * Returns `[{ index, role, content, inputOrdinal }]`, oldest first.
 */
export function cutHistoryMessages({
  parsed,
  renderCorrespondence,
  inputReferences,
}) {
  const rows = renderCorrespondence
    .filter((row) => row.position.kind === "history-message")
    .sort((left, right) => left.position.index - right.position.index);
  if (
    rows.length !== parsed.history.length ||
    rows.some((row, index) => row.position.index !== index)
  ) {
    throw new PayloadShapeError(
      "history-position-mismatch",
      `the payload holds ${parsed.history.length} history message(s) but the render correspondence names ${rows.length} position(s)`,
    );
  }
  let previousOrdinal = -1;
  return rows.map((row, index) => {
    const reference = inputReferences[row.inputOrdinal];
    const message = parsed.history[index];
    if (
      !reference ||
      reference.target?.kind !== "message" ||
      reference.role !== message.role ||
      row.inputOrdinal <= previousOrdinal
    ) {
      throw new PayloadShapeError(
        "history-input-mismatch",
        `history message ${index} does not match its input row`,
      );
    }
    previousOrdinal = row.inputOrdinal;
    return {
      index,
      role: message.role,
      content: message.content,
      inputOrdinal: row.inputOrdinal,
    };
  });
}

const CURRENT_SCENE_OPEN = "<current_scene>\n";
const SCENE_TO_CODEX = "\n</current_scene>\n\n<codex_entries>\n";
const CODEX_CLOSE = "\n</codex_entries>";

/**
 * Cuts the system message into the Raw block and the codex entries. The fixed
 * template before and after the blocks is removed after checking it equals the
 * receipt-checked template; the codex block is split by the renderer's
 * separator. A message that does not have this exact shape is a FAIL.
 */
export function cutSystemMessage(system, template) {
  const lead = `${template.base}\n\n${CURRENT_SCENE_OPEN}`;
  const tail = `\n\n${template.reminder}`;
  if (!system.startsWith(lead)) {
    throw new PayloadShapeError("system-template-prefix-mismatch");
  }
  if (!system.endsWith(tail) || system.length < lead.length + tail.length) {
    throw new PayloadShapeError("system-template-suffix-mismatch");
  }
  const body = system.slice(lead.length, system.length - tail.length);
  const middle = body.indexOf(SCENE_TO_CODEX);
  if (middle < 0) throw new PayloadShapeError("system-block-shape-mismatch");
  const raw = body.slice(0, middle);
  const rest = body.slice(middle + SCENE_TO_CODEX.length);
  if (!rest.endsWith(CODEX_CLOSE)) {
    throw new PayloadShapeError("system-block-shape-mismatch");
  }
  const codex = rest.slice(0, rest.length - CODEX_CLOSE.length);
  return {
    raw,
    entries: codex === "" ? [] : codex.split(CODEX_ENTRY_SEPARATOR),
  };
}

/**
 * Sorted-key canonical JSON (grimodex-core `canonical_json_string`): object
 * keys in UTF-16 order, strings escaped as `serde_json` does (which is also
 * what `JSON.stringify` emits), numbers in ECMAScript spelling.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("canonical JSON number is not finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

/** `final_payload_digest`: the domain-wrapped canonical digest, `sha256:<hex>`. */
export function payloadDigest(payload) {
  return `sha256:${sha256Hex(
    canonicalJson({ domain: "nir1-generation-payload@1", payload }),
  )}`;
}
