/**
 * adapter の方針（Mastra 移行 MP-2）：対象 provider、usage の会計、stopReason の写像、再試行しない固定、error。
 *
 * - 対象は Anthropic・OpenAI・OpenRouter の 3 つ（U-6）。それ以外は明示のエラーで、
 *   turn 単位で legacy に落とす判断は呼び手（MP-3 の owner）が持つ。
 * - 再試行しない（GDX-POLICY-001：副作用を盲目的に再試行しない）。
 */
import type { AgentWireResponse } from "./agentWire.js";

// ---- 再試行なしの固定 ------------------------------------------------------

/**
 * `new Agent({...})` に展開する。Mastra 1.83.0 の実測（`agentLanguageModel.test.ts`）：
 * - 再送は既定の error processors（`StreamErrorRetryProcessor` ほか）が行う。`isRetryable:true` の error（`APICallError`）を
 *   model が投げると、既定の設定では 3 回呼ぶ（generate／stream とも。待ち時間は約 6 秒）。
 * - `maxRetries: 0`（Agent の既定でもある）だけでは止まらない。`errorProcessorDefaults: false` で 1 回になる。
 * - `maxProcessorRetries: 0` も併せて固定する（processor 経由の再送の上限）。
 * - 既定の `StreamErrorRetryProcessor` は、error の message が /econnreset|socket hang up/i に当たると
 *   `isRetryable:false` でも再送する（実測：設定なしで send 3 回）。
 * adapter が投げる error（`AgentModelError`）は `isRetryable:false` で、message は kind だけの固定の文
 * （元の error の文は `origin` にだけ持つ）なので、設定なしでも再送されない（二重の固定）。
 */
export const AGENT_NO_RETRY_CONFIG = Object.freeze({
  maxRetries: 0,
  maxProcessorRetries: 0,
  errorProcessorDefaults: false,
} as const);

/** `agent.generate(..., options)`／`agent.stream(..., options)` に展開する。tool は tool_use の順に逐次実行（S6 #15）。 */
export const AGENT_CALL_OPTIONS = Object.freeze({
  toolCallConcurrency: 1,
  // call 時の maxProcessorRetries は agent の値を上書きする（実測）。ここでも 0 に固定する。
  maxProcessorRetries: 0,
} as const);

// ---- error ---------------------------------------------------------------

const AI_SDK_ERROR_MARKER = Symbol.for("vercel.ai.error");
const AI_SDK_API_CALL_ERROR_MARKER = Symbol.for(
  "vercel.ai.error.AI_APICallError",
);

/**
 * adapter が投げる error。Mastra の `isRetryableModelError` は、`APICallError`（marker で判定）なら
 * `isRetryable` を読み、それ以外の error は再試行可能とみなす。marker を付けて `isRetryable:false` を明示する
 * （`ai` の実行時 import を main に持ち込まない。marker は `@ai-sdk/provider` の `AISDKError` と同じ）。
 */
export class AgentModelError extends Error {
  readonly isRetryable = false;
  readonly statusCode = undefined;
  readonly url = "grimodex://send_agent_message";
  readonly requestBodyValues: unknown = undefined;
  readonly kind: AgentModelErrorKind;
  /**
   * 元の error。標準の `cause` には載せない：Mastra は `cause` の連鎖を辿って `isRetryable` を読み、
   * 元の error が `APICallError(isRetryable:true)` だと、こちらが false でも既定の設定で再送される（実測）。
   */
  readonly origin: unknown;
  readonly [AI_SDK_ERROR_MARKER] = true;
  readonly [AI_SDK_API_CALL_ERROR_MARKER] = true;

  constructor(kind: AgentModelErrorKind, message: string, origin?: unknown) {
    super(message);
    this.name = "AgentModelError";
    this.kind = kind;
    this.origin = origin;
  }
}

/**
 * `AgentModelError` かどうか。class の同一性ではなく形で見る：adapter は 3 つ目の bundle（mastra-agent.cjs）で
 * 動き、audit の sink は main.cjs にあるので、同じ source の class が 2 つの copy になり `instanceof` が false になる
 * （origin と kind が audit から落ちる）。名前と `kind`・`origin` の欄で見る。
 */
export function isAgentModelError(value: unknown): value is AgentModelError {
  if (value instanceof AgentModelError) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    name?: unknown;
    kind?: unknown;
    isRetryable?: unknown;
  };
  return (
    candidate.name === "AgentModelError" &&
    typeof candidate.kind === "string" &&
    candidate.isRetryable === false &&
    "origin" in value
  );
}

export type AgentModelErrorKind =
  | "unsupported-provider"
  | "unsupported-request"
  | "invalid-options"
  | "invalid-prompt"
  | "invalid-response"
  | "send-failed"
  | "audit-failed";

// ---- provider ------------------------------------------------------------

export const AGENT_SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
] as const;
export type AgentSupportedProvider = (typeof AGENT_SUPPORTED_PROVIDERS)[number];

export function isSupportedAgentProvider(
  provider: unknown,
): provider is AgentSupportedProvider {
  return AGENT_SUPPORTED_PROVIDERS.some((name) => name === provider);
}

/** 対象外（ollama、openai-compatible、sakana、ai-novelist、cli、未解決の null）なら投げる。送信・audit の前に呼ぶ。 */
export function assertSupportedAgentProvider(
  provider: unknown,
): AgentSupportedProvider {
  if (isSupportedAgentProvider(provider)) return provider;
  throw new AgentModelError(
    "unsupported-provider",
    `Mastra agent adapter does not support provider ${JSON.stringify(provider)}; supported: ${AGENT_SUPPORTED_PROVIDERS.join(", ")}`,
  );
}

// ---- usage ---------------------------------------------------------------

export interface AgentV4Usage {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
}

const nonNegative = (value: number | null | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/**
 * wire の usage → V4 の usage。provider の会計の違いは route の provider で分ける
 * （adapter が名乗る provider 名は中立なので使えない）。正規化の正本は renderer の
 * `normalizeActualInputTokens`（`src/features/ai-usage/inputTokenDrift.ts`）と同じ規則：
 *
 * - Anthropic：`input_tokens` は cache を含まない。total ＝ input ＋ cacheRead ＋ cacheWrite。
 * - OpenAI（Chat Completions／Responses）・OpenRouter：`prompt_tokens` は cache 読込を含む。total ＝ input。
 *   Responses は cacheWrite が常に無い。`noCache` は input から read だけを引く（OpenRouter の `cache_write_tokens` が
 *   `prompt_tokens` に含まれるかは未確認。Rust の試験データは含む形だが、実機では確かめていない）。台帳・audit は生の値を使う。
 */
export function wireToAgentUsage(
  provider: AgentSupportedProvider,
  response: Pick<
    AgentWireResponse,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
): AgentV4Usage {
  const input = nonNegative(response.inputTokens);
  const read = nonNegative(response.cacheReadTokens);
  const write = nonNegative(response.cacheWriteTokens);
  const output = nonNegative(response.outputTokens);
  let total: number | undefined;
  let noCache: number | undefined;
  if (input !== undefined) {
    if (provider === "anthropic") {
      total = input + (read ?? 0) + (write ?? 0);
      noCache = input;
    } else {
      total = input;
      noCache = Math.max(0, input - (read ?? 0));
    }
  }
  return {
    inputTokens: { total, noCache, cacheRead: read, cacheWrite: write },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

// ---- stopReason ----------------------------------------------------------

export type AgentV4UnifiedFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other";

/**
 * wire の stopReason → V4 の finishReason。raw は wire の値のまま保持する。
 * - tool_use → tool-calls、end_turn／stop_sequence → stop、max_tokens／length／model_context_window_exceeded → length、
 *   refusal → content-filter、既定は other（pause_turn ほか）。
 */
export function wireStopReasonToFinishReason(stopReason: string): {
  unified: AgentV4UnifiedFinishReason;
  raw: string;
} {
  switch (stopReason) {
    case "tool_use":
      return { unified: "tool-calls", raw: stopReason };
    case "end_turn":
    case "stop_sequence":
    case "stop":
      return { unified: "stop", raw: stopReason };
    case "max_tokens":
    case "length":
    case "model_context_window_exceeded":
      return { unified: "length", raw: stopReason };
    case "refusal":
      return { unified: "content-filter", raw: stopReason };
    default:
      return { unified: "other", raw: stopReason };
  }
}
