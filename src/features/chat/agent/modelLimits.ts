/** 既知モデルのコンテキストウィンドウ上限（トークン数） */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  // OpenRouter 経由の一般モデル名 (プレフィックス付き)
  "openai/gpt-4o": 128_000,
  "anthropic/claude-opus-4-6": 1_000_000,
  "anthropic/claude-sonnet-4-6": 200_000,
  "anthropic/claude-haiku-4-5-20251001": 200_000,
};

/** ツール結果のトークン予算 = コンテキスト上限の30%（最低2,000） */
export function getToolTokenBudget(model: string): number {
  const limit = MODEL_CONTEXT_LIMITS[model] ?? 8_000;
  return Math.max(2_000, Math.floor(limit * 0.3));
}

/** Tool Use 対応モデルの判定 */
const TOOL_UNSUPPORTED_PATTERNS = [/^ollama\//i];

// OpenRouter経由の一部小型モデル名（追加が必要な場合は拡張）
const TOOL_UNSUPPORTED_MODELS = new Set([
  "ollama/llama2",
  "ollama/mistral",
  "ollama/phi",
]);

export function modelSupportsTools(model: string): boolean {
  if (TOOL_UNSUPPORTED_MODELS.has(model)) return false;
  for (const pattern of TOOL_UNSUPPORTED_PATTERNS) {
    if (pattern.test(model)) return false;
  }
  return true;
}
