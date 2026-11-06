/**
 * 診断（diagnostic only）専用。製品の Rust（grimodex-ai の `build_anthropic_chat_body`／
 * `build_system_payload`／`anthropic_beta_headers`）が Anthropic Messages API へ送る形を
 * 純粋関数で再現する。製品の経路（transport）には触れない。
 *
 * 製品との対応（src-tauri/crates/grimodex-ai/src/lib.rs）:
 *   - system message は "\n" で連結した fallback、非 system は {role, content} の配列。
 *   - systemCacheSegments があり空でない block が 1 つ以上あれば、system は
 *     [{type:"text", text, cache_control:{type:"ephemeral"}}, ...]。
 *   - segment が全部空なら segments を "\n" 連結した文字列、それも空なら fallback。
 *   - segments が無く system message も無ければ `system` は付けない。
 *   - segment があるとき `anthropic-beta: prompt-caching-2024-07-31`。
 *   - temperature・thinking は付けない（製品の narrative 抽出は thinkingParams 無し）。
 *   - max_tokens は thinking を切れない世代（claude の major >= 5）で 32,000、それ以外 4,096。
 */

export interface PayloadMessage {
  readonly role: string;
  readonly content: string;
}

export interface AnthropicBody {
  model: string;
  max_tokens: number;
  messages: { role: string; content: string }[];
  system?:
    | string
    | { type: "text"; text: string; cache_control: { type: "ephemeral" } }[];
}

/** `anthropic_model_thinking_always_on` の再現。 */
export function thinkingAlwaysOn(model: string): boolean {
  const m = model.split("/").pop() ?? model;
  if (!m.startsWith("claude-")) return false;
  const rest = m.slice("claude-".length);
  if (rest.startsWith("fable-") || rest.startsWith("mythos-")) return true;
  for (const family of ["opus-", "sonnet-", "haiku-"]) {
    if (rest.startsWith(family)) {
      const match = /^\d+/u.exec(rest.slice(family.length));
      return match !== null && Number(match[0]) >= 5;
    }
  }
  return false;
}

export function defaultMaxTokens(model: string): number {
  return thinkingAlwaysOn(model) ? 32_000 : 4096;
}

function buildSystemPayload(
  fallback: string,
  segments: readonly string[] | undefined,
): AnthropicBody["system"] {
  if (segments !== undefined) {
    const blocks = segments
      .filter((text) => text.length > 0)
      .map((text) => ({
        type: "text" as const,
        text,
        cache_control: { type: "ephemeral" as const },
      }));
    if (blocks.length > 0) return blocks;
    const joined = segments.join("\n");
    if (joined.length > 0) return joined;
  }
  return fallback;
}

export function buildAnthropicBody(input: {
  readonly model: string;
  readonly messages: readonly PayloadMessage[];
  readonly systemCacheSegments?: readonly string[];
  readonly maxTokens?: number;
}): AnthropicBody {
  const systemContent = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const chatMessages = input.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));
  const body: AnthropicBody = {
    model: input.model,
    max_tokens: input.maxTokens ?? defaultMaxTokens(input.model),
    messages: chatMessages,
  };
  if (systemContent.length > 0 || input.systemCacheSegments !== undefined) {
    body.system = buildSystemPayload(systemContent, input.systemCacheSegments);
  }
  return body;
}

export function buildAnthropicHeaders(input: {
  readonly apiKey: string;
  readonly systemCacheSegments?: readonly string[];
}): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": input.apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (input.systemCacheSegments?.some((segment) => segment.length > 0)) {
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  }
  return headers;
}

export interface AnthropicUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ParsedAnthropicResponse {
  /** text block を "\n" で連結（製品の `sendChatMessageWithThinking` と同じ。thinking は含めない）。 */
  readonly text: string;
  readonly stopReason: string | null;
  readonly usage: AnthropicUsage;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseAnthropicResponse(json: unknown): ParsedAnthropicResponse {
  if (json === null || typeof json !== "object") {
    throw new TypeError("Anthropic response must be an object");
  }
  const record = json as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  return {
    text,
    stopReason:
      typeof record.stop_reason === "string" ? record.stop_reason : null,
    usage: {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheWriteTokens: count(usage.cache_creation_input_tokens),
    },
  };
}

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export interface SendAnthropicResult extends ParsedAnthropicResponse {
  readonly attempts: number;
  readonly elapsedMs: number;
}

/**
 * Messages API へ非 streaming で送る（製品の single-shot と同じ）。429／5xx／529 と
 * 通信エラーは最大 `maxAttempts` 回まで backoff して再送する。key は header にだけ載せ、
 * 例外の文面にも入れない（HTTP エラーは status と error.type だけ）。
 */
export async function sendAnthropicMessages(input: {
  readonly apiKey: string;
  readonly body: AnthropicBody;
  readonly systemCacheSegments?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<SendAnthropicResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const maxAttempts = input.maxAttempts ?? 4;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let lastError = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await doFetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: buildAnthropicHeaders({
          apiKey: input.apiKey,
          systemCacheSegments: input.systemCacheSegments,
        }),
        body: JSON.stringify(input.body),
        signal: input.signal,
      });
      if (response.ok) {
        const parsed = parseAnthropicResponse(await response.json());
        return {
          ...parsed,
          attempts: attempt,
          elapsedMs: Date.now() - started,
        };
      }
      let errorType = "unknown";
      try {
        const errorJson = (await response.json()) as {
          error?: { type?: unknown };
        };
        if (typeof errorJson.error?.type === "string")
          errorType = errorJson.error.type;
      } catch {
        // 本文が JSON でなくても status だけ残す。
      }
      lastError = `http ${response.status} ${errorType}`;
      const retryable =
        response.status === 429 ||
        response.status === 529 ||
        response.status >= 500;
      if (!retryable) break;
    } catch (error) {
      lastError = `transport ${(error as { name?: string })?.name ?? "error"}`;
      if ((error as { name?: string })?.name === "AbortError") break;
    }
    if (attempt < maxAttempts) await sleep(2000 * 2 ** (attempt - 1));
  }
  throw new Error(`Anthropic request failed: ${lastError}`);
}
