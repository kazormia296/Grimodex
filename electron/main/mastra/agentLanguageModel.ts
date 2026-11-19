/**
 * `send_agent_message`（Rust）を AI SDK の `LanguageModelV4` で包む adapter（Mastra 移行 MP-2）。
 *
 * まだ main のどこからも呼ばない（試験だけが参照する）。境界は注入だけ：
 * - `send`：Rust への送信。N-API の直接呼出し、callerIdentity の付与、capability の発行は呼び手の側（MP-3 以降、U-4）。
 * - `audit`：doGenerate 1 回ごとの begin／dispatched／complete／fail。writer は呼び手の側。
 *
 * Mastra を通ると変わる request を、adapter が持てる情報だけで元に戻す（spike S6 の「戻し」）：
 * 1. tool 定義：turn 開始時の snapshot の元の定義へ、名前で差し替える（S6 #1、#2）。snapshot に無い名前は投げる。
 * 2. cache の区切り・route：`providerOptions.grimodex` で運ぶ（S6 #5、#6）。
 * 3. tool_use の `input` の key 順：Rust が返した順を `toolCallId` で保持して戻す（S6 #9）。
 * 4. tool_result：renderer と同じ整形（`isError` を常に付ける。失敗は `Error: ` を前置。S6 #10〜#12）。
 *    成功の整形（`JSON.stringify(content)`、null は summary、token 上限の切詰め）は呼び手の tool の `execute` が
 *    文字列で返す責務。
 * 5. 複数 text は "\n" で連結、署名の無い thinking は戻さない（S6 #13、#14）。
 * 6. `providerOptions.mastra.createdAt` などは読まない（Rust へ漏らさない。S6 #16）。
 * 7. `stripToolProtocol` 相当（履歴の assistant の擬似ツール記法の除去）は adapter の外（呼び手）の責務。
 *    Mastra は本文に触れない（S6 #8）ので、Mastra へ渡す前に呼び手が除く。
 *
 * Mastra に見せる provider と modelId は中立（`grimodex-agent`）。Mastra は provider 名・model id で挙動を変える
 * （`isNativeOpenAIProvider`：schema を nullable 化、`isMaybeAnthropic`：tool id の書換え・reasoning の除去）。
 * 実際の provider・model は route（`providerOptions.grimodex.route`）で運ぶ。
 */
import type { LanguageModel } from "ai";
import type { MastraModelConfig } from "@mastra/core/llm";

import {
  AgentModelError,
  assertSupportedAgentProvider,
  wireStopReasonToFinishReason,
  wireToAgentUsage,
  type AgentSupportedProvider,
} from "./agentModelPolicy.js";
import type {
  AgentAuditHandle,
  AgentAuditRequest,
  AgentAuditSink,
  AgentGrimodexOptions,
  AgentRoute,
  AgentSend,
  AgentWireArgs,
  AgentWireBlock,
  AgentWireCapabilityGrant,
  AgentWireCitation,
  AgentWireMessage,
  AgentWireResponse,
  AgentWireToolDefinition,
  AgentWireToolUse,
  JsonObject,
  JsonValue,
} from "./agentWire.js";

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>;
type CallOptions = Parameters<LanguageModelV4["doGenerate"]>[0];
type Prompt = CallOptions["prompt"];
type Content = Awaited<
  ReturnType<LanguageModelV4["doGenerate"]>
>["content"][number];
type StreamPart =
  Awaited<
    ReturnType<LanguageModelV4["doStream"]>
  >["stream"] extends ReadableStream<infer P>
    ? P
    : never;

/** Mastra に見せる provider 名と model id（中立）。 */
export const AGENT_NEUTRAL_PROVIDER = "grimodex-agent";
export const AGENT_NEUTRAL_MODEL_ID = "grimodex-agent";

/** `providerOptions`／`providerMetadata` の名前空間。 */
export const AGENT_PROVIDER_NAMESPACE = "grimodex";

// ---- providerOptions の運搬 -----------------------------------------------

/** 呼び手が `agent.generate(..., { providerOptions })` に渡す値を作る。 */
export function grimodexProviderOptions(options: AgentGrimodexOptions): {
  grimodex: JsonObject;
} {
  const route: JsonObject = {
    thinking: options.route.thinking,
    effort: options.route.effort,
    reasoningEnabled: options.route.reasoningEnabled,
    reasoningEffort: options.route.reasoningEffort,
    apiVariant: options.route.apiVariant,
    webSearch: options.route.webSearch,
    model: options.route.model,
    provider: options.route.provider,
    endpointId: options.route.endpointId,
    expectedOllamaEndpoint: options.route.expectedOllamaEndpoint,
    ...(options.route.requestMaxOutputTokens !== undefined
      ? { requestMaxOutputTokens: options.route.requestMaxOutputTokens }
      : {}),
    ...(options.route.resolvedToolProtocol !== undefined
      ? { resolvedToolProtocol: options.route.resolvedToolProtocol }
      : {}),
  };
  return {
    grimodex: {
      route,
      systemCacheSegments: options.systemCacheSegments,
      systemVolatileTail: options.systemVolatileTail,
    },
  };
}

function invalidOptions(message: string): AgentModelError {
  return new AgentModelError(
    "invalid-options",
    `providerOptions.grimodex: ${message}`,
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value);
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** key があること（null は許す）を要求して読む。 */
function need<T>(
  source: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T,
  where: string,
): T {
  if (!Object.prototype.hasOwnProperty.call(source, key)) {
    throw invalidOptions(`${where}.${key} is missing`);
  }
  const value = source[key];
  if (!guard(value))
    throw invalidOptions(`${where}.${key} has an unexpected type`);
  return value;
}

const nullable =
  <T>(guard: (value: unknown) => value is T) =>
  (value: unknown): value is T | null =>
    value === null || guard(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const isToolProtocol = (value: unknown): value is "native" | "hermes" =>
  value === "native" || value === "hermes";

/**
 * route を読む。`AgentRoute` の全 field をここで列挙するので、`AgentWireArgs` に field が増えると
 * この return が compile で落ちる（他 lane が field を足したときに黙って落とさない）。
 */
function parseRoute(source: Record<string, unknown>): AgentRoute {
  const where = "route";
  return {
    thinking: need(source, "thinking", nullable(isJsonObject), where),
    effort: need(source, "effort", nullable(isString), where),
    reasoningEnabled: need(
      source,
      "reasoningEnabled",
      nullable(isBoolean),
      where,
    ),
    reasoningEffort: need(source, "reasoningEffort", nullable(isString), where),
    apiVariant: need(source, "apiVariant", nullable(isString), where),
    webSearch: need(source, "webSearch", nullable(isJsonObject), where),
    model: need(source, "model", nullable(isString), where),
    provider: need(source, "provider", nullable(isString), where),
    endpointId: need(source, "endpointId", nullable(isString), where),
    expectedOllamaEndpoint: need(
      source,
      "expectedOllamaEndpoint",
      nullable(isString),
      where,
    ),
    ...(source.requestMaxOutputTokens !== undefined
      ? {
          requestMaxOutputTokens: need(
            source,
            "requestMaxOutputTokens",
            isPositiveInteger,
            where,
          ),
        }
      : {}),
    ...(source.resolvedToolProtocol !== undefined
      ? {
          resolvedToolProtocol: need(
            source,
            "resolvedToolProtocol",
            isToolProtocol,
            where,
          ),
        }
      : {}),
  };
}

export function parseGrimodexOptions(
  providerOptions: unknown,
): AgentGrimodexOptions {
  const namespace = isRecord(providerOptions)
    ? providerOptions[AGENT_PROVIDER_NAMESPACE]
    : undefined;
  if (!isRecord(namespace))
    throw invalidOptions("providerOptions.grimodex is missing");
  const route = need(namespace, "route", isRecord, "grimodex");
  return {
    route: parseRoute(route),
    systemCacheSegments: need(
      namespace,
      "systemCacheSegments",
      nullable(isStringArray),
      "grimodex",
    ),
    systemVolatileTail: need(
      namespace,
      "systemVolatileTail",
      nullable(isString),
      "grimodex",
    ),
  };
}

// ---- prompt → wire messages ---------------------------------------------

function invalidPrompt(message: string): AgentModelError {
  return new AgentModelError("invalid-prompt", message);
}

/** key 順を無視した同値判定（tool_use の input を戻してよいかの確認用）。 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (isRecord(inner)) {
      return Object.fromEntries(
        Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return inner;
  });
}

function toolOutputToContent(
  output: Prompt[number] extends infer M
    ? M extends { role: "tool"; content: (infer P)[] }
      ? P extends { type: "tool-result"; output: infer O }
        ? O
        : never
      : never
    : never,
): { content: string; isError: boolean } {
  switch (output.type) {
    case "text":
      return { content: output.value, isError: false };
    case "json":
      return { content: JSON.stringify(output.value), isError: false };
    // tool の throw は Mastra が error-text で運ぶ。renderer は `Error: ${message}` を content にする。
    case "error-text":
      return { content: `Error: ${output.value}`, isError: true };
    case "error-json":
      return {
        content: `Error: ${JSON.stringify(output.value)}`,
        isError: true,
      };
    case "execution-denied":
      return { content: `Error: ${output.reason ?? "denied"}`, isError: true };
    default:
      throw invalidPrompt(
        `unsupported tool result output type: ${output.type}`,
      );
  }
}

function readSignature(providerOptions: unknown): string {
  const namespace = isRecord(providerOptions)
    ? providerOptions[AGENT_PROVIDER_NAMESPACE]
    : undefined;
  const signature = isRecord(namespace) ? namespace.signature : undefined;
  return typeof signature === "string" ? signature : "";
}

/**
 * AI SDK の prompt → renderer が Rust へ渡す正規化メッセージ。
 * `originalInputs`：Rust が返した tool_use の元の input（toolCallId で引く）。
 */
export function promptToWireMessages(
  prompt: Prompt,
  originalInputs: ReadonlyMap<string, Record<string, unknown>>,
): AgentWireMessage[] {
  const out: AgentWireMessage[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
    } else if (message.role === "user") {
      const texts: string[] = [];
      for (const part of message.content) {
        if (part.type !== "text") {
          // 添付（画像・file）は legacy へ落とす（MP-3）。黙って落とさない。
          throw invalidPrompt(`unsupported user part: ${part.type}`);
        }
        texts.push(part.text);
      }
      out.push({ role: "user", content: texts.join("") });
    } else if (message.role === "assistant") {
      const texts: string[] = [];
      const toolUses: AgentWireToolUse[] = [];
      const thinkingBlocks: { thinking: string; signature: string }[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          texts.push(part.text);
        } else if (part.type === "tool-call") {
          const parsed: unknown =
            typeof part.input === "string"
              ? parseToolInput(part.input, part.toolCallId)
              : part.input;
          if (!isRecord(parsed))
            throw invalidPrompt(
              `tool-call ${part.toolCallId}: input is not an object`,
            );
          const original = originalInputs.get(part.toolCallId);
          // 意味が同じときだけ元の key 順へ戻す（Mastra が内容を変えたなら、変えた後を送る）。
          const input =
            original !== undefined && canonical(original) === canonical(parsed)
              ? original
              : parsed;
          toolUses.push({ id: part.toolCallId, name: part.toolName, input });
        } else if (part.type === "reasoning") {
          // 署名の無い thinking（Chat Completions の reasoning）は会話に戻さない（renderer の extractThinkingBlocks）。
          const signature = readSignature(part.providerOptions);
          if (signature.length > 0)
            thinkingBlocks.push({ thinking: part.text, signature });
        } else {
          throw invalidPrompt(`unsupported assistant part: ${part.type}`);
        }
      }
      out.push({
        role: "assistant",
        content: texts.join("\n"),
        ...(toolUses.length > 0 ? { toolUses } : {}),
        ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
      });
    } else {
      for (const part of message.content) {
        if (part.type !== "tool-result")
          throw invalidPrompt(`unsupported tool part: ${part.type}`);
        const { content, isError } = toolOutputToContent(part.output);
        // renderer は isError を常に付ける（false も）。
        out.push({
          role: "tool_result",
          toolUseId: part.toolCallId,
          content,
          isError,
        });
      }
    }
  }
  return out;
}

function parseToolInput(text: string, toolCallId: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AgentModelError(
      "invalid-prompt",
      `tool-call ${toolCallId}: input is not valid JSON`,
      error,
    );
  }
}

/** Mastra が渡した tool を、snapshot の元の定義へ名前で差し替える。snapshot に無い名前は投げる。 */
export function restoreTools(
  tools: CallOptions["tools"],
  snapshot: ReadonlyMap<string, AgentWireToolDefinition>,
): AgentWireToolDefinition[] {
  const out: AgentWireToolDefinition[] = [];
  for (const tool of tools ?? []) {
    if (tool.type !== "function") {
      throw new AgentModelError(
        "unsupported-request",
        `unsupported tool type: ${tool.type}`,
      );
    }
    const original = snapshot.get(tool.name);
    if (original === undefined) {
      throw new AgentModelError(
        "unsupported-request",
        `tool ${JSON.stringify(tool.name)} is not in the turn-start snapshot`,
      );
    }
    out.push(original);
  }
  return out;
}

/**
 * audit の begin に渡す request ＝ 現行の `chatApi.sendAgentMessage` が audit の前に組む args。
 * key 順・条件付き key も同じ（bytes 一致の試験のため）。
 */
function buildAuditRequest(fields: {
  messages: AgentWireMessage[];
  tools: AgentWireToolDefinition[];
  options: AgentGrimodexOptions;
}): AgentAuditRequest {
  const { route } = fields.options;
  return {
    messages: fields.messages,
    tools: fields.tools,
    thinking: route.thinking,
    effort: route.effort,
    reasoningEnabled: route.reasoningEnabled,
    reasoningEffort: route.reasoningEffort,
    systemCacheSegments: fields.options.systemCacheSegments,
    apiVariant: route.apiVariant,
    webSearch: route.webSearch,
    systemVolatileTail: fields.options.systemVolatileTail,
    model: route.model,
    provider: route.provider,
    endpointId: route.endpointId,
    expectedOllamaEndpoint: route.expectedOllamaEndpoint,
    ...(route.requestMaxOutputTokens !== undefined
      ? { requestMaxOutputTokens: route.requestMaxOutputTokens }
      : {}),
    ...(route.resolvedToolProtocol !== undefined
      ? { resolvedToolProtocol: route.resolvedToolProtocol }
      : {}),
  };
}

/** begin の後に `chatMessageId`（値があるときだけ）と `auditContext` を足す。 */
function buildWireArgs(
  request: AgentAuditRequest,
  handle: AgentAuditHandle,
): AgentWireArgs {
  return {
    ...request,
    ...(handle.chatMessageId ? { chatMessageId: handle.chatMessageId } : {}),
    auditContext: handle.auditContext,
  };
}

/** Mastra が足した設定のうち、Rust へ運べないものがあれば投げる（黙って落とさない）。 */
function assertSupportedCallOptions(options: CallOptions): void {
  const unsupported: string[] = [];
  for (const key of [
    "maxOutputTokens",
    "temperature",
    "topP",
    "topK",
    "presencePenalty",
    "frequencyPenalty",
    "seed",
  ] as const) {
    if (options[key] !== undefined) unsupported.push(key);
  }
  if (options.stopSequences !== undefined && options.stopSequences.length > 0) {
    unsupported.push("stopSequences");
  }
  if (
    options.responseFormat !== undefined &&
    options.responseFormat.type !== "text"
  ) {
    unsupported.push("responseFormat");
  }
  const choice = options.toolChoice;
  if (choice !== undefined && choice.type !== "auto")
    unsupported.push(`toolChoice:${choice.type}`);
  if (unsupported.length > 0) {
    throw new AgentModelError(
      "unsupported-request",
      `options that cannot be carried to send_agent_message: ${unsupported.join(", ")}`,
    );
  }
}

// ---- 応答の検証 ----------------------------------------------------------

function invalidResponse(message: string): AgentModelError {
  return new AgentModelError(
    "invalid-response",
    `send_agent_message response: ${message}`,
  );
}

const optionalNumber = (
  value: unknown,
  key: string,
): number | null | undefined => {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw invalidResponse(`${key} is not a number`);
  return value;
};

function parseBlock(value: unknown): AgentWireBlock {
  if (!isRecord(value)) throw invalidResponse("a block is not an object");
  switch (value.type) {
    case "text":
      if (typeof value.content !== "string")
        throw invalidResponse("text block without content");
      return { type: "text", content: value.content };
    case "tool_use":
      if (
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        !isRecord(value.input)
      ) {
        throw invalidResponse("malformed tool_use block");
      }
      return {
        type: "tool_use",
        id: value.id,
        name: value.name,
        input: value.input,
      };
    case "thinking":
      if (typeof value.content !== "string")
        throw invalidResponse("thinking block without content");
      return {
        type: "thinking",
        content: value.content,
        ...(typeof value.summary === "string"
          ? { summary: value.summary }
          : {}),
        ...(typeof value.signature === "string"
          ? { signature: value.signature }
          : {}),
      };
    default:
      throw invalidResponse(`unknown block type ${JSON.stringify(value.type)}`);
  }
}

function parseCitation(value: unknown): AgentWireCitation {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.title !== "string" ||
    typeof value.citedText !== "string"
  ) {
    throw invalidResponse("malformed citation");
  }
  return {
    url: value.url,
    title: value.title,
    citedText: value.citedText,
    ...(typeof value.snippet === "string" ? { snippet: value.snippet } : {}),
    ...(typeof value.publishedDate === "string"
      ? { publishedDate: value.publishedDate }
      : {}),
  };
}

function parseGrant(value: unknown): AgentWireCapabilityGrant {
  if (
    !isRecord(value) ||
    typeof value.capability !== "string" ||
    typeof value.executionId !== "string" ||
    typeof value.chatMessageId !== "string" ||
    typeof value.mainOwnedProvenanceId !== "string"
  ) {
    throw invalidResponse("malformed agentAuthorityCapabilities entry");
  }
  return {
    capability: value.capability,
    executionId: value.executionId,
    chatMessageId: value.chatMessageId,
    mainOwnedProvenanceId: value.mainOwnedProvenanceId,
    ...(typeof value.expectedEntityId === "string"
      ? { expectedEntityId: value.expectedEntityId }
      : {}),
  };
}

/** 注入された send の戻り値を検証して、既知の field だけを持つ値にする。 */
export function parseWireResponse(value: unknown): AgentWireResponse {
  if (!isRecord(value)) throw invalidResponse("not an object");
  if (!Array.isArray(value.blocks))
    throw invalidResponse("blocks is not an array");
  if (typeof value.stopReason !== "string")
    throw invalidResponse("stopReason is not a string");
  const capabilities = value.agentAuthorityCapabilities;
  if (capabilities !== undefined && !isRecord(capabilities)) {
    throw invalidResponse("agentAuthorityCapabilities is not an object");
  }
  const citations = value.citations;
  if (
    citations !== undefined &&
    citations !== null &&
    !Array.isArray(citations)
  ) {
    throw invalidResponse("citations is not an array");
  }
  const inputTokens = optionalNumber(value.inputTokens, "inputTokens");
  const outputTokens = optionalNumber(value.outputTokens, "outputTokens");
  const cacheReadTokens = optionalNumber(
    value.cacheReadTokens,
    "cacheReadTokens",
  );
  const cacheWriteTokens = optionalNumber(
    value.cacheWriteTokens,
    "cacheWriteTokens",
  );
  const cost = optionalNumber(value.cost, "cost");
  return {
    blocks: value.blocks.map(parseBlock),
    stopReason: value.stopReason,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(citations !== undefined
      ? { citations: citations === null ? null : citations.map(parseCitation) }
      : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(capabilities !== undefined
      ? {
          agentAuthorityCapabilities: Object.fromEntries(
            Object.entries(capabilities).map(([id, grant]) => [
              id,
              parseGrant(grant),
            ]),
          ),
        }
      : {}),
  };
}

// ---- wire 応答 → V4 -------------------------------------------------------

/** 台帳・audit 用の生の値。逆算なしで providerMetadata に運ぶ。 */
function wireMetadata(response: AgentWireResponse): JsonObject {
  return {
    inputTokens: response.inputTokens ?? null,
    outputTokens: response.outputTokens ?? null,
    cacheReadTokens: response.cacheReadTokens ?? null,
    cacheWriteTokens: response.cacheWriteTokens ?? null,
    cost: response.cost ?? null,
    stopReason: response.stopReason,
  };
}

function usageRaw(response: AgentWireResponse): JsonObject {
  return wireMetadata(response);
}

function responseToContent(response: AgentWireResponse): Content[] {
  const citations = response.citations ?? [];
  const content: Content[] = [];
  for (const block of response.blocks) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.content });
    } else if (block.type === "thinking") {
      content.push({
        type: "reasoning",
        text: block.content,
        providerMetadata: {
          [AGENT_PROVIDER_NAMESPACE]: {
            ...(block.signature ? { signature: block.signature } : {}),
            ...(block.summary ? { summary: block.summary } : {}),
          },
        },
      });
    } else {
      content.push({
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        input: JSON.stringify(block.input),
      });
    }
  }
  // Rust の citations は応答全体に 1 本（text block に紐づかない）。source として最後に並べる。
  citations.forEach((citation, index) => {
    content.push({
      type: "source",
      sourceType: "url",
      id: `cit-${index}`,
      url: citation.url,
      title: citation.title,
      providerMetadata: {
        [AGENT_PROVIDER_NAMESPACE]: {
          citedText: citation.citedText,
          ...(citation.snippet ? { snippet: citation.snippet } : {}),
          ...(citation.publishedDate
            ? { publishedDate: citation.publishedDate }
            : {}),
        },
      },
    });
  });
  return content;
}

function contentToStream(
  content: readonly Content[],
  response: AgentWireResponse,
  provider: AgentSupportedProvider,
): ReadableStream<StreamPart> {
  const parts: StreamPart[] = [{ type: "stream-start", warnings: [] }];
  let index = 0;
  for (const part of content) {
    const id = String(index++);
    if (part.type === "text") {
      parts.push(
        { type: "text-start", id },
        { type: "text-delta", id, delta: part.text },
        { type: "text-end", id },
      );
    } else if (part.type === "reasoning") {
      parts.push(
        {
          type: "reasoning-start",
          id,
          providerMetadata: part.providerMetadata,
        },
        {
          type: "reasoning-delta",
          id,
          delta: part.text,
          providerMetadata: part.providerMetadata,
        },
        { type: "reasoning-end", id, providerMetadata: part.providerMetadata },
      );
    } else if (part.type === "source") {
      parts.push(part);
    } else if (part.type === "tool-call") {
      parts.push(
        {
          type: "tool-input-start",
          id: part.toolCallId,
          toolName: part.toolName,
        },
        { type: "tool-input-delta", id: part.toolCallId, delta: part.input },
        { type: "tool-input-end", id: part.toolCallId },
        part,
      );
    }
  }
  parts.push({
    type: "finish",
    usage: { ...wireToAgentUsage(provider, response), raw: usageRaw(response) },
    finishReason: wireStopReasonToFinishReason(response.stopReason),
    providerMetadata: {
      [AGENT_PROVIDER_NAMESPACE]: { wire: wireMetadata(response) },
    },
  });
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

// ---- model ---------------------------------------------------------------

/** 応答の capability を tool の `execute` の文脈へ届ける継ぎ目（turn 内の map。toolCallId で引く）。 */
export interface AgentCapabilityStore {
  get(toolCallId: string): AgentWireCapabilityGrant | undefined;
  clear(): void;
}

export interface AgentLanguageModelStats {
  doGenerateCalls: number;
  doStreamCalls: number;
}

export interface CreateAgentLanguageModelOptions<H extends AgentAuditHandle> {
  readonly send: AgentSend;
  readonly audit: AgentAuditSink<H>;
  /** main が持つ turn 開始時の tool 定義（`snapshotAgentTools` の結果）。名前で引いて元の定義へ戻す。 */
  readonly originalTools: readonly AgentWireToolDefinition[];
}

/**
 * 1 turn に 1 つ作る（tool_use の input と capability を turn の間だけ保持する）。
 * Mastra の `Agent` の `model` にそのまま渡せる。
 */
export function createAgentLanguageModel<H extends AgentAuditHandle>(
  options: CreateAgentLanguageModelOptions<H>,
) {
  const snapshot = new Map(
    options.originalTools.map((tool) => [tool.name, tool]),
  );
  const originalInputs = new Map<string, Record<string, unknown>>();
  const capabilityMap = new Map<string, AgentWireCapabilityGrant>();
  const stats: AgentLanguageModelStats = {
    doGenerateCalls: 0,
    doStreamCalls: 0,
  };
  const capabilities: AgentCapabilityStore = {
    get: (toolCallId) => capabilityMap.get(toolCallId),
    clear: () => capabilityMap.clear(),
  };

  /** 1 回の送信。audit の begin → dispatched → send → complete（失敗は fail）を、doGenerate／doStream で共通に回す。 */
  async function call(callOptions: CallOptions): Promise<{
    response: AgentWireResponse;
    provider: AgentSupportedProvider;
  }> {
    const grimodex = parseGrimodexOptions(callOptions.providerOptions);
    const provider = assertSupportedAgentProvider(grimodex.route.provider);
    assertSupportedCallOptions(callOptions);
    const messages = promptToWireMessages(callOptions.prompt, originalInputs);
    const tools = restoreTools(callOptions.tools, snapshot);

    const auditRequest = buildAuditRequest({
      messages,
      tools,
      options: grimodex,
    });

    let handle: H;
    try {
      handle = await options.audit.begin(auditRequest);
    } catch (error) {
      throw new AgentModelError("audit-failed", "audit begin failed", error);
    }
    const args = buildWireArgs(auditRequest, handle);

    let raw: AgentWireResponse;
    try {
      await options.audit.dispatched(handle);
      raw = parseWireResponse(
        await options.send(args, { signal: callOptions.abortSignal }),
      );
    } catch (error) {
      try {
        await options.audit.fail(handle, error);
      } catch (auditError) {
        throw new AgentModelError(
          "audit-failed",
          "audit fail failed",
          auditError,
        );
      }
      throw error instanceof AgentModelError
        ? error
        : new AgentModelError(
            "send-failed",
            error instanceof Error ? error.message : String(error),
            error,
          );
    }

    // audit の complete は、この時点で生の値から行う（V4 の usage からの逆算はしない）。
    const { agentAuthorityCapabilities, ...forAudit } = raw;
    try {
      await options.audit.complete(handle, {
        response: forAudit,
        usage: {
          inputTokens: raw.inputTokens ?? null,
          outputTokens: raw.outputTokens ?? null,
          cacheReadTokens: raw.cacheReadTokens ?? null,
          cacheWriteTokens: raw.cacheWriteTokens ?? null,
          cost: raw.cost ?? null,
          stopReason: raw.stopReason,
        },
      });
    } catch (error) {
      throw new AgentModelError("audit-failed", "audit complete failed", error);
    }

    for (const block of raw.blocks) {
      if (block.type === "tool_use")
        originalInputs.set(block.id, structuredClone(block.input));
    }
    for (const [toolCallId, grant] of Object.entries(
      agentAuthorityCapabilities ?? {},
    )) {
      capabilityMap.set(toolCallId, grant);
    }
    return { response: raw, provider };
  }

  const model = {
    specificationVersion: "v4" as const,
    provider: AGENT_NEUTRAL_PROVIDER,
    modelId: AGENT_NEUTRAL_MODEL_ID,
    supportedUrls: {},
    async doGenerate(callOptions: CallOptions) {
      stats.doGenerateCalls += 1;
      const { response, provider } = await call(callOptions);
      return {
        content: responseToContent(response),
        finishReason: wireStopReasonToFinishReason(response.stopReason),
        usage: {
          ...wireToAgentUsage(provider, response),
          raw: usageRaw(response),
        },
        providerMetadata: {
          [AGENT_PROVIDER_NAMESPACE]: { wire: wireMetadata(response) },
        },
        warnings: [],
        request: { body: undefined },
      };
    },
    async doStream(callOptions: CallOptions) {
      stats.doStreamCalls += 1;
      const { response, provider } = await call(callOptions);
      return {
        stream: contentToStream(
          responseToContent(response),
          response,
          provider,
        ),
      };
    },
  } satisfies LanguageModelV4 satisfies MastraModelConfig;

  return { model, capabilities, stats };
}
