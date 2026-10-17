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
/** `LOCAL_PLAIN_CHAT_MESSAGE_COUNT` in nir1_prepared_request.rs. */
export const PLAIN_CHAT_MESSAGE_COUNT = 2;
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
  return messageCount * 4 + (messageCount > 0 ? 2 : 0);
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
 * (`non_context_budget_for_user`). The fixture's freeze record writes the same
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

/** `final_plain_chat_budget_usage(...).reserved_total_tokens`. */
export function reservedTotalTokens({ system, user, outputTokens }) {
  return (
    estimateTokens(system) +
    estimateTokens(user) +
    plainChatEnvelopeTokens() +
    outputTokens +
    SAFETY_MARGIN_TOKENS
  );
}

/**
 * Reads the canonical payload JSON of a plain local chat request. The
 * renderer emits exactly the keys `model`, `messages` and `max_tokens`
 * (DF+ adds `stream`); anything else is a different request shape.
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
  const messages = value.messages;
  if (
    !Array.isArray(messages) ||
    messages.length !== PLAIN_CHAT_MESSAGE_COUNT ||
    messages[0]?.role !== "system" ||
    messages[1]?.role !== "user" ||
    typeof messages[0]?.content !== "string" ||
    typeof messages[1]?.content !== "string"
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
    user: messages[1].content,
  };
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
