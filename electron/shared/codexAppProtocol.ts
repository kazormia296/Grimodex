/**
 * Codex app-server の wire contract と、renderer/main 間で共有する正規化型。
 *
 * app-server の生成型は Codex のインストールバージョンとずれる可能性があるため、
 * ここでは wire を unknown として受け、main 側で最小限の runtime validation を行う。
 */

export type JsonRpcId = string | number;

/** A renderer request was captured for a workspace that is no longer active. */
export const CODEX_APP_SERVER_WORKSPACE_STALE_CODE =
  "CODEX_APP_SERVER_WORKSPACE_STALE";

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  /** Codex omits this header; explicit JSON-RPC peers may still include it. */
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorShape;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export type CodexAppServerTransport = "exec" | "app-server" | "auto";

export type CodexAppServerState =
  | "stopped"
  | "starting"
  | "ready"
  | "failed"
  | "closing";

export interface CodexAppServerStatus {
  state: CodexAppServerState;
  version: string | null;
  lastError: string | null;
  startedAt: string | null;
}

export interface CodexModel {
  id: string;
  name: string;
  description?: string;
}

export interface CodexRuntimeThreadBinding {
  sessionId: string;
  runtime: string;
  externalThreadId: string;
  projectId: string;
  historyRevision: string | null;
  lastTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartCodexAppTurnPayload {
  projectId: string;
  sessionId: string;
  /** Renderer-captured workspace identity used only as a main-side equality precondition. */
  expectedWorkspacePath: string;
  grimodexTurnId: string;
  clientUserMessageId: string;
  model?: string;
  effort?: string;
  contextPacket: string;
  bootstrapHistory?: string;
  historyRevision: string;
  userMessage: string;
  /** Injected by the audited renderer transport before the main IPC call. */
  auditContext?: CodexAppAuditContext;
}

export interface CodexAppAuditContext {
  expectedWorkspacePath: string;
  projectId: string;
  operationId: string;
  executionId: string;
  parentExecutionId: string | null;
  pathId: string;
}

/**
 * Main-to-renderer result for starting a turn.
 *
 * `rejected-before-turn` is intentionally a resolved result instead of a
 * generic IPC rejection. Main emits it only when it can prove that no
 * `turn/start` request was accepted, which makes an `auto` transport fallback
 * safe from duplicate execution.
 */
export type StartCodexAppTurnResult =
  | {
      status: "started";
      codexThreadId: string;
      codexTurnId: string;
      reusedThread: boolean;
    }
  | {
      status: "rejected-before-turn";
      code: string;
      message: string;
    };

/**
 * Main-owned evidence durably captured immediately before each model-affecting
 * remote RPC. It contains only the exact Grimodex-authored text sent by that
 * RPC plus explicitly separated transport observations. App Server prompts,
 * built-in tool schemas, negotiated MCP schemas, and provider-private
 * reasoning remain outside Grimodex's observation boundary.
 */
export interface CodexAppEffectiveRequestReceipt {
  rpcMethod: "thread/start" | "thread/resume" | "turn/start";
  provider: "cli";
  model: string | null;
  effort: string | null;
  modelVisibleMessages: Array<{ role: string; content: string }>;
  approvalPolicy: "never" | "on-request";
  sandboxMode: "read-only";
  networkAccess: false | null;
  retryWithoutMcp: boolean;
  mcpObservation: {
    inheritedThreadConfigurationUnobserved: boolean;
    configurationIncluded: boolean;
    serverName: "grimodex" | null;
    command: string | null;
    args: string[];
    mcpServerEnvExcluded: true;
    toolSchemasObserved: false;
  };
  captureState: "partial";
  limitations: string[];
}

export interface InterruptCodexAppTurnPayload {
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
}

export interface AdvanceCodexHistoryRevisionPayload {
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
  codexThreadId: string;
  codexTurnId: string;
  expectedHistoryRevision: string;
  nextHistoryRevision: string;
}

export interface AdvanceCodexHistoryRevisionResult {
  status: "advanced" | "already-advanced";
}

export interface RespondCodexServerRequestPayload {
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
  requestId: JsonRpcId;
  decision: "accept" | "decline";
}

export interface SetCodexThreadNamePayload {
  projectId: string;
  sessionId: string;
  /** Renderer-captured workspace identity used only as a main-side equality precondition. */
  expectedWorkspacePath: string;
  name: string;
}

export interface ArchiveCodexSessionThreadPayload {
  projectId: string;
  sessionId: string;
  /** Renderer-captured workspace identity used only as a main-side equality precondition. */
  expectedWorkspacePath: string;
}

export type CodexAppEvent =
  | {
      type: "thread-started";
      threadId: string;
    }
  | {
      type: "turn-started";
      turnId: string;
    }
  | {
      type: "text-delta";
      delta: string;
    }
  | {
      type: "thinking-delta";
      delta: string;
    }
  | {
      type: "item-started";
      item: CodexAppItem;
    }
  | {
      type: "item-completed";
      item: CodexAppItem;
    }
  | {
      type: "usage";
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens?: number | null;
    }
  | {
      type: "approval-requested";
      requestId: JsonRpcId;
      kind: "command" | "file-change" | "permission" | "user-input";
      title: string;
      summary: string;
      command?: string[];
      affectedPaths?: string[];
      diff?: string;
    }
  | {
      type: "turn-completed";
      stopReason: string;
      inputTokens?: number | null;
      outputTokens?: number | null;
    }
  | {
      type: "turn-error";
      message: string;
      code?: string;
      retryable?: boolean;
    }
  | {
      type: "warning";
      message: string;
    };

export interface CodexAppItem {
  id: string;
  type:
    | "agent-message"
    | "reasoning"
    | "command"
    | "mcp-tool"
    | "file-change"
    | "plan"
    | "unknown";
  status: "started" | "completed" | "failed" | "interrupted" | "unknown";
  title?: string;
  text?: string;
  command?: string[];
  output?: string;
  affectedPaths?: string[];
  diff?: string;
  raw?: unknown;
}

export interface CodexAppEventEnvelope {
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
  codexTurnId?: string;
  itemId?: string;
  event: CodexAppEvent;
}

export interface CodexTurnInputParts {
  contextPacket: string;
  historyRevision: string;
  userMessage: string;
  bootstrapHistory?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

/** Minimum JSON-RPC validation. Method params remain version-tolerant unknown. */
export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, "jsonrpc") && value.jsonrpc !== "2.0") return false;
  const hasId = Object.hasOwn(value, "id");
  if (hasId && !isJsonRpcId(value.id)) return false;

  const hasMethod = typeof value.method === "string" && value.method.length > 0;
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");

  if (hasMethod) return !hasResult && !hasError;
  if (!hasId || (!hasResult && !hasError) || (hasResult && hasError)) {
    return false;
  }
  if (hasError) {
    const error = value.error;
    return (
      isRecord(error) &&
      typeof error.code === "number" &&
      Number.isSafeInteger(error.code) &&
      typeof error.message === "string"
    );
  }
  return true;
}

export function parseJsonRpcLine(line: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (cause) {
    throw new Error("Codex app-server emitted invalid JSON", { cause });
  }
  if (!isJsonRpcMessage(parsed)) {
    throw new Error("Codex app-server emitted an invalid JSON-RPC message");
  }
  return parsed;
}

export function serializeJsonRpcMessage(
  message: JsonRpcMessage | Record<string, unknown>,
): string {
  return `${JSON.stringify(message)}\n`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Convert the latest Grimodex context into one authoritative Codex user input. */
export function buildCodexTurnInput(parts: CodexTurnInputParts): string {
  const bootstrap = parts.bootstrapHistory?.trim();
  const historicalBlock = bootstrap
    ? [
        "<grimodex-imported-history>",
        "This is historical conversation context.",
        "Do not answer the historical user messages again.",
        bootstrap,
        "</grimodex-imported-history>",
        "",
      ].join("\n")
    : "";
  return [
    historicalBlock,
    `<grimodex-context revision="${escapeAttribute(parts.historyRevision)}">`,
    parts.contextPacket,
    "</grimodex-context>",
    "The newest grimodex-context block is authoritative.",
    "When older context conflicts with it, ignore the older context.",
    "Do not repeat or summarize the context block unless asked.",
    "",
    "<user-request>",
    parts.userMessage,
    "</user-request>",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}
