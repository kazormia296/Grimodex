/**
 * The wire of the Mastra agent turn route (MP-3b, DR-MP3-4, -24): the two
 * commands, the request each carries, the typed results and the check of a
 * request.
 *
 * The renderer sends a request and Main re-checks it with the same parser
 * (`mastraAgentTurnGate.ts`). The route is closed in every product launch: a
 * closed gate answers `gate-closed` before anything else is read, and in 3b
 * even an opened gate (the journey seam) answers `unsupported`, because the
 * turn owner is 3c's. A refusal is an `ok:true` value, not an error: the
 * renderer falls back to the legacy route on any of them.
 *
 * This file has no import: the renderer and `electron/tsconfig.json` both
 * compile it. It never echoes a value of a request back in an issue: an issue
 * is a fixed code and, for a field, the name of one of the keys below.
 *
 * What a request cannot carry (DR-MP3-4, -5): `capability`, `auditContext`,
 * `pathId`, `executionId` and `callerIdentity` are Main's. Main issues the
 * execution ID, the audit correlation and the caller identity; a renderer that
 * sends one is refused (`invalid`), never ignored.
 */

export const MASTRA_AGENT_TURN_START_COMMAND = "mastra_agent_turn_start";
export const MASTRA_AGENT_TURN_CANCEL_COMMAND = "mastra_agent_turn_cancel";
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

/** Keys a renderer must never send: they are Main's (DR-MP3-4, -5, -23). */
export const MASTRA_AGENT_TURN_FORBIDDEN_KEYS = [
  "capability",
  "capabilities",
  "auditContext",
  "pathId",
  "executionId",
  "callerIdentity",
] as const;

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
  readonly messages: readonly MastraAgentTurnMessage[];
  readonly route: MastraAgentTurnRoute;
  readonly systemCacheSegments: readonly string[] | null;
  readonly systemVolatileTail: string | null;
  /** Always empty: this route is tool 0 (MP-3). A turn with a tool goes to the legacy route. */
  readonly tools: readonly [];
}

const START_KEYS = [
  "turnId",
  "chatSessionId",
  "messages",
  "route",
  "systemCacheSegments",
  "systemVolatileTail",
  "tools",
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
  | "messages"
  | "message"
  | "text-too-long"
  | "route"
  | "provider"
  | "route-value"
  | "segments"
  | "volatile-tail"
  | "tools";

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
 * `keyIssue` refuses as forbidden when this parser sees the raw request.
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

function isTrimmedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MASTRA_AGENT_TURN_ID_UTF16_MAX &&
    value === value.trim()
  );
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
      tokens > 4_294_967_295
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

function parseMessages(
  value: unknown,
): MastraAgentTurnParse<readonly MastraAgentTurnMessage[]> {
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
  return { ok: true, value: value as readonly MastraAgentTurnMessage[] };
}

/**
 * Checks a start request: exactly the seven keys, a UUID turn ID, a trimmed
 * session ID, text messages, a route of a supported provider, and no tool.
 * The returned value is the same object (nothing is copied or rewritten).
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
  const messages = parseMessages(entries.get("messages"));
  if (!messages.ok) return messages;
  const route = parseRoute(entries.get("route"));
  if (!route.ok) return route;
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
  const tail = entries.get("systemVolatileTail");
  if (
    tail !== null &&
    (typeof tail !== "string" ||
      tail.length > MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX)
  ) {
    return fail("volatile-tail");
  }
  const tools = entries.get("tools");
  // Tool 0: the only tools array of this route is the empty one.
  if (!Array.isArray(tools) || tools.length !== 0) return fail("tools");
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
    return sameKeys(entries, ["status", "turnId", "executionId", "response"]) &&
      isMastraAgentTurnId(entries.get("turnId")) &&
      isTrimmedId(entries.get("executionId")) &&
      plainEntries(response) !== null
      ? (value as MastraAgentTurnStartResult)
      : null;
  }
  return null;
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
