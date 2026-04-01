/**
 * Browser-mode AI client.
 * Mirrors src-tauri/src/ai.rs logic using fetch() via Vite dev proxy.
 * Only used when running without Tauri (npm run dev in browser).
 */
import type { AiModel, AiProvider } from "@/features/chat/types";

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
