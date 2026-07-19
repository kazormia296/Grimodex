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

export interface BrowserAiRequest {
  operation: BrowserAiOperation;
  provider: AiProvider;
  model: string;
  endpointId?: string | null;
  apiKey?: string;
  messages: ChatMessage[];
  maxOutputTokens?: number | null;
  ollamaEndpoint?: string | null;
}

export type BrowserAiCompletion = AgentLLMResponse;

export interface BrowserAiStreamDone {
  stopReason: AgentLLMResponse["stopReason"] | "stopped";
  inputTokens?: number;
  outputTokens?: number;
}

export interface BrowserAiStreamSink {
  text(delta: string, blockType?: "text" | "thinking"): void;
  done(payload: BrowserAiStreamDone): void;
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
  abort?(operation: BrowserAiOperation): void;
}

const isViteDevelopment = import.meta.env.DEV;

export type BrowserAiEndpointResource = "chat" | "models";

function requireBrowserDirectProvider(provider: AiProvider): void {
  if (
    provider !== "ollama" &&
    provider !== "openai" &&
    provider !== "anthropic"
  ) {
    throw new Error(`Provider "${provider}" is not supported in browser mode`);
  }
}

export function resolveBrowserAiEndpoint(
  provider: AiProvider,
  resource: BrowserAiEndpointResource,
  options: { development?: boolean; ollamaEndpoint?: string | null } = {},
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
  }
  throw new Error(`Provider "${provider}" is not supported in browser mode`);
}

export function normalizeOllamaEndpoint(endpoint?: string | null): string {
  const base = endpoint?.trim() || "http://localhost:11434";
  return base.replace(/\/+$/, "");
}

function chatEndpoint(
  provider: AiProvider,
  ollamaEndpoint?: string | null,
): string {
  const endpoint = resolveBrowserAiEndpoint(provider, "chat", {
    ollamaEndpoint,
  });
  if (!endpoint) {
    throw new Error(`No browser chat endpoint is available for ${provider}`);
  }
  return endpoint;
}

function modelsEndpoint(
  provider: AiProvider,
  ollamaEndpoint?: string | null,
): string | null {
  return resolveBrowserAiEndpoint(provider, "models", { ollamaEndpoint });
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
      headers["Authorization"] = `Bearer ${apiKey}`;
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
): Promise<string> {
  const result = await completeBrowserAiRequest({
    operation: "chat",
    provider,
    model,
    apiKey,
    messages,
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

function requireBrowserAiRequest(request: BrowserAiRequest): void {
  requireBrowserDirectProvider(request.provider);
  if (!request.model.trim()) {
    throw new Error("AIモデルが設定されていません");
  }
  if (request.provider !== "ollama" && !request.apiKey?.trim()) {
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
): Promise<BrowserAiCompletion> {
  requireBrowserAiRequest(request);
  const headers = buildHeaders(request.provider, request.apiKey ?? "");
  const url = chatEndpoint(request.provider, request.ollamaEndpoint);
  const body = buildChatBody(request);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const errMsg = await parseErrorResponse(resp);
    throw new Error(`AI request failed (${resp.status}): ${errMsg}`);
  }

  const result = (await resp.json()) as Record<string, unknown>;

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
): Promise<void> {
  requireBrowserAiRequest(request);
  const headers = buildHeaders(request.provider, request.apiKey ?? "");
  const body: Record<string, unknown> = {
    ...buildChatBody(request),
    stream: true,
  };
  if (request.provider !== "anthropic" && request.provider !== "ollama") {
    body.stream_options = { include_usage: true };
  }

  const response = await fetch(
    chatEndpoint(request.provider, request.ollamaEndpoint),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!response.ok) {
    const message = await parseErrorResponse(response);
    throw new Error(`AI request failed (${response.status}): ${message}`);
  }

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: BrowserAiStreamDone["stopReason"] = "end_turn";
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    sink.done({ stopReason, inputTokens, outputTokens });
  };

  await readSse(response, (data) => {
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
        stopReason = normalizeStopReason(delta.stop_reason);
        if (typeof usage.output_tokens === "number") {
          outputTokens = usage.output_tokens;
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
      if (typeof delta.content === "string" && delta.content) {
        sink.text(delta.content, "text");
      }
      const thinking = delta.reasoning_content ?? delta.reasoning;
      if (typeof thinking === "string" && thinking) {
        sink.text(thinking, "thinking");
      }
      if (choice.finish_reason != null) {
        stopReason = normalizeStopReason(choice.finish_reason);
      }
    }
    const usage = (event.usage as Record<string, unknown> | undefined) ?? {};
    if (typeof usage.prompt_tokens === "number") {
      inputTokens = usage.prompt_tokens;
    }
    if (typeof usage.completion_tokens === "number") {
      outputTokens = usage.completion_tokens;
    }
  });
  finish();
}

export function createBrowserAiTransport(): BrowserAiTransport {
  const controllers = new Map<BrowserAiOperation, AbortController>();

  return {
    complete: (request) => completeBrowserAiRequest(request),
    stream: async (request, sink) => {
      controllers.get(request.operation)?.abort();
      const controller = new AbortController();
      controllers.set(request.operation, controller);
      try {
        await streamBrowserAiRequest(request, sink, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          sink.done({ stopReason: "stopped" });
          return;
        }
        throw error;
      } finally {
        if (controllers.get(request.operation) === controller) {
          controllers.delete(request.operation);
        }
      }
    },
    abort: (operation) => {
      controllers.get(operation)?.abort();
    },
  };
}

export async function fetchModels(
  provider: AiProvider,
  apiKey: string,
  ollamaEndpoint?: string | null,
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

  const url = modelsEndpoint(provider, ollamaEndpoint);
  if (!url) return [];

  const headers: Record<string, string> = {};
  if (provider === "openai") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const resp = await fetch(url, { headers });

  if (!resp.ok) {
    const errMsg = await parseErrorResponse(resp);
    throw new Error(`Failed to fetch models (${resp.status}): ${errMsg}`);
  }

  const body = await resp.json();

  if (provider === "ollama") {
    const models = body?.models ?? [];
    return models.map((m: { name: string }) => ({
      id: m.name,
      name: m.name,
    }));
  }

  // OpenAI
  const data = body?.data ?? [];
  return data.map((m: { id: string; name?: string }) => ({
    id: m.id,
    name: m.name ?? m.id,
  }));
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
  ollamaEndpoint?: string | null,
): Promise<AgentLLMResponse> {
  const headers = buildHeaders(provider, apiKey);
  const url = chatEndpoint(provider, ollamaEndpoint);

  // Rust parity: provider ゲート + auto/native/hermes を一度だけ解決し、
  // 送信側 (tools[] 省略 + <tools> XML) と受信側パースの両方で使う。
  const resolved: "native" | "hermes" =
    provider === "anthropic"
      ? "native"
      : resolveToolProtocol(provider, model, toolProtocolMode);

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
      max_tokens: 4096,
      messages: buildAnthropicMessages(messages),
      tools: anthropicTools,
    };
    if (systemContent) body["system"] = systemContent;
  } else if (resolved === "hermes") {
    // Hermes: tools[] を送らず (tool 非対応エンドポイントで 404 になるため)、
    // <tools> system XML + <tool_call>/<tool_response> テキストで授受する。
    body = {
      model,
      max_tokens: 4096,
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
      max_tokens: 4096,
      messages: buildOpenAIMessages(messages),
      tools: openaiTools,
    };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errMsg = await parseErrorResponse(resp);
    throw new Error(`Agent request failed (${resp.status}): ${errMsg}`);
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
  ollamaEndpoint?: string | null,
): Promise<string> {
  const headers = buildHeaders(provider, apiKey);
  const url = chatEndpoint(provider, ollamaEndpoint);

  let body: Record<string, unknown>;

  if (provider === "anthropic") {
    body = {
      model,
      max_tokens: 32,
      messages: [
        { role: "user", content: "Reply with exactly: Connection OK" },
      ],
    };
  } else {
    body = {
      model,
      max_tokens: 32,
      messages: [
        { role: "user", content: "Reply with exactly: Connection OK" },
      ],
    };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errMsg = await parseErrorResponse(resp);
    throw new Error(`Connection test failed (${resp.status}): ${errMsg}`);
  }

  const result = await resp.json();

  if (provider === "anthropic") {
    return result?.content?.[0]?.text ?? "Connection successful";
  }
  return result?.choices?.[0]?.message?.content ?? "Connection successful";
}
