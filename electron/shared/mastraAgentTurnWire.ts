/**
 * The wire of the Mastra agent turn route (MP-3b/MP-5a): its commands,
 * progress, question and answer payloads, and the checks of those requests.
 *
 * The renderer sends a request and Main re-checks it with the same parser
 * (`mastraAgentTurnGate.ts`). The route is closed in every product launch: a
 * closed gate answers `gate-closed` before anything else is read, and in 3b
 * even an opened gate (the journey seam) answers `unsupported`, because the
 * turn owner is 3c's. A refusal is an `ok:true` value, not an error: the
 * renderer falls back to the legacy route on any of them.
 *
 * This file imports the shared M4 names, seven UI definitions and the fixed
 * write-tool allowlist; the renderer and `electron/tsconfig.json` both compile
 * it. Issues contain fixed codes, never request values.
 *
 * What a request cannot carry (DR-MP3-4, -5): `capability`, `auditContext`,
 * `pathId`, `executionId` and `callerIdentity` are Main's. Main issues the
 * execution ID, the audit correlation and the caller identity; a renderer that
 * sends one is refused (`invalid`), never ignored.
 */

import {
  M4_READ_TOOL_NAMES,
  type M4ReadToolName,
} from "./agentReadToolDefinitions.js";
import {
  createMastraUiToolDefinitions,
  MASTRA_UI_TOOL_NAMES,
  type MastraUiToolName,
} from "./mastraUiToolDefinitions.js";
import { AGENT_SETTING_KEYS } from "./agentSettingCatalog.js";

export const MASTRA_AGENT_WRITE_TOOL_NAMES = [
  "create_codex_entry",
  "update_codex_entry",
  "create_foreshadow",
  "update_foreshadow",
  "create_snippet",
  "create_event",
  "update_event",
  "delete_event",
  "stamp_scene_event",
  "unstamp_scene_event",
  "set_event_participants",
  "add_event_relation",
  "remove_event_relation",
] as const;
export type MastraAgentWriteToolName =
  (typeof MASTRA_AGENT_WRITE_TOOL_NAMES)[number];

export const MASTRA_AGENT_TURN_START_COMMAND = "mastra_agent_turn_start";
export const MASTRA_AGENT_TURN_CANCEL_COMMAND = "mastra_agent_turn_cancel";
export const MASTRA_AGENT_TURN_ANSWER_COMMAND = "mastra_agent_turn_answer";
export const MASTRA_AGENT_TURN_COMMANDS = [
  MASTRA_AGENT_TURN_START_COMMAND,
  MASTRA_AGENT_TURN_CANCEL_COMMAND,
] as const;
export type MastraAgentTurnCommand =
  (typeof MASTRA_AGENT_TURN_COMMANDS)[number];

export function isMastraAgentTurnCommand(
  command: unknown,
): command is MastraAgentTurnCommand {
  return (
    typeof command === "string" &&
    (MASTRA_AGENT_TURN_COMMANDS as readonly string[]).includes(command)
  );
}

/**
 * Why a command was refused, a closed set (DR-MP3-4).
 * - `gate-closed`: Main's gate (the journey seam) is closed.
 * - `restricted`: the profile is restricted (3c's owner; before that the
 *   profile gate refuses `start` as an `old-external-ai` denial).
 * - `unsupported`: Main cannot run this turn (3b: there is no owner yet).
 * - `busy`: the session already has a turn, or a limit of turns is reached.
 * - `sender-refused`: the sender, its window or the caller identity is not
 *   one Main issued.
 * - `invalid`: the request is not the exact wire below.
 */
export const MASTRA_AGENT_TURN_REFUSAL_REASONS = [
  "gate-closed",
  "restricted",
  "unsupported",
  "busy",
  "sender-refused",
  "invalid",
] as const;
export type MastraAgentTurnRefusalReason =
  (typeof MASTRA_AGENT_TURN_REFUSAL_REASONS)[number];

/** The providers the adapter handles (`electron/main/mastra/agentModelPolicy.ts`, U-6). */
export const MASTRA_AGENT_TURN_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
] as const;
export type MastraAgentTurnProvider =
  (typeof MASTRA_AGENT_TURN_PROVIDERS)[number];

/**
 * Bounds of a request, in UTF-16 code units (`string.length`) and counts.
 * They are provisional (3b): a legacy turn carries the chat history, so the
 * text bounds are generous; they exist so that an unbounded renderer value
 * never reaches the owner. Raising one is a change of this file and of its
 * test, in one commit.
 */
export const MASTRA_AGENT_TURN_MESSAGES_MAX = 2048;
export const MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX = 2_000_000;
export const MASTRA_AGENT_TURN_TOTAL_TEXT_UTF16_MAX = 8_000_000;
export const MASTRA_AGENT_TURN_SEGMENTS_MAX = 64;
export const MASTRA_AGENT_TURN_ID_UTF16_MAX = 200;
export const MASTRA_AGENT_TURN_ROUTE_STRING_UTF16_MAX = 2_000;
export const MASTRA_AGENT_TURN_ROUTE_JSON_DEPTH_MAX = 6;
export const MASTRA_AGENT_TURN_ROUTE_JSON_NODES_MAX = 512;

/**
 * Tool names: 21 M4, seven shared UI and 13 main-owned write tools. Legacy bounds: 25 calls
 * (`modelLimits.ts:1121-1124`), 8 default questions with an unbounded
 * override (`agentLoop.ts:32,66-77,156-158`),
 * `ja`/`en` (`chronicleReadContext.ts:27-33`), positive u32 output tokens
 * (the route check below), and safe-integer context/token budgets
 * (`modelLimits.ts:843`). Static context tops at `modelLimits.ts:336,363`;
 * result/text sizes have no hard cap in the inspected legacy sources, so the
 * text and result traversal caps below reuse this wire's existing total.
 */
export const MASTRA_AGENT_TURN_TOOLS_MAX =
  M4_READ_TOOL_NAMES.length +
  MASTRA_UI_TOOL_NAMES.length +
  MASTRA_AGENT_WRITE_TOOL_NAMES.length;
export const MASTRA_AGENT_TURN_FULLY_INJECTED_IDS_MAX = 65_536;
export const MASTRA_AGENT_TURN_LOOP_NUMBER_MAX = 1_000_000_000;
export const MASTRA_AGENT_TURN_CONTEXT_NUMBER_MAX = Number.MAX_SAFE_INTEGER;
// The main tool cap is modelLimits.ts:1121-1124; question overrides have no cap in agentLoop.ts:66-77.
export const MASTRA_AGENT_TURN_LOOP_MAX_TOOL_CALLS = 25;
export const MASTRA_AGENT_TURN_LOOP_MAX_USER_QUESTIONS =
  MASTRA_AGENT_TURN_LOOP_NUMBER_MAX;
export const MASTRA_AGENT_TURN_REQUEST_MAX_OUTPUT_TOKENS_MAX = 4_294_967_295;
export const MASTRA_AGENT_TURN_CONTROL_MESSAGE_UTF16_MAX =
  MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX;
export const MASTRA_AGENT_TURN_FALLBACK_SYSTEM_UTF16_MAX =
  MASTRA_AGENT_TURN_TOTAL_TEXT_UTF16_MAX;
export const MASTRA_AGENT_TURN_LOOP_RESULT_ARRAY_MAX = 65_536;
export const MASTRA_AGENT_TURN_LOOP_RESULT_JSON_NODES_MAX = 1_000_000;
export const MASTRA_AGENT_TURN_LOOP_RESULT_JSON_DEPTH_MAX = 64;

/** Main-to-renderer UI question and answer bounds (MP-5a). */
export const MASTRA_AGENT_TURN_UI_TOOL_TIMEOUT_MS = 10_000;
export const MASTRA_AGENT_TURN_ASK_USER_TIMEOUT_MS = 30 * 60 * 1_000;
export const MASTRA_AGENT_TURN_QUESTION_ID_UTF16_MAX = 200;
export const MASTRA_AGENT_TURN_QUESTION_TEXT_UTF16_MAX = 4_000;
export const MASTRA_AGENT_TURN_QUESTION_ARGS_UTF16_MAX = 16_384;
export const MASTRA_AGENT_TURN_QUESTION_ARRAY_MAX = 20;
export const MASTRA_AGENT_TURN_QUESTION_OPTIONS_MAX = 20;
export const MASTRA_AGENT_TURN_QUESTION_OPTION_UTF16_MAX = 500;
export const MASTRA_AGENT_TURN_QUESTION_FIELD_UTF16_MAX = 200;
export const MASTRA_AGENT_TURN_QUESTION_JSON_NODES_MAX = 2_048;
export const MASTRA_AGENT_TURN_QUESTION_JSON_DEPTH_MAX = 8;
export const MASTRA_AGENT_TURN_ANSWER_CONTENT_UTF16_MAX = 131_072;
export const MASTRA_AGENT_TURN_ANSWER_JSON_NODES_MAX = 8_192;
export const MASTRA_AGENT_TURN_ANSWER_JSON_DEPTH_MAX = 16;
export const MASTRA_AGENT_TURN_ANSWER_ARRAY_MAX = 1_024;
export const MASTRA_AGENT_TURN_ANSWER_TEXT_UTF16_MAX = 4_000;
export const MASTRA_AGENT_TURN_ANSWER_TOKENS_MAX =
  MASTRA_AGENT_TURN_ANSWER_CONTENT_UTF16_MAX;

const MASTRA_AGENT_TURN_START_TOOL_NAMES: readonly string[] = [
  ...M4_READ_TOOL_NAMES,
  ...MASTRA_UI_TOOL_NAMES,
  ...MASTRA_AGENT_WRITE_TOOL_NAMES,
];
const MASTRA_UI_TOOL_DEFINITION_MAP = new Map(
  createMastraUiToolDefinitions().map((tool) => [tool.name, tool]),
);

/** Keys a renderer must never send: they are Main's (DR-MP3-4, -5, -23). */
export const MASTRA_AGENT_TURN_FORBIDDEN_KEYS = [
  "capability",
  "capabilities",
  "auditContext",
  "pathId",
  "executionId",
  "callerIdentity",
] as const;

/**
 * Whether a request's own enumerable top-level keys include one of Main's. The
 * router replaces `callerIdentity` with Main's own (a non-enumerable value) before
 * a handler sees the arguments, so it asks this on the renderer's arguments first.
 */
export function hasMastraAgentTurnForbiddenKey(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  return Object.keys(args).some((key) =>
    (MASTRA_AGENT_TURN_FORBIDDEN_KEYS as readonly string[]).includes(key),
  );
}

export type MastraAgentTurnRole = "system" | "user" | "assistant";
export const MASTRA_AGENT_TURN_ROLES: readonly MastraAgentTurnRole[] = [
  "system",
  "user",
  "assistant",
];

/** A message of text only. Tool calls, tool results, images and files are not on this wire. */
export interface MastraAgentTurnMessage {
  readonly role: MastraAgentTurnRole;
  readonly content: string;
}

export const MASTRA_AGENT_TURN_LANGUAGES = ["ja", "en"] as const;
export type MastraAgentTurnLanguage =
  (typeof MASTRA_AGENT_TURN_LANGUAGES)[number];

export interface MastraAgentTurnControlMessages {
  readonly callLimitMessage: string;
  readonly tokenBudgetMessage: string;
  readonly userQuestionLimitMessage: string;
}

export interface MastraAgentTurnLoopOptions {
  readonly tokenBudget: number;
  readonly maxToolCalls: number;
  readonly maxUserQuestions: number;
  readonly contextWindow: number;
  readonly requestMaxOutputTokens: number;
  readonly language: MastraAgentTurnLanguage;
  readonly controlMessages: MastraAgentTurnControlMessages;
  readonly fallbackSystem: string;
}

type WireJson =
  | string
  | number
  | boolean
  | null
  | readonly WireJson[]
  | { readonly [key: string]: WireJson };
type WireJsonObject = { readonly [key: string]: WireJson };

/**
 * The route a turn is sent on: the fields of the legacy `send_agent_message`
 * arguments that name where and how, as the renderer resolved them. A
 * key that does not apply is `null`; `requestMaxOutputTokens` and
 * `resolvedToolProtocol` are present only when the legacy request carries one.
 */
export interface MastraAgentTurnRoute {
  readonly provider: MastraAgentTurnProvider;
  readonly model: string | null;
  readonly endpointId: string | null;
  readonly apiVariant: string | null;
  readonly expectedOllamaEndpoint: string | null;
  readonly thinking: WireJsonObject | null;
  readonly effort: string | null;
  readonly reasoningEnabled: boolean | null;
  readonly reasoningEffort: string | null;
  readonly webSearch: WireJsonObject | null;
  readonly requestMaxOutputTokens?: number;
  readonly resolvedToolProtocol?: "native" | "hermes";
}

const ROUTE_REQUIRED_KEYS = [
  "provider",
  "model",
  "endpointId",
  "apiVariant",
  "expectedOllamaEndpoint",
  "thinking",
  "effort",
  "reasoningEnabled",
  "reasoningEffort",
  "webSearch",
] as const;
const ROUTE_OPTIONAL_KEYS = [
  "requestMaxOutputTokens",
  "resolvedToolProtocol",
] as const;
/** Every key of a route; a test holds it against the adapter's `AgentRoute`. */
export const MASTRA_AGENT_TURN_ROUTE_KEYS: readonly string[] = [
  ...ROUTE_REQUIRED_KEYS,
  ...ROUTE_OPTIONAL_KEYS,
];

export interface MastraAgentTurnStartRequest {
  /** The renderer's UUID of this turn; the key of its cancel. */
  readonly turnId: string;
  /** The chat session (`sessionIdForPersist ?? activeSessionId`); one turn per sender and session. */
  readonly chatSessionId: string;
  /**
   * The project the turn's audit rows are chained to (`project:<id>`, as the
   * legacy route does; MP-4a, DR-MP4-1, -2). The renderer's own claim: Main
   * checks its form only (non-empty, no surrounding whitespace, no control
   * character) and never that the project exists; Native's foreign key
   * (`ai_audit_events.project_id` references `projects`) refuses an unknown
   * project at the first append, so such a turn ends with no row and no send.
   * `"default-project"` is not a project: Main's owner refuses it as
   * `unsupported`.
   */
  readonly projectId: string;
  /**
   * The scene the author has open, or `null` for none (an empty string from
   * the renderer is read as `null`). A claim too: the form is checked, the
   * scene is not looked up.
   */
  readonly currentSceneId: string | null;
  /**
   * The assistant message this turn answers: what the legacy route's
   * `auditContext.chatMessageId` carries (DR-MP4-23). It rides the send's
   * arguments, not an audit row. A claim, form-checked only.
   */
  readonly chatMessageId: string;
  readonly messages: readonly MastraAgentTurnMessage[];
  readonly route: MastraAgentTurnRoute;
  readonly systemCacheSegments: readonly string[] | null;
  readonly systemVolatileTail: string | null;
  readonly fullyInjectedIds: readonly string[];
  readonly loop: MastraAgentTurnLoopOptions;
  /** The renderer sends only names; Main owns and resolves the definitions. */
  readonly tools: readonly (
    | M4ReadToolName
    | MastraUiToolName
    | MastraAgentWriteToolName
  )[];
}

export type MastraAgentTurnQuestionToolName = MastraUiToolName;

export interface MastraAgentTurnQuestionPayload {
  readonly turnId: string;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: MastraAgentTurnQuestionToolName;
  readonly args: Readonly<Record<string, unknown>>;
  /** Absolute Unix time in milliseconds. */
  readonly deadlineAt: number;
}

export interface MastraAgentTurnUiToolResult {
  readonly toolCallId: string;
  readonly name: MastraAgentTurnQuestionToolName;
  readonly content: unknown;
  readonly summary: string;
  readonly tokensUsed: number;
  readonly error?: string;
  readonly undoId?: string;
  readonly settingProposal?: {
    readonly id: string;
    readonly key: string;
    readonly value: string;
    readonly reason?: string;
  };
}

export type MastraAgentTurnQuestionRefusal = "authority-revoked";

export type MastraAgentTurnAnswerRequest =
  | {
      readonly requestId: string;
      readonly result: MastraAgentTurnUiToolResult;
    }
  | {
      readonly requestId: string;
      readonly refusal: MastraAgentTurnQuestionRefusal;
    };

export type MastraAgentTurnAnswerResult =
  | { readonly status: "accepted"; readonly requestId: string }
  | {
      readonly status: "refused";
      readonly reason: "invalid" | "no-pending";
    };

export type MastraAgentTurnQuestionWireIssue =
  | "not-object"
  | "unknown-key"
  | "missing-key"
  | "turn-id"
  | "request-id"
  | "tool-call-id"
  | "tool-name"
  | "args"
  | "deadline"
  | "result"
  | "refusal"
  | "too-large";

export type MastraAgentTurnQuestionParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: MastraAgentTurnQuestionWireIssue };

const START_KEYS = [
  "turnId",
  "chatSessionId",
  "projectId",
  "currentSceneId",
  "chatMessageId",
  "messages",
  "route",
  "systemCacheSegments",
  "systemVolatileTail",
  "fullyInjectedIds",
  "loop",
  "tools",
] as const;

const LOOP_KEYS = [
  "tokenBudget",
  "maxToolCalls",
  "maxUserQuestions",
  "contextWindow",
  "requestMaxOutputTokens",
  "language",
  "controlMessages",
  "fallbackSystem",
] as const;
const CONTROL_MESSAGE_KEYS = [
  "callLimitMessage",
  "tokenBudgetMessage",
  "userQuestionLimitMessage",
] as const;

export interface MastraAgentTurnCancelRequest {
  readonly turnId: string;
}

/** The answer of a start: a refusal, or (3c) the turn's own raw response. */
export type MastraAgentTurnStartResult =
  | {
      readonly status: "refused";
      readonly command: "start";
      readonly reason: MastraAgentTurnRefusalReason;
    }
  | {
      readonly status: "completed";
      readonly turnId: string;
      /** Main's execution ID of the audit rows of this turn. */
      readonly executionId: string;
      /** The adapter's raw `AgentWireResponse`, never Mastra's concatenated text (DR-MP3-13). */
      readonly response: Readonly<Record<string, unknown>>;
      /** Present on R2-b2 results; absent on older completed answers. */
      readonly loopResult?: MastraAgentTurnLoopResult;
    }
  | {
      readonly status: "context-window-exceeded";
      readonly turnId: string;
      readonly usage: MastraAgentTurnProgressUsage;
      readonly overflowTokens: number;
    };

export type MastraAgentTurnCancelResult =
  | {
      readonly status: "refused";
      readonly command: "cancel";
      readonly reason: MastraAgentTurnRefusalReason;
    }
  | {
      readonly status: "ok";
      readonly turnId: string;
      /** Whether Main knew the turn (an unknown or finished turn is a no-op). */
      readonly found: boolean;
    };

export const MASTRA_AGENT_TURN_STOPPED_REASONS = [
  "completed",
  "limit_calls",
  "limit_tokens",
  "limit_questions",
  "aborted",
] as const;
export type MastraAgentTurnStoppedReason =
  (typeof MASTRA_AGENT_TURN_STOPPED_REASONS)[number];

export interface MastraAgentTurnToolCallRecord {
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly resultSummary: string;
  readonly tokensUsed: number;
  readonly undoId?: string;
  readonly content?: unknown;
  readonly settingProposal?: Readonly<Record<string, unknown>>;
}

export interface MastraAgentTurnUsage {
  readonly totalTokens: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly cost: number | null;
}

export interface MastraAgentTurnCitation {
  readonly [key: string]: unknown;
}

export interface MastraAgentTurnThinkingBlock {
  readonly thinking: string;
  readonly signature: string;
}

/** Loop metadata is a separate wire so the existing raw start result stays compatible. */
export interface MastraAgentTurnLoopResult {
  readonly finalText: string;
  readonly toolCallRecords: readonly MastraAgentTurnToolCallRecord[];
  readonly stoppedReason: MastraAgentTurnStoppedReason;
  readonly usage: MastraAgentTurnUsage;
  readonly citations: readonly MastraAgentTurnCitation[];
  readonly finalThinkingBlocks: readonly MastraAgentTurnThinkingBlock[];
}

export function mastraAgentTurnRefusalValue(
  command: MastraAgentTurnCommand,
  reason: MastraAgentTurnRefusalReason,
): MastraAgentTurnStartResult | MastraAgentTurnCancelResult {
  return command === MASTRA_AGENT_TURN_START_COMMAND
    ? { status: "refused", command: "start", reason }
    : { status: "refused", command: "cancel", reason };
}

// ---------------------------------------------------------------------------
// The check of a request.
// ---------------------------------------------------------------------------

/** What is wrong with a request: a fixed code, never a value of the request. */
export type MastraAgentTurnWireIssue =
  | "not-object"
  | "unknown-key"
  | "missing-key"
  | "forbidden-key"
  | "turn-id"
  | "chat-session-id"
  | "project-id"
  | "current-scene-id"
  | "chat-message-id"
  | "messages"
  | "message"
  | "text-too-long"
  | "route"
  | "provider"
  | "route-value"
  | "segments"
  | "volatile-tail"
  | "tools"
  | "fully-injected-ids"
  | "loop"
  | "progress-sequence"
  | "progress-event";

export type MastraAgentTurnParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: MastraAgentTurnWireIssue };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A UUID in canonical lower case (what `crypto.randomUUID()` returns). */
export function isMastraAgentTurnId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function fail(issue: MastraAgentTurnWireIssue): {
  readonly ok: false;
  readonly issue: MastraAgentTurnWireIssue;
} {
  return { ok: false, issue };
}

/**
 * The own enumerable data properties of a plain object, or `null` (not a plain
 * object, an accessor, or an enumerable symbol key): a structured clone yields
 * only enumerable plain data, so anything else is not from the renderer's wire.
 *
 * A non-enumerable own property is skipped, not refused: Main's router attaches
 * the caller identity (and other sidecars) that way, and such a property never
 * crosses IPC. A renderer's own `callerIdentity` is an enumerable key, which
 * `keyIssue` refuses as forbidden when this parser sees the raw request. The
 * router replaces that key with Main's, so it asks
 * `hasMastraAgentTurnForbiddenKey` on the renderer's arguments first.
 */
function plainEntries(value: unknown): ReadonlyMap<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return null;
    if (!descriptor.enumerable) continue;
    if (
      typeof key !== "string" ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return null;
    }
    entries.set(key, descriptor.value as unknown);
  }
  return entries;
}

/** `entries` has exactly the required keys and some of the optional ones. */
function keyIssue(
  entries: ReadonlyMap<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): MastraAgentTurnWireIssue | null {
  for (const key of entries.keys()) {
    if ((MASTRA_AGENT_TURN_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return "forbidden-key";
    }
  }
  for (const key of entries.keys()) {
    if (!required.includes(key) && !optional.includes(key)) {
      return "unknown-key";
    }
  }
  for (const key of required) {
    if (!entries.has(key)) return "missing-key";
  }
  return null;
}

/**
 * A provider's tool call id is an opaque identifier. The progress event is
 * "numbers and identifiers only", so the id is limited to the characters the
 * providers actually use (letters, digits, `_`, `-`, `.`, `:`); free text such
 * as `secret=abc` is refused instead of being sent to the renderer.
 */
const PROGRESS_TOOL_CALL_ID = /^[A-Za-z0-9_.:-]+$/u;

function isProgressToolCallId(value: unknown): value is string {
  return isTrimmedId(value) && PROGRESS_TOOL_CALL_ID.test(value);
}

function isTrimmedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MASTRA_AGENT_TURN_ID_UTF16_MAX &&
    value === value.trim()
  );
}

/**
 * A C0 or C1 control character (U+0085 included), a line or paragraph
 * separator or a byte order mark. JS `trim()` and Rust `str::trim()` differ on
 * the edge of this set (U+0085 only Rust trims, U+FEFF only JS trims), so a
 * value `trim()` accepts here could be one Native's `ai_audit_scope_id` refuses
 * (`ai_audit.rs`). None of them is in a real ID, and none is allowed anywhere
 * in one, so the two `trim`s agree on every value that passes.
 */
const SCOPE_ID_FORBIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u;

/**
 * The form of `projectId` and `chatMessageId` (and a non-null `currentSceneId`):
 * `isTrimmedId` and no forbidden character, so what Native's
 * `ai_audit_scope_id` takes (non-empty, no surrounding whitespace) is
 * a superset of what passes here.
 */
function isScopeId(value: unknown): value is string {
  return isTrimmedId(value) && !SCOPE_ID_FORBIDDEN.test(value);
}

function isShortString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MASTRA_AGENT_TURN_ROUTE_STRING_UTF16_MAX
  );
}

function nullable(
  check: (value: unknown) => boolean,
): (value: unknown) => boolean {
  return (value) => value === null || check(value);
}

/** A JSON object of bounded depth and size (the route's `thinking` and `webSearch`). */
function isBoundedJsonObject(value: unknown): boolean {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (
      nodes > MASTRA_AGENT_TURN_ROUTE_JSON_NODES_MAX ||
      depth > MASTRA_AGENT_TURN_ROUTE_JSON_DEPTH_MAX
    ) {
      return false;
    }
    if (candidate === null) return true;
    if (typeof candidate === "string") return isShortString(candidate);
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate === "boolean") return true;
    if (Array.isArray(candidate)) {
      // A hole is not JSON: `every` would skip it.
      if (candidate.length !== Object.keys(candidate).length) return false;
      return candidate.every((item) => visit(item, depth + 1));
    }
    const entries = plainEntries(candidate);
    if (entries === null) return false;
    for (const [key, item] of entries) {
      if (!isShortString(key) || !visit(item, depth + 1)) return false;
    }
    return true;
  };
  return plainEntries(value) !== null && visit(value, 0);
}

function parseRoute(
  value: unknown,
): MastraAgentTurnParse<MastraAgentTurnRoute> {
  const entries = plainEntries(value);
  if (entries === null) return fail("route");
  const issue = keyIssue(entries, ROUTE_REQUIRED_KEYS, ROUTE_OPTIONAL_KEYS);
  if (issue !== null) return fail(issue === "missing-key" ? "route" : issue);
  const provider = entries.get("provider");
  if (!(MASTRA_AGENT_TURN_PROVIDERS as readonly unknown[]).includes(provider)) {
    return fail("provider");
  }
  const checks: ReadonlyArray<readonly [string, (value: unknown) => boolean]> =
    [
      ["model", nullable(isShortString)],
      ["endpointId", nullable(isShortString)],
      ["apiVariant", nullable(isShortString)],
      ["expectedOllamaEndpoint", nullable(isShortString)],
      ["thinking", nullable(isBoundedJsonObject)],
      ["effort", nullable(isShortString)],
      [
        "reasoningEnabled",
        nullable((candidate) => typeof candidate === "boolean"),
      ],
      ["reasoningEffort", nullable(isShortString)],
      ["webSearch", nullable(isBoundedJsonObject)],
    ];
  for (const [key, check] of checks) {
    if (!check(entries.get(key))) return fail("route-value");
  }
  if (entries.has("requestMaxOutputTokens")) {
    const tokens = entries.get("requestMaxOutputTokens");
    // The legacy value is a `u32` that is positive.
    if (
      typeof tokens !== "number" ||
      !Number.isInteger(tokens) ||
      tokens < 1 ||
      tokens > MASTRA_AGENT_TURN_REQUEST_MAX_OUTPUT_TOKENS_MAX
    ) {
      return fail("route-value");
    }
  }
  if (entries.has("resolvedToolProtocol")) {
    const protocol = entries.get("resolvedToolProtocol");
    if (protocol !== "native" && protocol !== "hermes") {
      return fail("route-value");
    }
  }
  return { ok: true, value: value as MastraAgentTurnRoute };
}

function parseLoop(value: unknown): MastraAgentTurnParse<{
  readonly value: MastraAgentTurnLoopOptions;
  readonly textLength: number;
}> {
  const entries = plainEntries(value);
  if (entries === null) return fail("loop");
  const issue = keyIssue(entries, LOOP_KEYS, []);
  if (issue !== null) return fail(issue === "missing-key" ? "loop" : issue);
  for (const [key, maximum] of [
    ["tokenBudget", MASTRA_AGENT_TURN_CONTEXT_NUMBER_MAX],
    ["maxToolCalls", MASTRA_AGENT_TURN_LOOP_MAX_TOOL_CALLS],
    ["maxUserQuestions", MASTRA_AGENT_TURN_LOOP_MAX_USER_QUESTIONS],
    ["contextWindow", MASTRA_AGENT_TURN_CONTEXT_NUMBER_MAX],
  ] as const) {
    const number = entries.get(key);
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > maximum
    ) {
      return fail("loop");
    }
  }
  const requestMaxOutputTokens = entries.get("requestMaxOutputTokens");
  if (
    typeof requestMaxOutputTokens !== "number" ||
    !Number.isInteger(requestMaxOutputTokens) ||
    requestMaxOutputTokens < 1 ||
    requestMaxOutputTokens > MASTRA_AGENT_TURN_REQUEST_MAX_OUTPUT_TOKENS_MAX
  ) {
    return fail("loop");
  }
  if (
    !(MASTRA_AGENT_TURN_LANGUAGES as readonly unknown[]).includes(
      entries.get("language"),
    )
  ) {
    return fail("loop");
  }
  const controlMessages = plainEntries(entries.get("controlMessages"));
  if (controlMessages === null) return fail("loop");
  const controlIssue = keyIssue(controlMessages, CONTROL_MESSAGE_KEYS, []);
  if (controlIssue !== null) {
    return fail(controlIssue === "missing-key" ? "loop" : controlIssue);
  }
  let textLength = 0;
  for (const key of CONTROL_MESSAGE_KEYS) {
    const message = controlMessages.get(key);
    if (
      typeof message !== "string" ||
      message.length > MASTRA_AGENT_TURN_CONTROL_MESSAGE_UTF16_MAX
    ) {
      return fail("loop");
    }
    textLength += message.length;
  }
  const fallbackSystem = entries.get("fallbackSystem");
  if (
    typeof fallbackSystem !== "string" ||
    fallbackSystem.length > MASTRA_AGENT_TURN_FALLBACK_SYSTEM_UTF16_MAX
  ) {
    return fail("loop");
  }
  textLength += fallbackSystem.length;
  return {
    ok: true,
    value: { value: value as MastraAgentTurnLoopOptions, textLength },
  };
}

function parseMessages(
  value: unknown,
):
  | { readonly ok: true; readonly total: number }
  | { readonly ok: false; readonly issue: MastraAgentTurnWireIssue } {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MASTRA_AGENT_TURN_MESSAGES_MAX ||
    // A hole (`[, {…}]`) is refused: `every` would skip it.
    value.length !== Object.keys(value).length
  ) {
    return fail("messages");
  }
  let total = 0;
  for (const candidate of value as readonly unknown[]) {
    const entries = plainEntries(candidate);
    if (entries === null) return fail("message");
    // `toolUses`, `thinkingBlocks`, `toolUseId` and the like are unknown keys.
    const issue = keyIssue(entries, ["role", "content"], []);
    if (issue !== null)
      return fail(issue === "missing-key" ? "message" : issue);
    const role = entries.get("role");
    const content = entries.get("content");
    if (
      !(MASTRA_AGENT_TURN_ROLES as readonly unknown[]).includes(role) ||
      typeof content !== "string"
    ) {
      return fail("message");
    }
    if (content.length > MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX) {
      return fail("text-too-long");
    }
    total += content.length;
    if (total > MASTRA_AGENT_TURN_TOTAL_TEXT_UTF16_MAX) {
      return fail("text-too-long");
    }
  }
  return { ok: true, total };
}

/**
 * Checks a start request: exactly the twelve keys, a UUID turn ID, a trimmed
 * session ID, the three scope fields (`projectId`, `currentSceneId`,
 * `chatMessageId`), text messages, a supported route, loop values, injected
 * IDs and declared M4 tool names. The returned value is the same object,
 * except that an empty
 * `currentSceneId` is read as `null` (a shallow copy with that one field
 * changed). Nothing else is copied or rewritten.
 */
export function parseMastraAgentTurnStartRequest(
  value: unknown,
): MastraAgentTurnParse<MastraAgentTurnStartRequest> {
  const entries = plainEntries(value);
  if (entries === null) return fail("not-object");
  const issue = keyIssue(entries, START_KEYS, []);
  if (issue !== null) return fail(issue);
  if (!isMastraAgentTurnId(entries.get("turnId"))) return fail("turn-id");
  if (!isTrimmedId(entries.get("chatSessionId"))) {
    return fail("chat-session-id");
  }
  if (!isScopeId(entries.get("projectId"))) return fail("project-id");
  const currentSceneId = entries.get("currentSceneId");
  // An empty string is "no scene" (the chat store's `activeSceneId` can be
  // empty); only a non-empty value is checked as an ID.
  if (
    currentSceneId !== null &&
    currentSceneId !== "" &&
    !isScopeId(currentSceneId)
  ) {
    return fail("current-scene-id");
  }
  if (!isScopeId(entries.get("chatMessageId"))) return fail("chat-message-id");
  const messages = parseMessages(entries.get("messages"));
  if (!messages.ok) return messages;
  const route = parseRoute(entries.get("route"));
  if (!route.ok) return route;
  // The cache segments and the volatile tail are model-visible text too: they
  // count toward the same total as the messages.
  let total = messages.total;
  const segments = entries.get("systemCacheSegments");
  if (
    segments !== null &&
    (!Array.isArray(segments) ||
      segments.length > MASTRA_AGENT_TURN_SEGMENTS_MAX ||
      segments.length !== Object.keys(segments).length ||
      segments.some(
        (segment: unknown) =>
          typeof segment !== "string" ||
          segment.length > MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX,
      ))
  ) {
    return fail("segments");
  }
  for (const segment of (segments ?? []) as readonly string[]) {
    total += segment.length;
  }
  const tail = entries.get("systemVolatileTail");
  if (
    tail !== null &&
    (typeof tail !== "string" ||
      tail.length > MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX)
  ) {
    return fail("volatile-tail");
  }
  if (typeof tail === "string") total += tail.length;
  if (total > MASTRA_AGENT_TURN_TOTAL_TEXT_UTF16_MAX) {
    return fail("text-too-long");
  }
  const fullyInjectedIds = entries.get("fullyInjectedIds");
  if (
    !Array.isArray(fullyInjectedIds) ||
    fullyInjectedIds.length > MASTRA_AGENT_TURN_FULLY_INJECTED_IDS_MAX ||
    fullyInjectedIds.length !== Object.keys(fullyInjectedIds).length
  ) {
    return fail("fully-injected-ids");
  }
  const ids = new Set<string>();
  let idTextLength = 0;
  for (const id of fullyInjectedIds as readonly unknown[]) {
    if (!isScopeId(id) || ids.has(id)) return fail("fully-injected-ids");
    ids.add(id);
    idTextLength += id.length;
  }
  const loop = parseLoop(entries.get("loop"));
  if (!loop.ok) return loop;
  if (
    route.value.requestMaxOutputTokens !== undefined &&
    route.value.requestMaxOutputTokens !==
      loop.value.value.requestMaxOutputTokens
  ) {
    return fail("route-value");
  }
  total += idTextLength + loop.value.textLength;
  if (total > MASTRA_AGENT_TURN_TOTAL_TEXT_UTF16_MAX) {
    return fail("text-too-long");
  }
  const tools = entries.get("tools");
  if (
    !Array.isArray(tools) ||
    tools.length > MASTRA_AGENT_TURN_TOOLS_MAX ||
    tools.length !== Object.keys(tools).length
  ) {
    return fail("tools");
  }
  const toolNames = new Set<string>();
  for (const tool of tools as readonly unknown[]) {
    if (
      !MASTRA_AGENT_TURN_START_TOOL_NAMES.includes(tool as string) ||
      typeof tool !== "string" ||
      toolNames.has(tool)
    ) {
      return fail("tools");
    }
    toolNames.add(tool);
  }
  if (currentSceneId === "") {
    return {
      ok: true,
      value: {
        ...(value as MastraAgentTurnStartRequest),
        currentSceneId: null,
      },
    };
  }
  return { ok: true, value: value as MastraAgentTurnStartRequest };
}

export function parseMastraAgentTurnCancelRequest(
  value: unknown,
): MastraAgentTurnParse<MastraAgentTurnCancelRequest> {
  const entries = plainEntries(value);
  if (entries === null) return fail("not-object");
  const issue = keyIssue(entries, ["turnId"], []);
  if (issue !== null) return fail(issue);
  if (!isMastraAgentTurnId(entries.get("turnId"))) return fail("turn-id");
  return { ok: true, value: value as MastraAgentTurnCancelRequest };
}

function questionFail(issue: MastraAgentTurnQuestionWireIssue) {
  return { ok: false as const, issue };
}

function questionKeyIssue(
  entries: ReadonlyMap<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): MastraAgentTurnQuestionWireIssue | null {
  for (const key of entries.keys()) {
    if (!required.includes(key) && !optional.includes(key))
      return "unknown-key";
  }
  for (const key of required) {
    if (!entries.has(key)) return "missing-key";
  }
  return null;
}

function isQuestionWireId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MASTRA_AGENT_TURN_QUESTION_ID_UTF16_MAX ||
    value.trim() !== value
  ) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function isBoundedQuestionJson(
  value: unknown,
  limits: {
    readonly text: number;
    readonly nodes: number;
    readonly depth: number;
    readonly array: number;
  },
): boolean {
  const active = new WeakSet<object>();
  let nodes = 0;
  let text = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > limits.nodes || depth > limits.depth) return false;
    if (typeof candidate === "string") {
      text += candidate.length;
      return text <= limits.text;
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return true;
    }
    if (typeof candidate !== "object") return false;
    if (active.has(candidate)) return false;
    active.add(candidate);
    let valid = true;
    if (Array.isArray(candidate)) {
      if (
        Object.getPrototypeOf(candidate) !== Array.prototype ||
        candidate.length > limits.array
      ) {
        valid = false;
      } else {
        let enumerable = 0;
        for (const key of Reflect.ownKeys(candidate)) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (!descriptor) {
            valid = false;
            break;
          }
          if (!descriptor.enumerable) continue;
          if (
            typeof key !== "string" ||
            !/^(0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= candidate.length ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined
          ) {
            valid = false;
            break;
          }
          enumerable += 1;
          if (!visit(descriptor.value, depth + 1)) {
            valid = false;
            break;
          }
        }
        if (enumerable !== candidate.length) valid = false;
      }
    } else {
      const entries = plainEntries(candidate);
      if (
        entries === null ||
        entries.has("__proto__") ||
        entries.has("constructor")
      ) {
        valid = false;
      } else {
        for (const [key, item] of entries) {
          text += key.length;
          if (
            text > limits.text ||
            key.length > MASTRA_AGENT_TURN_QUESTION_ID_UTF16_MAX ||
            !visit(item, depth + 1)
          ) {
            valid = false;
            break;
          }
        }
      }
    }
    active.delete(candidate);
    return valid;
  };
  return visit(value, 0);
}

type MastraUiToolSchema = ReturnType<
  typeof createMastraUiToolDefinitions
>[number]["inputSchema"];

function matchesMastraUiSchema(
  value: unknown,
  schema: MastraUiToolSchema,
): boolean {
  const entries = plainEntries(value);
  if (entries === null || schema.type !== "object") return false;
  const properties = schema.properties;
  if (
    [...entries.keys()].some((key) => !Object.hasOwn(properties, key)) ||
    schema.required.some((key) => !entries.has(key))
  ) {
    return false;
  }
  const matches = (
    candidate: unknown,
    field: (typeof properties)[string],
  ): boolean => {
    if (field.type === "object") {
      const nested = plainEntries(candidate);
      if (nested === null || !field.properties) return false;
      if (
        [...nested.keys()].some(
          (key) => !Object.hasOwn(field.properties!, key),
        ) ||
        (field.required ?? []).some((key) => !nested.has(key))
      ) {
        return false;
      }
      return [...nested].every(([key, child]) =>
        matches(child, field.properties![key]!),
      );
    }
    if (field.type === "array") {
      return (
        Array.isArray(candidate) &&
        candidate.length <= MASTRA_AGENT_TURN_QUESTION_ARRAY_MAX &&
        candidate.length === Object.keys(candidate).length &&
        field.items !== undefined &&
        candidate.every((item) => matches(item, field.items!))
      );
    }
    if (field.type === "string") {
      return (
        typeof candidate === "string" &&
        candidate.length <= MASTRA_AGENT_TURN_QUESTION_TEXT_UTF16_MAX &&
        (!field.enum || field.enum.includes(candidate))
      );
    }
    return field.type === "boolean" && typeof candidate === "boolean";
  };
  return [...entries].every(([key, child]) => matches(child, properties[key]!));
}

function hasMastraUiToolArgumentBounds(
  toolName: MastraAgentTurnQuestionToolName,
  args: Readonly<Record<string, unknown>>,
): boolean {
  if (toolName === "get_app_help_index") {
    return (
      args.query === undefined ||
      (typeof args.query === "string" &&
        args.query.length <= MASTRA_AGENT_TURN_QUESTION_FIELD_UTF16_MAX)
    );
  }
  if (toolName === "get_app_help") {
    return (
      typeof args.id === "string" &&
      args.id.length <= MASTRA_AGENT_TURN_QUESTION_FIELD_UTF16_MAX
    );
  }
  if (toolName === "run_app_command") {
    return (
      typeof args.command === "string" &&
      args.command.length <= MASTRA_AGENT_TURN_QUESTION_FIELD_UTF16_MAX
    );
  }
  if (toolName === "apply_layout_preset") {
    return (
      typeof args.preset === "string" &&
      args.preset.length <= MASTRA_AGENT_TURN_QUESTION_FIELD_UTF16_MAX
    );
  }
  if (toolName === "propose_setting_change") {
    return (
      typeof args.key === "string" &&
      typeof args.value === "string" &&
      args.value.length <= MASTRA_AGENT_TURN_QUESTION_TEXT_UTF16_MAX &&
      (args.reason === undefined ||
        (typeof args.reason === "string" &&
          args.reason.length <= MASTRA_AGENT_TURN_QUESTION_FIELD_UTF16_MAX))
    );
  }
  if (toolName === "ask_user") {
    const questions = args.questions;
    return (
      Array.isArray(questions) &&
      questions.length > 0 &&
      questions.length <= MASTRA_AGENT_TURN_QUESTION_ARRAY_MAX &&
      questions.every((question) => {
        const fields = plainEntries(question);
        if (fields === null) return false;
        const header = fields.get("header");
        const options = fields.get("options");
        return (
          (header === undefined ||
            (typeof header === "string" &&
              header.length <= MASTRA_AGENT_TURN_QUESTION_FIELD_UTF16_MAX)) &&
          (options === undefined ||
            (Array.isArray(options) &&
              options.length <= MASTRA_AGENT_TURN_QUESTION_OPTIONS_MAX &&
              options.every(
                (option) =>
                  typeof option === "string" &&
                  option.length <= MASTRA_AGENT_TURN_QUESTION_OPTION_UTF16_MAX,
              )))
        );
      })
    );
  }
  return true;
}

/** Parse Main's question event. Arguments are checked against the closed shared UI schemas. */
export function parseMastraAgentTurnQuestionPayload(
  value: unknown,
): MastraAgentTurnQuestionParse<MastraAgentTurnQuestionPayload> {
  const entries = plainEntries(value);
  if (entries === null) return questionFail("not-object");
  const issue = questionKeyIssue(entries, [
    "turnId",
    "requestId",
    "toolCallId",
    "toolName",
    "args",
    "deadlineAt",
  ]);
  if (issue !== null) return questionFail(issue);
  const turnId = entries.get("turnId");
  const requestId = entries.get("requestId");
  const toolCallId = entries.get("toolCallId");
  const toolName = entries.get("toolName");
  const args = entries.get("args");
  const deadlineAt = entries.get("deadlineAt");
  if (!isMastraAgentTurnId(turnId)) return questionFail("turn-id");
  if (!isMastraAgentTurnId(requestId)) return questionFail("request-id");
  if (!isQuestionWireId(toolCallId)) return questionFail("tool-call-id");
  if (!(MASTRA_UI_TOOL_NAMES as readonly unknown[]).includes(toolName)) {
    return questionFail("tool-name");
  }
  const tool = MASTRA_UI_TOOL_DEFINITION_MAP.get(toolName as string);
  if (
    !tool ||
    !matchesMastraUiSchema(args, tool.inputSchema) ||
    !isBoundedQuestionJson(args, {
      text: MASTRA_AGENT_TURN_QUESTION_ARGS_UTF16_MAX,
      nodes: MASTRA_AGENT_TURN_QUESTION_JSON_NODES_MAX,
      depth: MASTRA_AGENT_TURN_QUESTION_JSON_DEPTH_MAX,
      array: MASTRA_AGENT_TURN_QUESTION_OPTIONS_MAX,
    }) ||
    !hasMastraUiToolArgumentBounds(
      toolName as MastraAgentTurnQuestionToolName,
      args as Readonly<Record<string, unknown>>,
    )
  ) {
    return questionFail("args");
  }
  const maxFuture =
    toolName === "ask_user"
      ? MASTRA_AGENT_TURN_ASK_USER_TIMEOUT_MS
      : MASTRA_AGENT_TURN_UI_TOOL_TIMEOUT_MS;
  if (
    !isNonNegativeSafeInteger(deadlineAt) ||
    deadlineAt - Date.now() > maxFuture
  ) {
    return questionFail("deadline");
  }
  return { ok: true, value: value as MastraAgentTurnQuestionPayload };
}

function isMastraAgentTurnUiToolResult(
  value: unknown,
): value is MastraAgentTurnUiToolResult {
  const entries = plainEntries(value);
  if (
    entries === null ||
    questionKeyIssue(
      entries,
      ["toolCallId", "name", "content", "summary", "tokensUsed"],
      ["error", "undoId", "settingProposal"],
    ) !== null
  ) {
    return false;
  }
  const name = entries.get("name");
  const content = entries.get("content");
  const summary = entries.get("summary");
  const tokensUsed = entries.get("tokensUsed");
  if (
    !isQuestionWireId(entries.get("toolCallId")) ||
    !(MASTRA_UI_TOOL_NAMES as readonly unknown[]).includes(name) ||
    !isBoundedQuestionJson(content, {
      text: MASTRA_AGENT_TURN_ANSWER_CONTENT_UTF16_MAX,
      nodes: MASTRA_AGENT_TURN_ANSWER_JSON_NODES_MAX,
      depth: MASTRA_AGENT_TURN_ANSWER_JSON_DEPTH_MAX,
      array: MASTRA_AGENT_TURN_ANSWER_ARRAY_MAX,
    }) ||
    typeof summary !== "string" ||
    summary.length > MASTRA_AGENT_TURN_ANSWER_TEXT_UTF16_MAX ||
    !isNonNegativeSafeInteger(tokensUsed) ||
    tokensUsed > MASTRA_AGENT_TURN_ANSWER_TOKENS_MAX
  ) {
    return false;
  }
  if (
    entries.has("error") &&
    (typeof entries.get("error") !== "string" ||
      (entries.get("error") as string).length >
        MASTRA_AGENT_TURN_ANSWER_TEXT_UTF16_MAX)
  ) {
    return false;
  }
  if (entries.has("undoId") && !isQuestionWireId(entries.get("undoId"))) {
    return false;
  }
  if (entries.has("settingProposal")) {
    const proposal = plainEntries(entries.get("settingProposal"));
    if (
      proposal === null ||
      questionKeyIssue(proposal, ["id", "key", "value"], ["reason"]) !== null ||
      !isQuestionWireId(proposal.get("id")) ||
      typeof proposal.get("key") !== "string" ||
      !AGENT_SETTING_KEYS.includes(proposal.get("key") as string) ||
      typeof proposal.get("value") !== "string" ||
      (proposal.get("value") as string).length >
        MASTRA_AGENT_TURN_QUESTION_TEXT_UTF16_MAX ||
      (proposal.has("reason") &&
        (typeof proposal.get("reason") !== "string" ||
          (proposal.get("reason") as string).length >
            MASTRA_AGENT_TURN_QUESTION_FIELD_UTF16_MAX))
    ) {
      return false;
    }
  }
  return true;
}

/** Parse the renderer's result or authority refusal. `approved` and `resumeData` are unknown keys. */
export function parseMastraAgentTurnAnswerRequest(
  value: unknown,
): MastraAgentTurnQuestionParse<MastraAgentTurnAnswerRequest> {
  const entries = plainEntries(value);
  if (entries === null) return questionFail("not-object");
  const issue = questionKeyIssue(entries, ["requestId"], ["result", "refusal"]);
  if (issue !== null) return questionFail(issue);
  if (!isMastraAgentTurnId(entries.get("requestId"))) {
    return questionFail("request-id");
  }
  if (entries.has("result") === entries.has("refusal")) {
    return questionFail("missing-key");
  }
  if (entries.has("result")) {
    return isMastraAgentTurnUiToolResult(entries.get("result"))
      ? { ok: true, value: value as MastraAgentTurnAnswerRequest }
      : questionFail("result");
  }
  return entries.get("refusal") === "authority-revoked"
    ? { ok: true, value: value as MastraAgentTurnAnswerRequest }
    : questionFail("refusal");
}

/** Parse Main's answer-command response. */
export function parseMastraAgentTurnAnswerResult(
  value: unknown,
): MastraAgentTurnAnswerResult | null {
  const entries = plainEntries(value);
  if (entries === null) return null;
  if (entries.get("status") === "accepted") {
    return sameKeys(entries, ["status", "requestId"]) &&
      isMastraAgentTurnId(entries.get("requestId"))
      ? (value as MastraAgentTurnAnswerResult)
      : null;
  }
  return entries.get("status") === "refused" &&
    sameKeys(entries, ["status", "reason"]) &&
    (entries.get("reason") === "invalid" ||
      entries.get("reason") === "no-pending")
    ? (value as MastraAgentTurnAnswerResult)
    : null;
}

// ---------------------------------------------------------------------------
// The check of a result (the renderer's wrapper).
// ---------------------------------------------------------------------------

function isRefusalReason(
  value: unknown,
): value is MastraAgentTurnRefusalReason {
  return (MASTRA_AGENT_TURN_REFUSAL_REASONS as readonly unknown[]).includes(
    value,
  );
}

function sameKeys(
  entries: ReadonlyMap<string, unknown>,
  keys: readonly string[],
): boolean {
  return entries.size === keys.length && keys.every((key) => entries.has(key));
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafePlainRecord(value: unknown): value is Record<string, unknown> {
  const entries = plainEntries(value);
  return (
    entries !== null && !entries.has("__proto__") && !entries.has("constructor")
  );
}

function isToolCallRecord(
  value: unknown,
): value is MastraAgentTurnToolCallRecord {
  const entries = plainEntries(value);
  if (entries === null) return false;
  const issue = keyIssue(
    entries,
    ["name", "params", "resultSummary", "tokensUsed"],
    ["undoId", "settingProposal", "content"],
  );
  return (
    issue === null &&
    typeof entries.get("name") === "string" &&
    isSafePlainRecord(entries.get("params")) &&
    typeof entries.get("resultSummary") === "string" &&
    isNonNegativeFiniteNumber(entries.get("tokensUsed")) &&
    (!entries.has("undoId") || typeof entries.get("undoId") === "string") &&
    (!entries.has("content") ||
      isBoundedLoopResultJson(entries.get("content"))) &&
    (!entries.has("settingProposal") ||
      isSafePlainRecord(entries.get("settingProposal")))
  );
}

function isBoundedArray<T>(
  value: unknown,
  maximum: number,
  isItem: (item: unknown) => item is T,
): value is readonly T[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.length !== Object.keys(value).length
  ) {
    return false;
  }
  for (const item of value as readonly unknown[]) {
    if (!isItem(item)) return false;
  }
  return true;
}

/**
 * Legacy has no aggregate result bound; reuse the request text ceiling and
 * cap JSON work so a single returned value cannot exhaust Main's parser.
 */
function isBoundedLoopResultJson(value: unknown): boolean {
  const pending: Array<{ value?: unknown; depth: number; leave?: object }> = [
    { value, depth: 0 },
  ];
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let queuedNodes = 1;
  let textLength = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.leave) {
      ancestors.delete(current.leave);
      continue;
    }
    queuedNodes -= 1;
    nodes += 1;
    if (
      nodes > MASTRA_AGENT_TURN_LOOP_RESULT_JSON_NODES_MAX ||
      current.depth > MASTRA_AGENT_TURN_LOOP_RESULT_JSON_DEPTH_MAX
    ) {
      return false;
    }
    if (typeof current.value === "string") {
      textLength += current.value.length;
    } else if (
      current.value === null ||
      typeof current.value === "boolean" ||
      (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      continue;
    } else if (typeof current.value === "object") {
      const object = current.value;
      if (ancestors.has(object)) return false;
      ancestors.add(object);
      pending.push({ leave: object, depth: current.depth });
      const isArray = Array.isArray(object);
      const prototype = Object.getPrototypeOf(object);
      if (!isArray && prototype !== Object.prototype && prototype !== null) {
        return false;
      }
      const keys = Reflect.ownKeys(object);
      let enumerableKeys = 0;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor) return false;
        if (!descriptor.enumerable) continue;
        if (typeof key !== "string" || descriptor.get || descriptor.set) {
          return false;
        }
        enumerableKeys += 1;
        if (!isArray) textLength += key.length;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
        queuedNodes += 1;
        if (
          nodes + queuedNodes >
          MASTRA_AGENT_TURN_LOOP_RESULT_JSON_NODES_MAX
        ) {
          return false;
        }
      }
      if (isArray && enumerableKeys !== object.length) return false;
    } else {
      return false;
    }
    if (textLength > MASTRA_AGENT_TURN_TOTAL_TEXT_UTF16_MAX) return false;
  }
  return true;
}

/** The answer of Main's start, or `null` when it is not an answer of this route. */
export function parseMastraAgentTurnStartResult(
  value: unknown,
): MastraAgentTurnStartResult | null {
  const entries = plainEntries(value);
  if (entries === null) return null;
  if (entries.get("status") === "refused") {
    return sameKeys(entries, ["status", "command", "reason"]) &&
      entries.get("command") === "start" &&
      isRefusalReason(entries.get("reason"))
      ? (value as MastraAgentTurnStartResult)
      : null;
  }
  if (entries.get("status") === "completed") {
    const response = entries.get("response");
    const hasLoopResult = entries.has("loopResult");
    const loopResult = hasLoopResult
      ? parseMastraAgentTurnLoopResult(entries.get("loopResult"))
      : null;
    return (hasLoopResult
      ? loopResult !== null &&
        sameKeys(entries, [
          "status",
          "turnId",
          "executionId",
          "response",
          "loopResult",
        ])
      : sameKeys(entries, ["status", "turnId", "executionId", "response"])) &&
      isMastraAgentTurnId(entries.get("turnId")) &&
      isTrimmedId(entries.get("executionId")) &&
      plainEntries(response) !== null
      ? (value as MastraAgentTurnStartResult)
      : null;
  }
  if (entries.get("status") === "context-window-exceeded") {
    const usage = parseProgressUsage(entries.get("usage"));
    const overflowTokens = entries.get("overflowTokens");
    return sameKeys(entries, ["status", "turnId", "usage", "overflowTokens"]) &&
      isMastraAgentTurnId(entries.get("turnId")) &&
      usage !== null &&
      isNonNegativeSafeInteger(overflowTokens) &&
      overflowTokens > 0 &&
      overflowTokens === usage.overflowTokens
      ? (value as MastraAgentTurnStartResult)
      : null;
  }
  return null;
}

/** The loop's aggregate metadata, separate from Main's existing raw start answer. */
export function parseMastraAgentTurnLoopResult(
  value: unknown,
): MastraAgentTurnLoopResult | null {
  if (!isBoundedLoopResultJson(value)) return null;
  const entries = plainEntries(value);
  if (
    entries === null ||
    !sameKeys(entries, [
      "finalText",
      "toolCallRecords",
      "stoppedReason",
      "usage",
      "citations",
      "finalThinkingBlocks",
    ])
  ) {
    return null;
  }
  if (typeof entries.get("finalText") !== "string") return null;
  const toolCallRecords = entries.get("toolCallRecords");
  if (
    !isBoundedArray(
      toolCallRecords,
      MASTRA_AGENT_TURN_LOOP_RESULT_ARRAY_MAX,
      isToolCallRecord,
    )
  ) {
    return null;
  }
  if (
    !(MASTRA_AGENT_TURN_STOPPED_REASONS as readonly unknown[]).includes(
      entries.get("stoppedReason"),
    )
  ) {
    return null;
  }
  const usage = plainEntries(entries.get("usage"));
  if (
    usage === null ||
    !sameKeys(usage, ["totalTokens", "tokensIn", "tokensOut", "cost"]) ||
    !isNonNegativeFiniteNumber(usage.get("totalTokens")) ||
    !(
      usage.get("tokensIn") === null ||
      isNonNegativeFiniteNumber(usage.get("tokensIn"))
    ) ||
    !(
      usage.get("tokensOut") === null ||
      isNonNegativeFiniteNumber(usage.get("tokensOut"))
    ) ||
    !(
      usage.get("cost") === null || isNonNegativeFiniteNumber(usage.get("cost"))
    )
  ) {
    return null;
  }
  if (
    !isBoundedArray(
      entries.get("citations"),
      MASTRA_AGENT_TURN_LOOP_RESULT_ARRAY_MAX,
      isSafePlainRecord,
    ) ||
    !isBoundedArray(
      entries.get("finalThinkingBlocks"),
      MASTRA_AGENT_TURN_LOOP_RESULT_ARRAY_MAX,
      (item): item is MastraAgentTurnThinkingBlock => {
        const block = plainEntries(item);
        return (
          block !== null &&
          sameKeys(block, ["thinking", "signature"]) &&
          typeof block.get("thinking") === "string" &&
          typeof block.get("signature") === "string" &&
          block.get("signature") !== ""
        );
      },
    )
  ) {
    return null;
  }
  return value as MastraAgentTurnLoopResult;
}

/** The answer of Main's cancel, or `null` when it is not an answer of this route. */
export function parseMastraAgentTurnCancelResult(
  value: unknown,
): MastraAgentTurnCancelResult | null {
  const entries = plainEntries(value);
  if (entries === null) return null;
  if (entries.get("status") === "refused") {
    return sameKeys(entries, ["status", "command", "reason"]) &&
      entries.get("command") === "cancel" &&
      isRefusalReason(entries.get("reason"))
      ? (value as MastraAgentTurnCancelResult)
      : null;
  }
  if (entries.get("status") === "ok") {
    return sameKeys(entries, ["status", "turnId", "found"]) &&
      isMastraAgentTurnId(entries.get("turnId")) &&
      typeof entries.get("found") === "boolean"
      ? (value as MastraAgentTurnCancelResult)
      : null;
  }
  return null;
}

/** Numeric-only ContextWindowUsage projection sent during a turn. */
export interface MastraAgentTurnProgressUsage {
  readonly contextTokens: number;
  readonly toolTokens: number;
  readonly envelopeTokens: number;
  readonly safetyMarginTokens: number;
  readonly inputTokens: number;
  readonly outputReservedTokens: number;
  readonly reservedTotalTokens: number;
  readonly contextWindow: number;
  readonly remainingTokens: number;
  readonly overflowTokens: number;
}

export type MastraAgentTurnProgressEvent =
  | {
      readonly kind: "send-accepted";
      readonly sendIndex: number;
      readonly usage: MastraAgentTurnProgressUsage;
      readonly cacheDowngradeReason: "budget" | "too-many-blocks" | null;
    }
  | {
      readonly kind: "tool";
      readonly phase: "started" | "finished";
      readonly toolCallId: string;
      readonly toolName: M4ReadToolName;
      readonly totalCalls: number;
      readonly maxCalls: number;
      readonly tokensUsed: number;
      readonly tokenBudget: number;
    }
  | {
      readonly kind: "context-overflow";
      readonly usage: MastraAgentTurnProgressUsage;
      readonly overflowTokens: number;
      readonly cacheDowngradeReason: "budget" | "too-many-blocks" | null;
    }
  | { readonly kind: "stopped"; readonly reason: "user-stop" };

export interface MastraAgentTurnProgressPayload {
  readonly turnId: string;
  readonly sequence: number;
  readonly event: MastraAgentTurnProgressEvent;
}

const PROGRESS_USAGE_KEYS = [
  "contextTokens",
  "toolTokens",
  "envelopeTokens",
  "safetyMarginTokens",
  "inputTokens",
  "outputReservedTokens",
  "reservedTotalTokens",
  "contextWindow",
  "remainingTokens",
  "overflowTokens",
] as const;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseProgressUsage(
  value: unknown,
): MastraAgentTurnProgressUsage | null {
  const entries = plainEntries(value);
  if (
    entries === null ||
    keyIssue(entries, PROGRESS_USAGE_KEYS, []) !== null ||
    !PROGRESS_USAGE_KEYS.every(
      (key) =>
        key === "remainingTokens" || isNonNegativeSafeInteger(entries.get(key)),
    )
  ) {
    return null;
  }
  const remainingTokens = entries.get("remainingTokens");
  if (!Number.isSafeInteger(remainingTokens)) return null;
  const contextTokens = entries.get("contextTokens") as number;
  const toolTokens = entries.get("toolTokens") as number;
  const envelopeTokens = entries.get("envelopeTokens") as number;
  const safetyMarginTokens = entries.get("safetyMarginTokens") as number;
  const inputTokens = entries.get("inputTokens") as number;
  const outputReservedTokens = entries.get("outputReservedTokens") as number;
  const reservedTotalTokens = entries.get("reservedTotalTokens") as number;
  const contextWindow = entries.get("contextWindow") as number;
  const overflowTokens = entries.get("overflowTokens") as number;
  if (
    contextTokens + toolTokens + envelopeTokens !== inputTokens ||
    inputTokens + outputReservedTokens + safetyMarginTokens !==
      reservedTotalTokens ||
    reservedTotalTokens + (remainingTokens as number) !== contextWindow ||
    Math.max(0, -(remainingTokens as number)) !== overflowTokens
  ) {
    return null;
  }
  return value as MastraAgentTurnProgressUsage;
}

function parseProgressEvent(
  value: unknown,
): MastraAgentTurnProgressEvent | null {
  const entries = plainEntries(value);
  if (entries === null) return null;
  const kind = entries.get("kind");
  if (kind === "send-accepted") {
    if (
      keyIssue(
        entries,
        ["kind", "sendIndex", "usage", "cacheDowngradeReason"],
        [],
      ) !== null
    ) {
      return null;
    }
    const sendIndex = entries.get("sendIndex");
    const cacheDowngradeReason = entries.get("cacheDowngradeReason");
    const usage = parseProgressUsage(entries.get("usage"));
    return isNonNegativeSafeInteger(sendIndex) &&
      sendIndex > 0 &&
      sendIndex <= MASTRA_AGENT_TURN_LOOP_NUMBER_MAX &&
      (cacheDowngradeReason === null ||
        cacheDowngradeReason === "budget" ||
        cacheDowngradeReason === "too-many-blocks") &&
      usage !== null
      ? (value as MastraAgentTurnProgressEvent)
      : null;
  }
  if (kind === "tool") {
    if (
      keyIssue(
        entries,
        [
          "kind",
          "phase",
          "toolCallId",
          "toolName",
          "totalCalls",
          "maxCalls",
          "tokensUsed",
          "tokenBudget",
        ],
        [],
      ) !== null
    ) {
      return null;
    }
    const totalCalls = entries.get("totalCalls");
    const maxCalls = entries.get("maxCalls");
    const tokensUsed = entries.get("tokensUsed");
    const tokenBudget = entries.get("tokenBudget");
    const toolCallId = entries.get("toolCallId");
    return (entries.get("phase") === "started" ||
      entries.get("phase") === "finished") &&
      isProgressToolCallId(toolCallId) &&
      (M4_READ_TOOL_NAMES as readonly unknown[]).includes(
        entries.get("toolName"),
      ) &&
      isNonNegativeSafeInteger(totalCalls) &&
      totalCalls <= MASTRA_AGENT_TURN_LOOP_NUMBER_MAX &&
      isNonNegativeSafeInteger(maxCalls) &&
      maxCalls > 0 &&
      maxCalls <= MASTRA_AGENT_TURN_LOOP_NUMBER_MAX &&
      isNonNegativeSafeInteger(tokensUsed) &&
      isNonNegativeSafeInteger(tokenBudget) &&
      tokenBudget > 0
      ? (value as MastraAgentTurnProgressEvent)
      : null;
  }
  if (kind === "context-overflow") {
    if (
      keyIssue(
        entries,
        ["kind", "usage", "overflowTokens", "cacheDowngradeReason"],
        [],
      ) !== null
    ) {
      return null;
    }
    const usage = parseProgressUsage(entries.get("usage"));
    const overflowTokens = entries.get("overflowTokens");
    const cacheDowngradeReason = entries.get("cacheDowngradeReason");
    return usage !== null &&
      isNonNegativeSafeInteger(overflowTokens) &&
      overflowTokens > 0 &&
      overflowTokens === usage.overflowTokens &&
      (cacheDowngradeReason === null ||
        cacheDowngradeReason === "budget" ||
        cacheDowngradeReason === "too-many-blocks")
      ? (value as MastraAgentTurnProgressEvent)
      : null;
  }
  if (kind === "stopped") {
    return keyIssue(entries, ["kind", "reason"], []) === null &&
      entries.get("reason") === "user-stop"
      ? (value as MastraAgentTurnProgressEvent)
      : null;
  }
  return null;
}

/** Checks the exact main-to-renderer progress envelope and its numeric-only event. */
export function parseMastraAgentTurnProgressPayload(
  value: unknown,
): MastraAgentTurnParse<MastraAgentTurnProgressPayload> {
  const entries = plainEntries(value);
  if (entries === null) return fail("not-object");
  const issue = keyIssue(entries, ["turnId", "sequence", "event"], []);
  if (issue !== null) return fail(issue);
  if (!isMastraAgentTurnId(entries.get("turnId"))) return fail("turn-id");
  const sequence = entries.get("sequence");
  if (!isNonNegativeSafeInteger(sequence) || sequence === 0) {
    return fail("progress-sequence");
  }
  const event = parseProgressEvent(entries.get("event"));
  if (event === null) return fail("progress-event");
  return { ok: true, value: value as MastraAgentTurnProgressPayload };
}
