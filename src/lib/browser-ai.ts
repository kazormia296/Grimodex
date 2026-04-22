/**
 * Browser-mode AI client.
 * Mirrors src-tauri/src/ai.rs logic using fetch() via Vite dev proxy.
 * Only used when running without Tauri (pnpm dev in browser).
 */
import type { AiModel, AiProvider } from "@/features/chat/types";
import type {
  AgentMessagePayload,
  AgentLLMResponse,
  AgentToolDefinition,
  ResponseBlock,
} from "@/features/chat/agent/agentTypes";

interface ChatMessage {
  role: string;
  content: string;
}

function chatEndpoint(provider: AiProvider): string {
  switch (provider) {
    case "anthropic":
      return "/api/anthropic/messages";
    case "openai":
      return "/api/openai/chat/completions";
    case "openrouter":
      return "/api/openrouter/chat/completions";
    case "ollama":
      return "/api/ollama/v1/chat/completions";
  }
}

function modelsEndpoint(provider: AiProvider): string | null {
  switch (provider) {
    case "anthropic":
      return null; // static list
    case "openai":
      return "/api/openai/models";
    case "openrouter":
      return "/api/openrouter/models";
    case "ollama":
      return "/api/ollama/api/tags";
  }
}

function buildHeaders(
  provider: AiProvider,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  switch (provider) {
    case "anthropic":
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "openrouter":
      headers["Authorization"] = `Bearer ${apiKey}`;
      headers["HTTP-Referer"] = "https://github.com/futurebassisdead/Grimodex";
      headers["X-Title"] = "Grimodex";
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
  const headers = buildHeaders(provider, apiKey);
  const url = chatEndpoint(provider);

  let body: Record<string, unknown>;

  if (provider === "anthropic") {
    const systemContent = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const chatMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    body = { model, max_tokens: 4096, messages: chatMessages };
    if (systemContent) {
      body.system = systemContent;
    }
  } else {
    const chatMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    body = { model, max_tokens: 4096, messages: chatMessages };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errMsg = await parseErrorResponse(resp);
    throw new Error(`AI request failed (${resp.status}): ${errMsg}`);
  }

  const result = await resp.json();

  if (provider === "anthropic") {
    return result?.content?.[0]?.text ?? "";
  }
  return result?.choices?.[0]?.message?.content ?? "";
}

export async function fetchModels(
  provider: AiProvider,
  apiKey: string,
): Promise<AiModel[]> {
  // Anthropic: static list
  if (provider === "anthropic") {
    return [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    ];
  }

  const url = modelsEndpoint(provider);
  if (!url) return [];

  const headers: Record<string, string> = {};
  if (provider === "openrouter") {
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["HTTP-Referer"] = "https://github.com/futurebassisdead/Grimodex";
    headers["X-Title"] = "Grimodex";
  } else if (provider === "openai") {
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

  // OpenAI / OpenRouter
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

function parseOpenAIAgentResponse(result: unknown): AgentLLMResponse {
  const r = result as Record<string, unknown>;
  const choices = r["choices"] as Record<string, unknown>[];
  const choice = choices?.[0] ?? {};
  const finishReason = (choice["finish_reason"] as string) ?? "stop";
  const stopReason: AgentLLMResponse["stopReason"] =
    finishReason === "tool_calls" ? "tool_use" : "end_turn";

  const blocks: ResponseBlock[] = [];
  const message = (choice["message"] as Record<string, unknown>) ?? {};

  const content = message["content"] as string | undefined;
  if (content) blocks.push({ type: "text", content });

  for (const tc of (message["tool_calls"] as unknown[]) ?? []) {
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

  return { blocks, stopReason };
}

export async function sendChatWithTools(
  provider: AiProvider,
  model: string,
  apiKey: string,
  messages: AgentMessagePayload[],
  tools: AgentToolDefinition[],
): Promise<AgentLLMResponse> {
  const headers = buildHeaders(provider, apiKey);
  const url = chatEndpoint(provider);

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
  return provider === "anthropic"
    ? parseAnthropicAgentResponse(result)
    : parseOpenAIAgentResponse(result);
}

export async function testConnection(
  provider: AiProvider,
  model: string,
  apiKey: string,
): Promise<string> {
  const headers = buildHeaders(provider, apiKey);
  const url = chatEndpoint(provider);

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
