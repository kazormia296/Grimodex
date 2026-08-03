/**
 * Browser-mode AI client.
 * Mirrors src-tauri/src/ai.rs logic using fetch() via Vite dev proxy.
 * Only used when running without Tauri (pnpm dev in browser).
 */
import type {
  AiModel,
  AiProvider,
  ToolProtocolMode,
} from "@/features/chat/types";
import { BROWSER_DIRECT_AI_PROVIDERS } from "@/features/chat/browserProviderPolicy";
import {
  AINOVERIST_BASE_URL,
  AINOVERIST_MODEL_CAPS,
  AINOVERIST_V1_BASE_URL,
  AINOVERIST_V1_KNOWN_MODELS,
  isAinoveristV1Model,
} from "@/features/chat/aiNovelist";
import type {
  AgentMessagePayload,
  AgentLLMResponse,
  AgentToolDefinition,
  ResponseBlock,
} from "@/features/chat/agent/agentTypes";
import {
  resolveToolProtocol,
  parseHermesToolCalls,
  formatHermesToolCall,
  formatHermesToolResponse,
  buildHermesToolsPreamble,
  hermesAllowedToolNames,
} from "@/features/chat/toolProtocolParse";

interface ChatMessage {
  role: string;
  content: string;
}

export type BrowserAiOperation = "chat" | "inline";

export type BrowserAiAddressSpace = "local" | "loopback";

export type BrowserAiErrorCode =
  | "local-network-permission"
  | "cors"
  | "server-unavailable"
  | "endpoint-format"
  | "models-unsupported"
  | "http"
  | "network";

export class BrowserAiConnectionError extends Error {
  readonly code: BrowserAiErrorCode;
  readonly status?: number;
  readonly resource: BrowserAiEndpointResource;
  readonly url: string;

  constructor(
    code: BrowserAiErrorCode,
    message: string,
    options: {
      resource?: BrowserAiEndpointResource;
      url?: string;
      status?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "BrowserAiConnectionError";
    this.code = code;
    this.resource = options.resource ?? "chat";
    this.url = options.url ?? "";
    this.status = options.status;
  }
}

export interface BrowserAiConnectionOptions {
  ollamaEndpoint?: string | null;
  /** Ollama model-list probe only; omitted means enrich the full catalog. */
  selectedModelId?: string | null;
  /** OpenAI-compatible only. This is the user-selected endpoint base URL. */
  baseUrl?: string | null;
  apiVariant?: string | null;
}

/** Correlates one final browser provider request with its durable audit run. */
export interface BrowserAiAuditContext {
  readonly expectedWorkspacePath: string;
  readonly projectId: string | null;
  readonly operationId: string;
  readonly executionId: string;
  readonly parentExecutionId: string | null;
  readonly pathId: string;
}

export type BrowserAiEffectiveRequestKind =
  | "connection"
  | "single"
  | "stream"
  | "agent";

/**
 * Credential-free transport-observer receipt carrying the one JSON string
 * passed to fetch. BrowserMock persists the complete parsed JSON value, not
 * this string's whitespace, key order, or byte representation. Headers, API
 * keys, cookies, and environment values never enter this shape.
 */
export interface BrowserAiEffectiveRequestReceipt {
  readonly kind: BrowserAiEffectiveRequestKind;
  readonly provider: AiProvider;
  readonly model: string;
  readonly apiVariant: string | null;
  readonly endpointId: string | null;
  readonly endpointOrigin: string | null;
  readonly auditContext?: BrowserAiAuditContext;
  readonly bodyJson: string;
}

export type BrowserAiEffectiveRequestObserver = (
  receipt: BrowserAiEffectiveRequestReceipt,
) => Promise<void>;

export interface BrowserAiDispatchHooks {
  readonly auditContext?: BrowserAiAuditContext;
  readonly onEffectiveRequest?: BrowserAiEffectiveRequestObserver;
}

export interface BrowserAiTransportOptions {
  readonly onEffectiveRequest?: BrowserAiEffectiveRequestObserver;
}

const OLLAMA_SELECTED_METADATA_TIMEOUT_MS = 95_000;
const OLLAMA_CATALOG_METADATA_TIMEOUT_MS = 45_000;
const OLLAMA_MODEL_LOAD_TIMEOUT_MS = 60_000;

export interface BrowserAiRequest {
  operation: BrowserAiOperation;
  /** Required for streaming; identifies one independently cancellable run. */
  streamId?: string;
  provider: AiProvider;
  model: string;
  endpointId?: string | null;
  apiKey?: string;
  messages: ChatMessage[];
  maxOutputTokens?: number | null;
  ollamaEndpoint?: string | null;
  selectedModelId?: string | null;
  baseUrl?: string | null;
  apiVariant?: string | null;
  toolProtocolMode?: ToolProtocolMode;
  /** Runtime-only correlation. It is never serialized into a provider body. */
  auditContext?: BrowserAiAuditContext;
}

export type BrowserAiCompletion = AgentLLMResponse;

export interface BrowserAiStreamDone {
  stopReason: AgentLLMResponse["stopReason"] | "stopped";
  inputTokens?: number;
  outputTokens?: number;
  /** Internal transport evidence used when abort races provider completion. */
  providerTerminalObservedBeforeAbort?: boolean;
}

export interface BrowserAiStreamSink {
  text(delta: string, blockType?: "text" | "thinking"): void;
  done(payload: BrowserAiStreamDone): void;
}

export interface BrowserAiAbortReceipt {
  readonly abortCommandAcknowledged: true;
  readonly transportTerminationObserved: boolean;
}

export interface BrowserAiTransport {
  complete(request: BrowserAiRequest): Promise<BrowserAiCompletion>;
  /**
   * Optional structured agent surface. Hosted runtimes use this to keep the
   * Editor's normal agent loop on the same scoped transport instead of
   * bypassing it with a direct provider request.
   */
  completeAgent?(
    request: BrowserAiRequest,
    messages: AgentMessagePayload[],
    tools: AgentToolDefinition[],
  ): Promise<BrowserAiCompletion>;
  stream?(request: BrowserAiRequest, sink: BrowserAiStreamSink): Promise<void>;
  listModels?(request: BrowserAiRequest): Promise<AiModel[]>;
  abort?(streamId: string): Promise<BrowserAiAbortReceipt>;
  dispose?(): void;
}

const isViteDevelopment = import.meta.env.DEV;

export type BrowserAiEndpointResource = "chat" | "models";

type BrowserAiFetchInit = RequestInit & {
  /** Local Network Access is not in the current lib.dom typings yet. */
  targetAddressSpace?: BrowserAiAddressSpace;
};

function parseHostname(value: string): string | null {
  try {
    const base =
      typeof window === "undefined"
        ? "http://browser.invalid"
        : window.location.href;
    const parsed = new URL(value, base);
    // Relative Vite proxy paths must remain same-origin and should not request
    // a local-network permission prompt.
    if (!/^[a-z][a-z\d+.-]*:/iu.test(value.trim())) return null;
    return parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  } catch {
    return null;
  }
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/u.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function isLocalIpv6Literal(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  const firstHextet = hostname.split(":", 1)[0];
  if (!firstHextet || !/^[\da-f]{1,4}$/u.test(firstHextet)) return false;
  const first = Number.parseInt(firstHextet, 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * Classifies an absolute AI endpoint for the browser Local Network Access
 * request hint. Public endpoints intentionally return undefined.
 */
export function classifyBrowserAiAddressSpace(
  value: string,
): BrowserAiAddressSpace | undefined {
  const hostname = parseHostname(value);
  if (!hostname) return undefined;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return "loopback";
  }
  if (hostname === "::1") return "loopback";

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [first, second] = ipv4;
    if (first === 127) return "loopback";
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    ) {
      return "local";
    }
    return undefined;
  }

  if (hostname.endsWith(".local") || isLocalIpv6Literal(hostname)) {
    return "local";
  }
  return undefined;
}

export function isBrowserLocalEndpoint(value?: string | null): boolean {
  return classifyBrowserAiAddressSpace(value?.trim() ?? "") !== undefined;
}

function createFetchFailure(
  error: unknown,
  url: string,
  resource: BrowserAiEndpointResource,
  addressSpace: BrowserAiAddressSpace | undefined,
): BrowserAiConnectionError {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = rawMessage.toLowerCase();
  const code: BrowserAiErrorCode =
    lowerMessage.includes("refused") ||
    lowerMessage.includes("connection reset") ||
    lowerMessage.includes("err_connection")
      ? "server-unavailable"
      : lowerMessage.includes("cors") || lowerMessage.includes("cross-origin")
        ? "cors"
        : addressSpace
          ? "local-network-permission"
          : "network";
  const message =
    code === "server-unavailable"
      ? "AIサーバーが起動していないか、接続先が応答していません。サーバーの起動状態とURLを確認してください。"
      : code === "cors"
        ? "ブラウザーがCORSでAIエンドポイントへの接続を拒否しました。サーバーのOrigin許可を確認してください。"
        : addressSpace
          ? "ローカルネットワークへのアクセスが拒否されたか、AIサーバーが起動していません。ブラウザーの許可とサーバーのCORS設定を確認してください。"
          : rawMessage || "AIエンドポイントへ接続できませんでした";
  return new BrowserAiConnectionError(code, message, {
    resource,
    url,
    cause: error,
  });
}

export async function browserAiFetch(
  url: string,
  init: RequestInit = {},
  resource: BrowserAiEndpointResource = "chat",
): Promise<Response> {
  const addressSpace = classifyBrowserAiAddressSpace(url);
  const requestInit: BrowserAiFetchInit = {
    ...init,
    ...(addressSpace ? { targetAddressSpace: addressSpace } : {}),
  };
  try {
    return await fetch(url, requestInit as RequestInit);
  } catch (error) {
    throw createFetchFailure(error, url, resource, addressSpace);
  }
}

function createHttpFailure(
  prefix: string,
  response: Response,
  message: string,
  url: string,
  resource: BrowserAiEndpointResource,
): BrowserAiConnectionError {
  let code: BrowserAiErrorCode = "http";
  if (response.status === 404) {
    code = resource === "models" ? "models-unsupported" : "endpoint-format";
  } else if (response.status === 502 || response.status === 503) {
    code = "server-unavailable";
  }
  return new BrowserAiConnectionError(
    code,
    `${prefix} (${response.status}): ${message}`,
    { resource, url, status: response.status },
  );
}

function requireBrowserDirectProvider(provider: AiProvider): void {
  if (
    !(BROWSER_DIRECT_AI_PROVIDERS as readonly AiProvider[]).includes(provider)
  ) {
    throw new Error(`Provider "${provider}" is not supported in browser mode`);
  }
}

const BROWSER_PROVIDERS_REQUIRING_KEY = new Set<AiProvider>([
  "openrouter",
  "openai",
  "anthropic",
  "sakana",
  "ai-novelist",
]);

export function browserProviderRequiresApiKey(provider: AiProvider): boolean {
  requireBrowserDirectProvider(provider);
  return BROWSER_PROVIDERS_REQUIRING_KEY.has(provider);
}

function normalizeBaseUrl(
  value: string | null | undefined,
  label: string,
): string {
  const normalized = value?.trim().replace(/\/+$/, "") ?? "";
  if (!normalized) {
    throw new Error(`${label} base URL is not configured`);
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} base URL is invalid`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} base URL must use http or https`);
  }
  return normalized;
}

export function resolveBrowserAiEndpoint(
  provider: AiProvider,
  resource: BrowserAiEndpointResource,
  options: BrowserAiConnectionOptions & { development?: boolean } = {},
): string | null {
  requireBrowserDirectProvider(provider);
  const development = options.development ?? isViteDevelopment;
  if (resource === "models" && provider === "anthropic") return null;

  const suffix = resource === "chat" ? "chat/completions" : "models";
  switch (provider) {
    case "anthropic":
      return development
        ? "/api/anthropic/messages"
        : "https://api.anthropic.com/v1/messages";
    case "openai":
      return development
        ? `/api/openai/${suffix}`
        : `https://api.openai.com/v1/${suffix}`;
    case "openrouter":
      return `https://openrouter.ai/api/v1/${suffix}`;
    case "ollama": {
      const normalizedOllamaEndpoint = normalizeOllamaEndpoint(
        options.ollamaEndpoint,
      );
      const useDevelopmentProxy =
        development && normalizedOllamaEndpoint === "http://localhost:11434";
      if (resource === "models") {
        return useDevelopmentProxy
          ? "/api/ollama/api/tags"
          : `${normalizedOllamaEndpoint}/api/tags`;
      }
      return useDevelopmentProxy
        ? "/api/ollama/v1/chat/completions"
        : `${normalizedOllamaEndpoint}/v1/chat/completions`;
    }
    case "openai-compatible": {
      const baseUrl = normalizeBaseUrl(
        options.baseUrl,
        "OpenAI-compatible endpoint",
      );
      return `${baseUrl}/${suffix}`;
    }
    case "sakana":
      return development
        ? `/api/sakana/${suffix}`
        : `https://api.sakana.ai/v1/${suffix}`;
    case "ai-novelist": {
      if (resource === "models") {
        return `${AINOVERIST_V1_BASE_URL}/models`;
      }
      const useV1 = options.apiVariant === "v1";
      return useV1
        ? `${AINOVERIST_V1_BASE_URL}/chat/completions`
        : AINOVERIST_BASE_URL;
    }
  }
  throw new Error(`Provider "${provider}" is not supported in browser mode`);
}

export function normalizeOllamaEndpoint(endpoint?: string | null): string {
  const base = endpoint?.trim() || "http://localhost:11434";
  return base.replace(/\/+$/, "");
}

function ollamaApiEndpoint(
  path: `/${string}`,
  options: BrowserAiConnectionOptions,
): string {
  const endpoint = normalizeOllamaEndpoint(options.ollamaEndpoint);
  const useDevelopmentProxy =
    isViteDevelopment && endpoint === "http://localhost:11434";
  return useDevelopmentProxy ? `/api/ollama${path}` : `${endpoint}${path}`;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function ollamaModelContextLength(modelInfo: unknown): number | undefined {
  if (!modelInfo || typeof modelInfo !== "object") return undefined;
  const info = modelInfo as Record<string, unknown>;
  const architecture =
    typeof info["general.architecture"] === "string"
      ? info["general.architecture"]
      : undefined;
  if (architecture) {
    const declared = positiveInteger(info[`${architecture}.context_length`]);
    if (declared) return declared;
  }
  const suffixMatches = Object.entries(info)
    .filter(([key]) => key.endsWith(".context_length"))
    .sort(
      ([left], [right]) => left.split(".").length - right.split(".").length,
    );
  for (const [, value] of suffixMatches) {
    const declared = positiveInteger(value);
    if (declared) return declared;
  }
  return undefined;
}

function ollamaNumCtx(parameters: unknown): number | undefined {
  if (parameters && typeof parameters === "object") {
    return positiveInteger(
      (parameters as Record<string, unknown>).num_ctx ??
        (parameters as Record<string, unknown>).numCtx,
    );
  }
  if (typeof parameters !== "string") return undefined;
  const match = parameters.match(
    /(?:^|\n)\s*(?:PARAMETER\s+)?num_ctx\s*(?:=|\s)\s*(\d+)/iu,
  );
  return positiveInteger(match?.[1]);
}

function normalizeOllamaModelName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/:latest$/u, "");
}

function ollamaSupportedParameters(
  capabilities: unknown,
): string[] | undefined {
  if (!Array.isArray(capabilities)) return undefined;
  const result: string[] = [];
  if (capabilities.includes("tools")) result.push("tools");
  if (capabilities.includes("thinking")) result.push("reasoning");
  // An explicit capability list is authoritative even when it advertises no
  // tool/reasoning support. `[]` must not fall back to supportsTools=true.
  return result;
}

async function optionalOllamaJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
): Promise<unknown | undefined> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await browserAiFetch(
      url,
      { ...init, signal: controller.signal },
      "models",
    );
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await transform(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return result;
}

function chatEndpoint(
  provider: AiProvider,
  options: BrowserAiConnectionOptions = {},
): string {
  const endpoint = resolveBrowserAiEndpoint(provider, "chat", {
    ...options,
  });
  if (!endpoint) {
    throw new Error(`No browser chat endpoint is available for ${provider}`);
  }
  return endpoint;
}

function modelsEndpoint(
  provider: AiProvider,
  options: BrowserAiConnectionOptions = {},
): string | null {
  return resolveBrowserAiEndpoint(provider, "models", options);
}

function buildHeaders(
  provider: AiProvider,
  apiKey: string,
): Record<string, string> {
  requireBrowserDirectProvider(provider);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  switch (provider) {
    case "anthropic":
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      // Anthropic requires an explicit opt-in header for credentialed browser
      // requests. The API key remains only in this page's runtime memory.
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      break;
    case "openai":
    case "sakana":
    case "ai-novelist":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "openrouter":
      headers["Authorization"] = `Bearer ${apiKey}`;
      headers["HTTP-Referer"] = "https://github.com/kazormia296/Grimodex";
      headers["X-Title"] = "Grimodex";
      break;
    case "openai-compatible":
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "ollama":
      // No auth
      break;
  }

  return headers;
}

async function parseErrorResponse(resp: Response): Promise<string> {
  try {
    const body = await resp.json();
    // Anthropic: { error: { message: "..." } }
    // OpenAI-compatible: { error: { message: "..." } }
    if (body?.error?.message) return body.error.message;
    return JSON.stringify(body);
  } catch {
    return resp.statusText;
  }
}

export async function sendChat(
  provider: AiProvider,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  options: BrowserAiConnectionOptions = {},
): Promise<string> {
  const result = await completeBrowserAiRequest({
    operation: "chat",
    provider,
    model,
    apiKey,
    messages,
    ...options,
  });
  return result.blocks
    .filter(
      (block): block is Extract<ResponseBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.content)
    .join("\n");
}

function buildChatBody(request: BrowserAiRequest): Record<string, unknown> {
  const { provider, model, messages } = request;
  const maxTokens = request.maxOutputTokens ?? 4096;

  if (isAiNovelistLegacy(request)) {
    const legacyMaxTokens =
      request.maxOutputTokens ??
      AINOVERIST_MODEL_CAPS[model]?.maxOutputTokens ??
      4096;
    if (request.operation === "inline") {
      return {
        text: messages
          .map(({ role, content }) => `[${role}]\n${content}`)
          .join("\n\n"),
        model,
        length: legacyMaxTokens,
      };
    }

    const systemMessages: string[] = [];
    const chatMessages: ChatMessage[] = [];
    for (const message of messages) {
      if (message.role === "system") {
        systemMessages.push(message.content);
        continue;
      }
      const content =
        systemMessages.length > 0 && chatMessages.length === 0
          ? `${systemMessages.join("\n\n")}\n\n${message.content}`
          : message.content;
      if (chatMessages.length === 0) systemMessages.length = 0;
      chatMessages.push({ role: message.role, content });
    }
    if (systemMessages.length > 0) {
      chatMessages.push({
        role: "user",
        content: systemMessages.join("\n\n"),
      });
    }
    return {
      messages: chatMessages,
      model,
      max_tokens: legacyMaxTokens,
    };
  }

  if (provider === "anthropic") {
    const systemContent = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const chatMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: chatMessages,
    };
    if (systemContent) {
      body.system = systemContent;
    }
    return body;
  }

  const chatMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  return { model, max_tokens: maxTokens, messages: chatMessages };
}

function credentialFreeEndpointOrigin(url: string): string | null {
  if (!/^[a-z][a-z\d+.-]*:/iu.test(url.trim())) return null;
  try {
    // URL.origin excludes user info, path, query, and fragment by definition.
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function serializeEffectiveRequestBody(
  request: BrowserAiRequest,
  kind: BrowserAiEffectiveRequestKind,
  url: string,
  body: Record<string, unknown>,
  onEffectiveRequest?: BrowserAiEffectiveRequestObserver,
): Promise<string> {
  const bodyJson = JSON.stringify(body);
  await onEffectiveRequest?.({
    kind,
    provider: request.provider,
    model: request.model,
    apiVariant: request.apiVariant ?? null,
    endpointId: request.endpointId ?? null,
    endpointOrigin: credentialFreeEndpointOrigin(url),
    ...(request.auditContext ? { auditContext: request.auditContext } : {}),
    bodyJson,
  });
  return bodyJson;
}

function isAiNovelistLegacy(request: {
  provider: AiProvider;
  model: string;
  apiVariant?: string | null;
}): boolean {
  return (
    request.provider === "ai-novelist" &&
    !isAinoveristV1Model(request.model, request.apiVariant)
  );
}

function parseAiNovelistLegacyResponse(
  result: Record<string, unknown>,
): BrowserAiCompletion {
  const data = result.data;
  let content = "";
  let usage: Record<string, unknown> = {};
  let stopReason: AgentLLMResponse["stopReason"] = "end_turn";
  if (Array.isArray(data)) {
    content = typeof data[0] === "string" ? data[0] : "";
  } else if (typeof data === "string") {
    content = data;
  } else if (data && typeof data === "object") {
    const object = data as Record<string, unknown>;
    const choices = Array.isArray(object.choices)
      ? (object.choices as Array<Record<string, unknown>>)
      : [];
    const first = choices[0] ?? {};
    const choiceText = typeof first.text === "string" ? first.text : "";
    content =
      choiceText ||
      (typeof object["0"] === "string" ? (object["0"] as string) : "");
    stopReason = normalizeStopReason(first.finish_reason);
    usage =
      object.usage && typeof object.usage === "object"
        ? (object.usage as Record<string, unknown>)
        : {};
  }
  if (
    !Object.keys(usage).length &&
    result.usage &&
    typeof result.usage === "object"
  ) {
    usage = result.usage as Record<string, unknown>;
  }
  content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  return {
    blocks: content ? [{ type: "text", content }] : [],
    stopReason,
    inputTokens: typeof input === "number" && input >= 0 ? input : undefined,
    outputTokens:
      typeof output === "number" && output >= 0 ? output : undefined,
  };
}

function requireBrowserAiRequest(request: BrowserAiRequest): void {
  requireBrowserDirectProvider(request.provider);
  if (!request.model.trim()) {
    throw new Error("AIモデルが設定されていません");
  }
  if (
    browserProviderRequiresApiKey(request.provider) &&
    !request.apiKey?.trim()
  ) {
    throw new Error(
      `AIは未接続です。APIキーを設定してください: ${request.provider}`,
    );
  }
}

function normalizeStopReason(value: unknown): AgentLLMResponse["stopReason"] {
  if (value === "tool_use" || value === "tool_calls") return "tool_use";
  if (value === "max_tokens" || value === "length") return "max_tokens";
  return "end_turn";
}

export async function completeBrowserAiRequest(
  request: BrowserAiRequest,
  signal?: AbortSignal,
  onEffectiveRequest?: BrowserAiEffectiveRequestObserver,
  receiptKind: BrowserAiEffectiveRequestKind = "single",
): Promise<BrowserAiCompletion> {
  requireBrowserAiRequest(request);
  const headers = buildHeaders(request.provider, request.apiKey ?? "");
  const url = chatEndpoint(request.provider, request);
  const body = buildChatBody(request);
  const bodyJson = await serializeEffectiveRequestBody(
    request,
    receiptKind,
    url,
    body,
    onEffectiveRequest,
  );

  const resp = await browserAiFetch(
    url,
    {
      method: "POST",
      headers,
      body: bodyJson,
      signal,
    },
    "chat",
  );

  if (!resp.ok) {
    const errMsg = await parseErrorResponse(resp);
    throw createHttpFailure("AI request failed", resp, errMsg, url, "chat");
  }

  const result = (await resp.json()) as Record<string, unknown>;

  if (isAiNovelistLegacy(request)) {
    return parseAiNovelistLegacyResponse(result);
  }

  if (request.provider === "anthropic") {
    const blocks: ResponseBlock[] = [];
    for (const rawBlock of (result.content as unknown[]) ?? []) {
      const block = rawBlock as Record<string, unknown>;
      if (
        (block.type === "text" || block.type === undefined) &&
        typeof block.text === "string"
      ) {
        blocks.push({ type: "text", content: block.text });
      } else if (
        block.type === "thinking" &&
        typeof block.thinking === "string"
      ) {
        blocks.push({ type: "thinking", content: block.thinking });
      }
    }
    const usage = (result.usage as Record<string, unknown> | undefined) ?? {};
    return {
      blocks,
      stopReason: normalizeStopReason(result.stop_reason),
      inputTokens:
        typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens:
        typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : undefined,
    };
  }

  const choices = (result.choices as Array<Record<string, unknown>>) ?? [];
  const choice = choices[0] ?? {};
  const message = (choice.message as Record<string, unknown> | undefined) ?? {};
  const content = typeof message.content === "string" ? message.content : "";
  const usage = (result.usage as Record<string, unknown> | undefined) ?? {};
  return {
    blocks: content ? [{ type: "text", content }] : [],
    stopReason: normalizeStopReason(choice.finish_reason),
    inputTokens:
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    outputTokens:
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined,
  };
}

async function readSse(
  response: Response,
  onData: (data: string) => void,
): Promise<void> {
  if (!response.body) {
    throw new Error("AI streaming response did not include a body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeEvent = (event: string): void => {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) onData(data);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    // Normalize after concatenating so a CRLF pair split across network
    // chunks still produces the SSE blank-line boundary.
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consumeEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consumeEvent(buffer);
}

async function streamBrowserAiRequest(
  request: BrowserAiRequest,
  sink: BrowserAiStreamSink,
  signal: AbortSignal,
  onProviderTerminal?: (payload: BrowserAiStreamDone) => void,
  onEffectiveRequest?: BrowserAiEffectiveRequestObserver,
): Promise<void> {
  requireBrowserAiRequest(request);
  if (isAiNovelistLegacy(request)) {
    const response = await completeBrowserAiRequest(
      request,
      signal,
      onEffectiveRequest,
      "stream",
    );
    for (const block of response.blocks) {
      if (block.type === "text" || block.type === "thinking") {
        sink.text(block.content, block.type);
      }
    }
    sink.done({
      stopReason: response.stopReason,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });
    return;
  }
  const headers = buildHeaders(request.provider, request.apiKey ?? "");
  const body: Record<string, unknown> = {
    ...buildChatBody(request),
    stream: true,
  };
  if (request.provider !== "anthropic" && request.provider !== "ollama") {
    body.stream_options = { include_usage: true };
  }

  const url = chatEndpoint(request.provider, request);
  const bodyJson = await serializeEffectiveRequestBody(
    request,
    "stream",
    url,
    body,
    onEffectiveRequest,
  );
  const response = await browserAiFetch(
    url,
    {
      method: "POST",
      headers,
      body: bodyJson,
      signal,
    },
    "chat",
  );
  if (!response.ok) {
    const message = await parseErrorResponse(response);
    throw createHttpFailure(
      "AI request failed",
      response,
      message,
      url,
      "chat",
    );
  }

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: BrowserAiStreamDone["stopReason"] = "end_turn";
  let finished = false;
  let providerTerminalObserved = false;
  const observeProviderTerminal = (): void => {
    providerTerminalObserved = true;
    onProviderTerminal?.({ stopReason, inputTokens, outputTokens });
  };
  const refreshProviderTerminal = (): void => {
    if (providerTerminalObserved) {
      onProviderTerminal?.({ stopReason, inputTokens, outputTokens });
    }
  };
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (!providerTerminalObserved) observeProviderTerminal();
    sink.done({ stopReason, inputTokens, outputTokens });
  };

  await readSse(response, (data) => {
    if (finished) return;
    if (data === "[DONE]") {
      finish();
      return;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (request.provider === "anthropic") {
      const eventType = event.type;
      if (eventType === "message_start") {
        const message =
          (event.message as Record<string, unknown> | undefined) ?? {};
        const usage =
          (message.usage as Record<string, unknown> | undefined) ?? {};
        if (typeof usage.input_tokens === "number") {
          inputTokens = usage.input_tokens;
        }
      } else if (eventType === "content_block_delta") {
        if (providerTerminalObserved) return;
        const delta =
          (event.delta as Record<string, unknown> | undefined) ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          sink.text(delta.text, "text");
        } else if (
          delta.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        ) {
          sink.text(delta.thinking, "thinking");
        }
      } else if (eventType === "message_delta") {
        const delta =
          (event.delta as Record<string, unknown> | undefined) ?? {};
        const usage =
          (event.usage as Record<string, unknown> | undefined) ?? {};
        if (typeof usage.output_tokens === "number") {
          outputTokens = usage.output_tokens;
        }
        if (delta.stop_reason != null && !providerTerminalObserved) {
          stopReason = normalizeStopReason(delta.stop_reason);
          observeProviderTerminal();
        } else {
          refreshProviderTerminal();
        }
      } else if (eventType === "message_stop") {
        finish();
      }
      return;
    }

    const choices = (event.choices as Array<Record<string, unknown>>) ?? [];
    const choice = choices[0];
    if (choice) {
      const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
      if (
        !providerTerminalObserved &&
        typeof delta.content === "string" &&
        delta.content
      ) {
        sink.text(delta.content, "text");
      }
      const thinking = delta.reasoning_content ?? delta.reasoning;
      if (
        !providerTerminalObserved &&
        typeof thinking === "string" &&
        thinking
      ) {
        sink.text(thinking, "thinking");
      }
      if (choice.finish_reason != null && !providerTerminalObserved) {
        stopReason = normalizeStopReason(choice.finish_reason);
        observeProviderTerminal();
      }
    }
    const usage = (event.usage as Record<string, unknown> | undefined) ?? {};
    if (typeof usage.prompt_tokens === "number") {
      inputTokens = usage.prompt_tokens;
    }
    if (typeof usage.completion_tokens === "number") {
      outputTokens = usage.completion_tokens;
    }
    refreshProviderTerminal();
  });
  finish();
}

export function createBrowserAiTransport(
  options: BrowserAiTransportOptions = {},
): BrowserAiTransport {
  const MAX_STREAM_TOMBSTONES = 256;
  const ABORT_QUIESCENCE_TIMEOUT_MS = 2_250;
  interface ActiveBrowserStream {
    readonly controller: AbortController;
    readonly settled: Promise<void>;
    readonly resolveSettled: () => void;
  }
  const activeStreams = new Map<string, ActiveBrowserStream>();
  const pendingAbortIds = new Set<string>();
  const completedAbortReceipts = new Map<string, boolean>();

  const requireStreamId = (value: unknown): string => {
    if (typeof value !== "string" || !value || value !== value.trim()) {
      throw new Error("Browser AI streamId must be a trimmed non-empty string");
    }
    return value;
  };
  const addBoundedSet = (target: Set<string>, value: string): void => {
    target.delete(value);
    target.add(value);
    while (target.size > MAX_STREAM_TOMBSTONES) {
      const oldest = target.values().next().value as string | undefined;
      if (oldest === undefined) break;
      target.delete(oldest);
    }
  };
  const addCompletedReceipt = (streamId: string, observed: boolean): void => {
    completedAbortReceipts.delete(streamId);
    completedAbortReceipts.set(streamId, observed);
    while (completedAbortReceipts.size > MAX_STREAM_TOMBSTONES) {
      const oldest = completedAbortReceipts.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      completedAbortReceipts.delete(oldest);
    }
  };
  const waitForSettled = async (promise: Promise<void>): Promise<boolean> => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settled = await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), ABORT_QUIESCENCE_TIMEOUT_MS);
      }),
    ]);
    if (timeout !== null) clearTimeout(timeout);
    return settled;
  };

  return {
    complete: (request) =>
      completeBrowserAiRequest(
        request,
        undefined,
        options.onEffectiveRequest,
        "single",
      ),
    completeAgent: (request, messages, tools) =>
      completeBrowserAgentRequest(
        request,
        messages,
        tools,
        options.onEffectiveRequest,
      ),
    stream: async (request, sink) => {
      const streamId = requireStreamId(request.streamId);
      if (activeStreams.has(streamId)) {
        throw new Error(`Browser AI streamId is already active: ${streamId}`);
      }
      completedAbortReceipts.delete(streamId);
      if (pendingAbortIds.delete(streamId)) {
        addCompletedReceipt(streamId, true);
        sink.done({ stopReason: "stopped" });
        return;
      }
      const controller = new AbortController();
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      const active: ActiveBrowserStream = {
        controller,
        settled,
        resolveSettled,
      };
      activeStreams.set(streamId, active);
      let terminalObserved = false;
      const providerTerminal: { value: BrowserAiStreamDone | null } = {
        value: null,
      };
      const terminalAwareSink: BrowserAiStreamSink = {
        text: (delta, blockType) => sink.text(delta, blockType),
        done: (payload) => {
          if (terminalObserved) return;
          terminalObserved = true;
          sink.done(payload);
        },
      };
      try {
        await streamBrowserAiRequest(
          request,
          terminalAwareSink,
          controller.signal,
          (payload) => {
            providerTerminal.value = payload;
          },
          options.onEffectiveRequest,
        );
      } catch (error) {
        const terminal = providerTerminal.value;
        if (terminal) {
          if (!terminalObserved) {
            terminalAwareSink.done(
              controller.signal.aborted
                ? {
                    ...terminal,
                    providerTerminalObservedBeforeAbort: true,
                  }
                : terminal,
            );
          }
          return;
        }
        if (controller.signal.aborted) {
          if (!terminalObserved) {
            terminalAwareSink.done({ stopReason: "stopped" });
          }
          return;
        }
        throw error;
      } finally {
        if (activeStreams.get(streamId) === active) {
          activeStreams.delete(streamId);
        }
        addCompletedReceipt(streamId, true);
        active.resolveSettled();
      }
    },
    abort: async (rawStreamId) => {
      const streamId = requireStreamId(rawStreamId);
      const active = activeStreams.get(streamId);
      if (!active) {
        const completed = completedAbortReceipts.get(streamId);
        if (completed !== undefined) {
          return {
            abortCommandAcknowledged: true,
            transportTerminationObserved: completed,
          };
        }
        addBoundedSet(pendingAbortIds, streamId);
        return {
          abortCommandAcknowledged: true,
          transportTerminationObserved: false,
        };
      }
      active.controller.abort();
      return {
        abortCommandAcknowledged: true,
        transportTerminationObserved: await waitForSettled(active.settled),
      };
    },
    dispose: () => {
      for (const active of activeStreams.values()) {
        active.controller.abort();
      }
      pendingAbortIds.clear();
    },
  };
}

export async function fetchModels(
  provider: AiProvider,
  apiKey: string,
  options: BrowserAiConnectionOptions = {},
): Promise<AiModel[]> {
  if (provider !== "ollama") {
    return fetchModelsInternal(provider, apiKey, options);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.selectedModelId?.trim()
      ? OLLAMA_SELECTED_METADATA_TIMEOUT_MS
      : OLLAMA_CATALOG_METADATA_TIMEOUT_MS,
  );
  try {
    return await fetchModelsInternal(
      provider,
      apiKey,
      options,
      controller.signal,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchModelsInternal(
  provider: AiProvider,
  apiKey: string,
  options: BrowserAiConnectionOptions,
  ollamaMetadataSignal?: AbortSignal,
): Promise<AiModel[]> {
  requireBrowserDirectProvider(provider);
  // Anthropic: static list
  if (provider === "anthropic") {
    return [
      { id: "claude-fable-5", name: "Claude Fable 5" },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    ];
  }

  const legacyAiNovelistModels: AiModel[] =
    provider === "ai-novelist"
      ? Object.keys(AINOVERIST_MODEL_CAPS).map((id) => ({
          id,
          name:
            id === "supertrin"
              ? "supertrin (legacy)"
              : id === "damsel"
                ? "damsel (legacy)"
                : id,
          apiVariant: "legacy" as const,
        }))
      : [];

  const url = modelsEndpoint(provider, options);
  if (!url) return [];

  const headers = buildHeaders(provider, apiKey);
  delete headers["content-type"];

  let resp: Response;
  try {
    resp = await browserAiFetch(
      url,
      {
        headers,
        ...(ollamaMetadataSignal ? { signal: ollamaMetadataSignal } : {}),
      },
      "models",
    );
  } catch (error) {
    if (provider === "ai-novelist") {
      return [
        ...legacyAiNovelistModels,
        ...AINOVERIST_V1_KNOWN_MODELS.map((id) => ({
          id,
          name: id === "spiko_ultra" ? "Spiko Ultra" : id,
          apiVariant: "v1" as const,
        })),
      ];
    }
    throw error;
  }

  if (!resp.ok) {
    if (provider === "ai-novelist") {
      return [
        ...legacyAiNovelistModels,
        ...AINOVERIST_V1_KNOWN_MODELS.map((id) => ({
          id,
          name: id === "spiko_ultra" ? "Spiko Ultra" : id,
          apiVariant: "v1" as const,
        })),
      ];
    }
    const errMsg = await parseErrorResponse(resp);
    throw createHttpFailure(
      "Failed to fetch models",
      resp,
      errMsg,
      url,
      "models",
    );
  }

  const body = await resp.json();

  if (provider === "ollama") {
    type OllamaTag = {
      name: string;
      model?: string;
      digest?: string;
      capabilities?: string[];
    };
    type OllamaRunner = {
      name?: string;
      model?: string;
      digest?: string;
      context_length?: number;
    };
    const taggedModels: unknown[] = Array.isArray(body?.models)
      ? body.models
      : [];
    const selectedModelId = options.selectedModelId?.trim() ?? "";
    const normalizedSelectedModel = normalizeOllamaModelName(selectedModelId);
    const models = taggedModels.filter((model: unknown): model is OllamaTag => {
      if (
        !model ||
        typeof model !== "object" ||
        typeof (model as OllamaTag).name !== "string"
      ) {
        return false;
      }
      if (!selectedModelId) return true;
      const tag = model as OllamaTag;
      return (
        tag.name === selectedModelId ||
        tag.model === selectedModelId ||
        normalizeOllamaModelName(tag.name) === normalizedSelectedModel ||
        normalizeOllamaModelName(tag.model) === normalizedSelectedModel
      );
    });
    if (models.length === 0) return [];
    const runningBodyPromise = optionalOllamaJson(
      ollamaApiEndpoint("/api/ps", options),
      ollamaMetadataSignal ? { signal: ollamaMetadataSignal } : {},
    );
    const modelsWithShowPromise = mapWithConcurrency(
      models,
      4,
      async (model) => {
        const showBody = await optionalOllamaJson(
          ollamaApiEndpoint("/api/show", options),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: model.name }),
            ...(ollamaMetadataSignal ? { signal: ollamaMetadataSignal } : {}),
          },
        );
        const show =
          showBody && typeof showBody === "object"
            ? (showBody as Record<string, unknown>)
            : undefined;
        return { model, show };
      },
    );
    const [runningBody, modelsWithShow] = await Promise.all([
      runningBodyPromise,
      modelsWithShowPromise,
    ]);
    const parseRunningModels = (value: unknown): OllamaRunner[] =>
      value &&
      typeof value === "object" &&
      Array.isArray((value as { models?: unknown }).models)
        ? ((value as { models: OllamaRunner[] }).models ?? [])
        : [];
    let runningModels = parseRunningModels(runningBody);
    const findRunner = (model: OllamaTag): OllamaRunner | undefined => {
      const normalizedName = normalizeOllamaModelName(
        model.model ?? model.name,
      );
      return runningModels.find((candidate) => {
        if (
          model.digest &&
          candidate.digest &&
          model.digest === candidate.digest
        ) {
          return true;
        }
        return (
          normalizedName.length > 0 &&
          [candidate.model, candidate.name].some(
            (candidateName) =>
              normalizeOllamaModelName(candidateName) === normalizedName,
          )
        );
      });
    };

    // Loading every catalog entry would consume VRAM and surprise the user.
    // Only the selected send-time probe may issue this prompt-free control
    // request to load a cold runner so `/api/ps` can report the allocation
    // Ollama chose. The body intentionally has no prompt and requests no token
    // generation/model output, so this is not an inference-ledger execution.
    const selectedModel = selectedModelId ? models[0] : undefined;
    if (selectedModel && !findRunner(selectedModel)) {
      const loaded = await optionalOllamaJson(
        ollamaApiEndpoint("/api/generate", options),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: selectedModel.name, stream: false }),
          ...(ollamaMetadataSignal ? { signal: ollamaMetadataSignal } : {}),
        },
        OLLAMA_MODEL_LOAD_TIMEOUT_MS,
      );
      if (loaded !== undefined) {
        const refreshedRunningBody = await optionalOllamaJson(
          ollamaApiEndpoint("/api/ps", options),
          ollamaMetadataSignal ? { signal: ollamaMetadataSignal } : {},
        );
        runningModels = parseRunningModels(refreshedRunningBody);
      }
    }

    return modelsWithShow.map(({ model, show }) => {
      const modelMaximum = ollamaModelContextLength(show?.model_info);
      const modelParameterContext = ollamaNumCtx(show?.parameters);
      const runner = findRunner(model);
      const runnerContext = positiveInteger(runner?.context_length);
      const rawEffectiveContext = runnerContext ?? modelParameterContext;
      const effectiveContextLength =
        rawEffectiveContext && modelMaximum
          ? Math.min(rawEffectiveContext, modelMaximum)
          : rawEffectiveContext;
      const supportedParameters =
        ollamaSupportedParameters(show?.capabilities ?? model.capabilities) ??
        (show ? [] : undefined);

      return {
        id: model.name,
        name: model.name,
        ...(modelMaximum ? { contextLength: modelMaximum } : {}),
        ...(effectiveContextLength
          ? {
              effectiveContextLength,
              effectiveContextSource: runnerContext
                ? ("runner" as const)
                : ("model-parameter" as const),
            }
          : {}),
        ...(supportedParameters ? { supportedParameters } : {}),
      };
    });
  }

  const data = body?.data ?? [];
  if (provider === "openrouter") {
    return data.map(
      (m: {
        id: string;
        name?: string;
        context_length?: number;
        top_provider?: { max_completion_tokens?: number };
        supported_parameters?: string[];
        pricing?: { prompt?: string; completion?: string };
      }) => ({
        id: m.id,
        name: m.name ?? m.id,
        contextLength: m.context_length,
        maxCompletionTokens: m.top_provider?.max_completion_tokens,
        supportedParameters: m.supported_parameters,
        pricingPrompt: m.pricing?.prompt,
        pricingCompletion: m.pricing?.completion,
      }),
    );
  }
  const openAiModels = data.map((m: { id: string; name?: string }) => ({
    id: m.id,
    name: m.name ?? m.id,
    ...(provider === "ai-novelist" ? { apiVariant: "v1" as const } : undefined),
  }));
  if (provider === "ai-novelist") {
    const byId = new Map<string, AiModel>();
    for (const model of [...legacyAiNovelistModels, ...openAiModels]) {
      byId.set(model.id, model);
    }
    return [...byId.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }
  return openAiModels;
}

// ---------------------------------------------------------------------------
// Agent / Tool Use
// ---------------------------------------------------------------------------

function buildAnthropicMessages(
  messages: AgentMessagePayload[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      if (!msg.toolUses || msg.toolUses.length === 0) {
        result.push({ role: "assistant", content: msg.content });
      } else {
        const blocks: unknown[] = [];
        if (msg.content) blocks.push({ type: "text", text: msg.content });
        for (const tu of msg.toolUses) {
          blocks.push({
            type: "tool_use",
            id: tu.id,
            name: tu.name,
            input: tu.input,
          });
        }
        result.push({ role: "assistant", content: blocks });
      }
    } else if (msg.role === "tool_result") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolUseId,
            content: msg.content,
            is_error: msg.isError ?? false,
          },
        ],
      });
    }
  }
  return result;
}

function buildOpenAIMessages(
  messages: AgentMessagePayload[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else if (msg.role === "system") {
      result.push({ role: "system", content: msg.content });
    } else if (msg.role === "assistant") {
      if (!msg.toolUses || msg.toolUses.length === 0) {
        result.push({ role: "assistant", content: msg.content });
      } else {
        const toolCalls = msg.toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        }));
        result.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: toolCalls,
        });
      }
    } else if (msg.role === "tool_result") {
      result.push({
        role: "tool",
        tool_call_id: msg.toolUseId,
        content: msg.content,
      });
    }
  }
  return result;
}

/**
 * Hermes 用 OpenAI 互換 messages（Rust `build_hermes_openai_messages` のパリティ）。
 * tools[] は送らず <tools> system XML + <tool_call>/<tool_response> テキストで授受する。
 */
function buildHermesOpenAIMessages(
  messages: AgentMessagePayload[],
  tools: AgentToolDefinition[],
): Record<string, unknown>[] {
  const preamble = buildHermesToolsPreamble(tools);
  const out: Record<string, unknown>[] = [];
  const nameById = new Map<string, string>();
  let preambleApplied = false;
  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
    } else if (msg.role === "system") {
      const merged = preambleApplied
        ? msg.content
        : `${msg.content}\n\n${preamble}`;
      preambleApplied = true;
      out.push({ role: "system", content: merged });
    } else if (msg.role === "assistant") {
      for (const tu of msg.toolUses ?? []) nameById.set(tu.id, tu.name);
      if (!msg.toolUses || msg.toolUses.length === 0) {
        out.push({ role: "assistant", content: msg.content });
      } else {
        let text = msg.content;
        for (const tu of msg.toolUses) {
          if (text) text += "\n";
          text += formatHermesToolCall(tu.name, tu.input);
        }
        out.push({ role: "assistant", content: text });
      }
    } else if (msg.role === "tool_result") {
      const name = nameById.get(msg.toolUseId) ?? "";
      out.push({
        role: "user",
        content: formatHermesToolResponse(name, msg.content, !!msg.isError),
      });
    }
  }
  if (!preambleApplied) out.unshift({ role: "system", content: preamble });
  return out;
}

function parseAnthropicAgentResponse(result: unknown): AgentLLMResponse {
  const r = result as Record<string, unknown>;
  const stopReason = (r["stop_reason"] as string) ?? "end_turn";
  const blocks: ResponseBlock[] = [];

  for (const block of (r["content"] as unknown[]) ?? []) {
    const b = block as Record<string, unknown>;
    if (b["type"] === "text") {
      const text = (b["text"] as string) ?? "";
      if (text) blocks.push({ type: "text", content: text });
    } else if (b["type"] === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: (b["id"] as string) ?? "",
        name: (b["name"] as string) ?? "",
        input: (b["input"] as Record<string, unknown>) ?? {},
      });
    } else if (b["type"] === "thinking") {
      blocks.push({
        type: "thinking",
        content: (b["thinking"] as string) ?? "",
        summary: b["summary"] as string | undefined,
      });
    }
  }

  return {
    blocks,
    stopReason: stopReason as AgentLLMResponse["stopReason"],
  };
}

function parseOpenAIAgentResponse(
  result: unknown,
  hermes?: { allowedNames: readonly string[] },
): AgentLLMResponse {
  const r = result as Record<string, unknown>;
  const choices = r["choices"] as Record<string, unknown>[];
  const choice = choices?.[0] ?? {};
  const finishReason = (choice["finish_reason"] as string) ?? "stop";
  let stopReason: AgentLLMResponse["stopReason"] =
    finishReason === "tool_calls" ? "tool_use" : "end_turn";

  const blocks: ResponseBlock[] = [];
  const message = (choice["message"] as Record<string, unknown>) ?? {};

  const content = message["content"] as string | undefined;
  const nativeToolCalls = (message["tool_calls"] as unknown[]) ?? [];

  // 優先順は Rust parse_openai_response と同一: native tool_calls > 本文 Hermes。
  if (nativeToolCalls.length > 0) {
    if (content) blocks.push({ type: "text", content });
    for (const tc of nativeToolCalls) {
      const t = tc as Record<string, unknown>;
      const fn_ = (t["function"] as Record<string, unknown>) ?? {};
      const argsStr = (fn_["arguments"] as string) ?? "{}";
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(argsStr);
      } catch {
        // keep empty
      }
      blocks.push({
        type: "tool_use",
        id: (t["id"] as string) ?? "",
        name: (fn_["name"] as string) ?? "",
        input,
      });
    }
  } else if (hermes) {
    const { strippedText, calls } = parseHermesToolCalls(
      content ?? "",
      hermes.allowedNames,
    );
    if (strippedText) blocks.push({ type: "text", content: strippedText });
    if (calls.length > 0) {
      stopReason = "tool_use";
      for (const c of calls) {
        blocks.push({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: c.input,
        });
      }
    }
  } else if (content) {
    blocks.push({ type: "text", content });
  }

  return { blocks, stopReason };
}

export async function sendChatWithTools(
  provider: AiProvider,
  model: string,
  apiKey: string,
  messages: AgentMessagePayload[],
  tools: AgentToolDefinition[],
  toolProtocolMode: ToolProtocolMode = "auto",
  options: BrowserAiConnectionOptions = {},
  hooks: BrowserAiDispatchHooks = {},
): Promise<AgentLLMResponse> {
  return completeBrowserAgentRequest(
    {
      operation: "chat",
      provider,
      model,
      apiKey,
      messages: [],
      toolProtocolMode,
      ...options,
      ...(hooks.auditContext ? { auditContext: hooks.auditContext } : {}),
    },
    messages,
    tools,
    hooks.onEffectiveRequest,
  );
}

async function completeBrowserAgentRequest(
  request: BrowserAiRequest,
  messages: AgentMessagePayload[],
  tools: AgentToolDefinition[],
  onEffectiveRequest?: BrowserAiEffectiveRequestObserver,
): Promise<AgentLLMResponse> {
  requireBrowserAiRequest(request);
  const { provider, model } = request;
  if (
    isAiNovelistLegacy({
      provider,
      model,
      apiVariant: request.apiVariant,
    })
  ) {
    throw new Error("AI のべりすと (legacy) は Tool Use に対応していません");
  }
  const headers = buildHeaders(provider, request.apiKey ?? "");
  const url = chatEndpoint(provider, request);
  const maxTokens = request.maxOutputTokens ?? 4096;

  // Rust parity: provider ゲート + auto/native/hermes を一度だけ解決し、
  // 送信側 (tools[] 省略 + <tools> XML) と受信側パースの両方で使う。
  const resolved: "native" | "hermes" =
    provider === "anthropic"
      ? "native"
      : resolveToolProtocol(
          provider,
          model,
          request.toolProtocolMode ?? "auto",
        );

  let body: Record<string, unknown>;

  if (provider === "anthropic") {
    const systemContent = messages
      .filter(
        (m): m is { role: "system"; content: string } => m.role === "system",
      )
      .map((m) => m.content)
      .join("\n");
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    body = {
      model,
      max_tokens: maxTokens,
      messages: buildAnthropicMessages(messages),
      tools: anthropicTools,
    };
    if (systemContent) body["system"] = systemContent;
  } else if (resolved === "hermes") {
    // Hermes: tools[] を送らず (tool 非対応エンドポイントで 404 になるため)、
    // <tools> system XML + <tool_call>/<tool_response> テキストで授受する。
    body = {
      model,
      max_tokens: maxTokens,
      messages: buildHermesOpenAIMessages(messages, tools),
    };
  } else {
    const openaiTools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
    body = {
      model,
      max_tokens: maxTokens,
      messages: buildOpenAIMessages(messages),
      tools: openaiTools,
    };
  }

  const bodyJson = await serializeEffectiveRequestBody(
    request,
    "agent",
    url,
    body,
    onEffectiveRequest,
  );

  const resp = await browserAiFetch(
    url,
    {
      method: "POST",
      headers,
      body: bodyJson,
    },
    "chat",
  );

  if (!resp.ok) {
    const errMsg = await parseErrorResponse(resp);
    throw createHttpFailure("Agent request failed", resp, errMsg, url, "chat");
  }

  const result = await resp.json();
  if (provider === "anthropic") return parseAnthropicAgentResponse(result);
  // Hermes 解決時のみ本文 <tool_call> を declared tool に対してパースする。
  // mutating ツールは本文チャンネルからは発火させない (injection-driven write
  // 防御。MUTATING_TOOL_NAMES 参照)。
  const hermes =
    resolved === "hermes"
      ? { allowedNames: hermesAllowedToolNames(tools.map((t) => t.name)) }
      : undefined;
  return parseOpenAIAgentResponse(result, hermes);
}

export async function testConnection(
  provider: AiProvider,
  model: string,
  apiKey: string,
  options: BrowserAiConnectionOptions = {},
  hooks: BrowserAiDispatchHooks = {},
): Promise<string> {
  const headers = buildHeaders(provider, apiKey);
  const request: BrowserAiRequest = {
    operation: "chat",
    provider,
    model,
    apiKey,
    messages: [{ role: "user", content: "Reply with exactly: Connection OK" }],
    maxOutputTokens: 32,
    ...options,
    ...(hooks.auditContext ? { auditContext: hooks.auditContext } : {}),
  };
  const url = chatEndpoint(provider, options);
  const body = isAiNovelistLegacy(request)
    ? {
        text: "Reply with exactly: Connection OK",
        model,
        length: 32,
      }
    : buildChatBody(request);
  const bodyJson = await serializeEffectiveRequestBody(
    request,
    "connection",
    url,
    body,
    hooks.onEffectiveRequest,
  );

  const resp = await browserAiFetch(
    url,
    {
      method: "POST",
      headers,
      body: bodyJson,
    },
    "chat",
  );

  if (!resp.ok) {
    const errMsg = await parseErrorResponse(resp);
    throw createHttpFailure(
      "Connection test failed",
      resp,
      errMsg,
      url,
      "chat",
    );
  }

  const result = await resp.json();

  if (isAiNovelistLegacy(request)) {
    const parsed = parseAiNovelistLegacyResponse(
      result as Record<string, unknown>,
    );
    return parsed.blocks
      .filter(
        (block): block is Extract<ResponseBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.content)
      .join("\n");
  }
  if (provider === "anthropic") {
    return result?.content?.[0]?.text ?? "Connection successful";
  }
  return result?.choices?.[0]?.message?.content ?? "Connection successful";
}
