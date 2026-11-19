/**
 * `send_agent_message` の wire（Mastra 移行 MP-2）。
 *
 * N-API の `AgentRequest`（`electron/native/grimodex-node/src/lib.rs`）と `ChatResponse` の TS 側の写し。
 * IPC 契約（`electron/shared/ipcContract.ts` の `send_agent_message`）は args を `Record<string, unknown>` で
 * 受けるので、型で網羅を強いる正本はここに置く。
 *
 * - `AgentWireArgs` に field を足すと、`AgentRoute`（route が運ぶ field）が自動で増え、
 *   `agentLanguageModel.ts` の `parseRoute`／`buildWireArgs` が compile で落ちる。
 * - Rust の `AgentRequest` との一致は `AGENT_WIRE_ARG_KEYS` と試験（`agentLanguageModel.test.ts`）が
 *   Rust の source を読んで確かめる。
 *
 * `@mastra/*`・`ai` の実体は import しない（型だけ）。
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** renderer の `AgentToolDefinition`（`src/features/chat/agent/agentTypes.ts`）と同じ形。試験が相互代入を確かめる。 */
export interface AgentWireToolParameterSchema {
  type: string;
  description?: string;
  minimum?: number;
  items?: AgentWireToolParameterSchema;
  enum?: string[];
  properties?: Record<string, AgentWireToolParameterSchema>;
  required?: string[];
}

export interface AgentWireToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, AgentWireToolParameterSchema>;
    required: string[];
  };
}

export interface AgentWireToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentWireThinkingBlock {
  thinking: string;
  signature: string;
}

/** renderer の `AgentMessagePayload` と同じ形。 */
export type AgentWireMessage =
  | { role: "user"; content: string }
  | { role: "system"; content: string }
  | {
      role: "assistant";
      content: string;
      toolUses?: AgentWireToolUse[];
      thinkingBlocks?: AgentWireThinkingBlock[];
    }
  | {
      role: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

/** `ipcContract.ts` の `requireNativeAiAuditContext` が要求する、ちょうどこの 6 key。 */
export interface AgentNativeAuditContext {
  expectedWorkspacePath: string;
  projectId: string | null;
  operationId: string;
  executionId: string;
  parentExecutionId: string | null;
  pathId: string;
}

/**
 * Rust `AgentRequest` の全 field（camelCase）と、main が `chatMessageId` を読む分。
 * 順序は renderer の `chatApi.sendAgentMessage` が組む args の key 順（bytes 一致の試験のため）。
 */
export interface AgentWireArgs {
  messages: AgentWireMessage[];
  tools: AgentWireToolDefinition[];
  thinking: JsonObject | null;
  effort: string | null;
  reasoningEnabled: boolean | null;
  reasoningEffort: string | null;
  systemCacheSegments: string[] | null;
  apiVariant: string | null;
  webSearch: JsonObject | null;
  systemVolatileTail: string | null;
  model: string | null;
  provider: string | null;
  endpointId: string | null;
  expectedOllamaEndpoint: string | null;
  /** 値があるときだけ args に載る（現行の renderer と同じ）。 */
  requestMaxOutputTokens?: number;
  resolvedToolProtocol?: "native" | "hermes";
  /** Rust は無視する。main の capability 発行（`ipc.ts` の `issueAgentAuthorityCapabilitiesForSender`）が読む。 */
  chatMessageId?: string;
  auditContext: AgentNativeAuditContext;
  /** main が dispatch の内側で付ける。adapter は発行も付与もしない（MP-3 以降、U-4）。 */
  callerIdentity?: JsonObject;
}

/** `AgentWireArgs` の key の一覧。`satisfies` と下の型で、型と一覧のどちらかが欠けると compile で落ちる。 */
export const AGENT_WIRE_ARG_KEYS = [
  "messages",
  "tools",
  "thinking",
  "effort",
  "reasoningEnabled",
  "reasoningEffort",
  "systemCacheSegments",
  "apiVariant",
  "webSearch",
  "systemVolatileTail",
  "model",
  "provider",
  "endpointId",
  "expectedOllamaEndpoint",
  "requestMaxOutputTokens",
  "resolvedToolProtocol",
  "chatMessageId",
  "auditContext",
  "callerIdentity",
] as const satisfies readonly (keyof AgentWireArgs)[];

type MissingWireArgKey = Exclude<
  keyof AgentWireArgs,
  (typeof AGENT_WIRE_ARG_KEYS)[number]
>;
/** `AGENT_WIRE_ARG_KEYS` に無い key が `AgentWireArgs` にあると `never` でなくなり、この代入が落ちる。 */
export const AGENT_WIRE_ARG_KEYS_EXHAUSTIVE: [MissingWireArgKey] extends [never]
  ? true
  : never = true;

/** adapter が組む（renderer の route の値ではない）field。残りが route が運ぶ field。 */
export type AgentAdapterOwnedKey =
  | "messages"
  | "tools"
  | "systemCacheSegments"
  | "systemVolatileTail"
  | "chatMessageId"
  | "auditContext"
  | "callerIdentity";

/**
 * route が運ぶ field（thinking、effort、provider、model、`requestMaxOutputTokens` ほか）。
 * `AgentWireArgs` の残り全部なので、他 lane が field を足すとここも増える。
 */
export type AgentRoute = Omit<AgentWireArgs, AgentAdapterOwnedKey>;

/** `providerOptions.grimodex` が運ぶ値（cache の区切りと route）。 */
export interface AgentGrimodexOptions {
  route: AgentRoute;
  systemCacheSegments: string[] | null;
  systemVolatileTail: string | null;
}

/** audit の begin に渡す request。現行の `chatApi.sendAgentMessage` が audit の前に組む args と同じ。 */
export type AgentAuditRequest = Omit<
  AgentWireArgs,
  "auditContext" | "chatMessageId" | "callerIdentity"
>;

// ---- 応答 ----------------------------------------------------------------

export type AgentWireBlock =
  | { type: "text"; content: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "thinking"; content: string; summary?: string; signature?: string };

export interface AgentWireCitation {
  url: string;
  title: string;
  citedText: string;
  snippet?: string;
  publishedDate?: string;
}

/** `src/features/chat/agent/agentTypes.ts` の `AgentAuthorityCapabilityGrant` と同じ形。 */
export interface AgentWireCapabilityGrant {
  readonly capability: string;
  readonly executionId: string;
  readonly chatMessageId: string;
  readonly mainOwnedProvenanceId: string;
  readonly expectedEntityId?: string;
}

/**
 * Rust `ChatResponse`。`stopReason` は列挙ではない（Anthropic は API の値の素通し、
 * Chat Completions は tool_use／end_turn、Responses は tool_use／end_turn／length）。
 * `agentAuthorityCapabilities` は main が後付けする。
 */
export interface AgentWireResponse {
  blocks: AgentWireBlock[];
  stopReason: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  citations?: AgentWireCitation[] | null;
  cost?: number | null;
  agentAuthorityCapabilities?: Record<string, AgentWireCapabilityGrant>;
}

// ---- 注入する依存 --------------------------------------------------------

/**
 * Rust への送信。実体は MP-3 以降が注入する（main の IPC 経路の内側：callerIdentity の付与、
 * `agentAuthorityCapabilities` の後付けを含む）。adapter は N-API を直接呼ばない。
 */
export type AgentSend = (
  args: AgentWireArgs,
  context: { readonly signal?: AbortSignal },
) => Promise<AgentWireResponse>;

/** audit の 1 回分の控え。`auditContext` は native へ渡す相関、`chatMessageId` は capability 発行が読む。 */
export interface AgentAuditHandle {
  readonly auditContext: AgentNativeAuditContext;
  readonly chatMessageId?: string;
}

/** audit に渡す完了の値。`chatApi.sendAgentMessage` が `completeAiAuditExecution` に渡す値と同じ（逆算なし）。 */
export interface AgentAuditCompletion {
  /** 応答の生の値。capability（bearer）は audit に残さないので除く。 */
  readonly response: Omit<AgentWireResponse, "agentAuthorityCapabilities">;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadTokens: number | null;
    readonly cacheWriteTokens: number | null;
    readonly cost: number | null;
    readonly stopReason: string;
  };
}

/**
 * doGenerate 1 回ごとの audit。実体（`ai-audit` の writer）は MP-3 以降の owner が注入する。
 * adapter が呼ぶ順：begin → dispatched → send → complete（失敗なら fail。complete と fail は排他で 1 回）。
 */
export interface AgentAuditSink<H extends AgentAuditHandle = AgentAuditHandle> {
  begin(request: AgentAuditRequest): Promise<H>;
  dispatched(handle: H): Promise<void>;
  complete(handle: H, completion: AgentAuditCompletion): Promise<void>;
  fail(handle: H, error: unknown): Promise<void>;
}
