import {
  HOSTED_EDITOR_AI_LIMITS,
  parseHostedEditorAiAgentRequest,
  parseHostedEditorAiToolCalls,
  type HostedEditorAiAgentRequest,
  type HostedEditorAiMessage,
  type HostedEditorAiToolCall,
  type HostedEditorAiToolDefinition,
} from "@grimodex/scan-contract";
import { DEFAULT_SCAN_AI_MODEL, type ScanEnv } from "../env";

const HOSTED_AI_TIMEOUT_MS = 2 * 60 * 1_000;
const HOSTED_AI_SYSTEM_PROMPT =
  "You are Grimodex Hosted AI. Give concise editor assistance. Do not claim to have written to the workspace.";

export class HostedAiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HostedAiError";
  }
}

export interface HostedAiInput {
  prompt: string;
  context?: string;
  agent?: HostedEditorAiAgentRequest;
}

export interface HostedAiResult {
  response: string;
  provider: string;
  model: string;
  toolCalls?: HostedEditorAiToolCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  const choices = value.choices;
  if (Array.isArray(choices) && choices[0]) {
    const first = choices[0];
    if (isRecord(first)) {
      const message = first.message;
      if (isRecord(message) && typeof message.content === "string")
        return message.content;
    }
  }
  for (const key of ["response", "output_text", "text", "result"]) {
    const nested = responseText(value[key]);
    if (nested) return nested;
  }
  return null;
}

function rawProviderToolCalls(
  value: unknown,
): { present: false } | { present: true; value: unknown } {
  if (!isRecord(value)) return { present: false };
  if (Object.prototype.hasOwnProperty.call(value, "tool_calls")) {
    return { present: true, value: value.tool_calls };
  }
  const choices = value.choices;
  if (!Array.isArray(choices) || !isRecord(choices[0])) {
    return { present: false };
  }
  const message = choices[0].message;
  if (
    !isRecord(message) ||
    !Object.prototype.hasOwnProperty.call(message, "tool_calls")
  ) {
    return { present: false };
  }
  return { present: true, value: message.tool_calls };
}

function providerToolArguments(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return isRecord(parsed) ? parsed : null;
}

function normalizedProviderToolCalls(
  value: unknown,
  tools: HostedEditorAiToolDefinition[],
): HostedEditorAiToolCall[] | undefined {
  const raw = rawProviderToolCalls(value);
  if (!raw.present) return undefined;
  if (!Array.isArray(raw.value)) {
    throw new HostedAiError(
      502,
      "hosted AI provider returned invalid tool calls",
    );
  }
  if (raw.value.length === 0) return undefined;

  const normalized: HostedEditorAiToolCall[] = [];
  for (const rawCall of raw.value) {
    if (!isRecord(rawCall)) {
      throw new HostedAiError(
        502,
        "hosted AI provider returned invalid tool calls",
      );
    }
    const openAiFunction = isRecord(rawCall.function)
      ? rawCall.function
      : undefined;
    const name = openAiFunction?.name ?? rawCall.name;
    const input = providerToolArguments(
      openAiFunction?.arguments ?? rawCall.arguments,
    );
    const id =
      typeof rawCall.id === "string" && rawCall.id.length > 0
        ? rawCall.id
        : `call_${crypto.randomUUID().replaceAll("-", "")}`;
    if (typeof name !== "string" || input === null) {
      throw new HostedAiError(
        502,
        "hosted AI provider returned invalid tool calls",
      );
    }
    normalized.push({ id, name, input });
  }

  const parsed = parseHostedEditorAiToolCalls(
    normalized,
    new Set(tools.map((tool) => tool.name)),
  );
  if (!parsed.ok) {
    throw new HostedAiError(
      502,
      "hosted AI provider returned invalid tool calls",
    );
  }
  return parsed.value;
}

function providerCompletion(
  value: unknown,
  tools: HostedEditorAiToolDefinition[],
): Pick<HostedAiResult, "response" | "toolCalls"> {
  const response = responseText(value) ?? "";
  const toolCalls = normalizedProviderToolCalls(value, tools);
  if (!response && !toolCalls) {
    throw new HostedAiError(502, "hosted AI provider returned no completion");
  }
  const completionBytes = new TextEncoder().encode(
    JSON.stringify({ response, ...(toolCalls ? { toolCalls } : {}) }),
  ).byteLength;
  if (
    response.length > HOSTED_EDITOR_AI_LIMITS.maxResponseTextChars ||
    completionBytes > HOSTED_EDITOR_AI_LIMITS.maxResponseBytes
  ) {
    throw new HostedAiError(502, "hosted AI provider response is too large");
  }
  return { response, ...(toolCalls ? { toolCalls } : {}) };
}

function openAiMessages(messages: HostedEditorAiMessage[]): unknown[] {
  const result: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      result.push({ role: message.role, content: message.content });
    } else if (message.role === "assistant") {
      result.push({
        role: "assistant",
        content: message.content || null,
        ...(message.toolUses && message.toolUses.length > 0
          ? {
              tool_calls: message.toolUses.map((toolUse) => ({
                id: toolUse.id,
                type: "function",
                function: {
                  name: toolUse.name,
                  arguments: JSON.stringify(toolUse.input),
                },
              })),
            }
          : {}),
      });
    } else if (message.role === "tool_result") {
      result.push({
        role: "tool",
        tool_call_id: message.toolUseId,
        content: message.content,
      });
    }
  }
  return result;
}

function providerMessages(input: HostedAiInput): unknown[] {
  if (input.agent) {
    return [
      { role: "system", content: HOSTED_AI_SYSTEM_PROMPT },
      ...openAiMessages(input.agent.messages),
    ];
  }
  return [
    { role: "system", content: HOSTED_AI_SYSTEM_PROMPT },
    {
      role: "user",
      content: `${input.context ? `Context:\n${input.context}\n\n` : ""}${input.prompt}`,
    },
  ];
}

function openAiTools(
  tools: HostedEditorAiToolDefinition[],
): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

async function readBoundedProviderJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > HOSTED_EDITOR_AI_LIMITS.maxResponseBytes
  ) {
    throw new HostedAiError(502, "hosted AI provider response is too large");
  }
  if (!response.body) {
    throw new HostedAiError(502, "hosted AI provider returned no completion");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > HOSTED_EDITOR_AI_LIMITS.maxResponseBytes) {
      await reader.cancel("hosted AI provider response is too large");
      throw new HostedAiError(502, "hosted AI provider response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HostedAiError(502, "hosted AI provider returned invalid JSON");
  }
}

async function withHostedAiTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new HostedAiError(504, "hosted AI provider timed out")),
      HOSTED_AI_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function openAiCompatible(
  url: string,
  token: string,
  model: string,
  input: HostedAiInput,
  extraHeaders: Record<string, string> = {},
): Promise<Pick<HostedAiResult, "response" | "toolCalls">> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HOSTED_AI_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: providerMessages(input),
        ...(input.agent && input.agent.tools.length > 0
          ? { tools: openAiTools(input.agent.tools), tool_choice: "auto" }
          : {}),
        temperature: 0.2,
        max_tokens: HOSTED_EDITOR_AI_LIMITS.maxProviderCompletionTokens,
      }),
    });
  } catch (cause) {
    if (controller.signal.aborted)
      throw new HostedAiError(504, "hosted AI provider timed out");
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok)
    throw new HostedAiError(
      response.status,
      "hosted AI provider request failed",
    );
  return providerCompletion(
    await readBoundedProviderJson(response),
    input.agent?.tools ?? [],
  );
}

export async function runHostedAi(
  env: ScanEnv,
  input: HostedAiInput,
): Promise<HostedAiResult> {
  if (input.agent) {
    const parsed = parseHostedEditorAiAgentRequest(input.agent, input.prompt);
    if (!parsed.ok || input.context !== undefined) {
      throw new HostedAiError(400, "hosted AI agent request is invalid");
    }
    input = { ...input, agent: parsed.value };
  }

  const provider =
    env.SCAN_AI_PROVIDER ?? (env.AI ? "workers-ai" : "ai-gateway");
  const model = env.SCAN_AI_MODEL ?? DEFAULT_SCAN_AI_MODEL;
  if (provider === "workers-ai") {
    if (!env.AI) throw new HostedAiError(503, "Workers AI is not configured");
    const raw = await withHostedAiTimeout(
      env.AI.run(model, {
        messages: providerMessages(input),
        ...(input.agent && input.agent.tools.length > 0
          ? { tools: openAiTools(input.agent.tools), tool_choice: "auto" }
          : {}),
        max_completion_tokens:
          HOSTED_EDITOR_AI_LIMITS.maxProviderCompletionTokens,
      }),
    );
    return {
      ...providerCompletion(raw, input.agent?.tools ?? []),
      provider,
      model,
    };
  }
  if (provider === "ai-gateway") {
    if (!env.SCAN_AI_GATEWAY_URL || !env.AI_GATEWAY_TOKEN) {
      throw new HostedAiError(503, "AI Gateway is not configured");
    }
    return {
      ...(await openAiCompatible(
        env.SCAN_AI_GATEWAY_URL,
        env.AI_GATEWAY_TOKEN,
        model,
        input,
      )),
      provider,
      model,
    };
  }
  if (provider === "openrouter") {
    if (!env.OPENROUTER_URL || !env.OPENROUTER_API_KEY) {
      throw new HostedAiError(503, "OpenRouter is not configured");
    }
    return {
      ...(await openAiCompatible(
        env.OPENROUTER_URL,
        env.OPENROUTER_API_KEY,
        model,
        input,
        { "x-title": "Grimodex Hosted AI" },
      )),
      provider,
      model,
    };
  }
  throw new HostedAiError(503, "hosted AI provider is invalid");
}
