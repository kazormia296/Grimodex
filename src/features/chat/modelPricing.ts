import { getDynamicModelMeta } from "./agent/dynamicModelCaps";

// LAST_UPDATED: 2026-06-10
/**
 * 主要 AI モデルの推定料金テーブル（USD / 1M tokens）。
 *
 * 用途: chat の context token 数から「このメッセージを送るとおよそいくら掛かるか」を
 * 見える化するため。ユーザーが eco モードと通常モードを比較する判断材料にする。
 *
 * # 仕様
 * - **input** / **output** それぞれ 100 万トークン単価 (USD) を保持。
 * - OpenRouter prefix (`anthropic/claude-...`) と bare ID の両方に対応 (`normalizeModelId`)。
 * - getModelPricing は OpenRouter 動的レジストリ（dynamicModelCaps）を優先照会し、
 *   未登録時のみ手動テーブルにフォールバックする。
 *
 * # 手動テーブルの対象スコープ
 * Anthropic 直叩き等、動的データが得られないプロバイダ向けの静的 fallback。
 * 確証の無いモデルはテーブルに入れず null を返す（UI では token 数のみ表示）。
 */

export interface ModelPricing {
  /** USD per 1,000,000 input tokens */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens */
  outputPerMillion: number;
}

/**
 * 手動同期の静的 fallback テーブル。
 * OpenRouter 動的レジストリにヒットしない場合のみ参照する。
 * キーは小文字、provider prefix なし。
 */
const PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude 4.x (Anthropic 直叩き用 fallback)
  "claude-fable-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
  // Claude 3.x 系
  "claude-3-5-sonnet": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-5-haiku": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "claude-3-opus": { inputPerMillion: 15, outputPerMillion: 75 },

  // OpenAI GPT-4o family
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },

  // Google Gemini 2.0 Flash
  "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
};

/**
 * モデル ID を正規化キーに変換する。
 * - OpenRouter prefix (`anthropic/claude-...`) → スラッシュ後ろを採用
 * - `:beta` `:online` 等のチャンネルサフィックスを除去
 * - 小文字化
 * - `.` を `-` に置換 (OpenRouter は `claude-sonnet-4.6`、bare は `claude-sonnet-4-6`)
 * - 末尾の日付サフィックス `-YYYYMMDD` を除去 (Anthropic 直叩きの dated id)
 * - 末尾の `-latest` を除去
 */
function normalizeModelId(id: string): string {
  let s = id.toLowerCase();
  const slash = s.indexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  const colon = s.indexOf(":");
  if (colon >= 0) s = s.slice(0, colon);
  s = s.replace(/\./g, "-");
  s = s.replace(/-\d{8}$/, "");
  s = s.replace(/-latest$/, "");
  return s;
}

/**
 * モデル ID から料金を引く。未登録モデルは null。
 * OpenRouter 動的レジストリ（inPerM/outPerM）→ 手動テーブル の順で解決する。
 */
export function getModelPricing(
  modelId: string | null | undefined,
  provider?: string | null,
): ModelPricing | null {
  if (!modelId) return null;

  // provider 未指定は既存 API 互換のため従来どおり OpenRouter を参照する。
  // provider が明示された場合は OpenRouter の名前空間だけを対象にし、
  // 同じ bare model id を持つ Ollama 等へクラウド料金を漏らさない。
  const dyn =
    provider == null || provider === "openrouter"
      ? getDynamicModelMeta("openrouter", modelId)
      : null;
  if (dyn?.inPerM != null && dyn.outPerM != null) {
    return { inputPerMillion: dyn.inPerM, outputPerMillion: dyn.outPerM };
  }

  if (
    provider != null &&
    !["openrouter", "openai", "anthropic", "sakana"].includes(provider)
  ) {
    // Local/custom providers can use a cloud-looking bare id. Do not assign
    // cloud catalog pricing unless the provider namespace is actually known.
    return null;
  }

  const key = normalizeModelId(modelId);
  return PRICING[key] ?? null;
}

/**
 * input トークン数からコストを推定する (USD)。
 * output コストは送信前には未知なので含めない。
 */
export function estimateInputCost(
  modelId: string | null | undefined,
  tokens: number,
  provider?: string | null,
): number | null {
  const p = getModelPricing(modelId, provider);
  if (!p) return null;
  return (tokens / 1_000_000) * p.inputPerMillion;
}

/**
 * input + output トークン数から合計コストを推定する (USD)。
 * ai_usage 台帳の行から表示コストを出すのに使う。プロバイダが cost を
 * 返さない (Anthropic 直叩き等) 行のフォールバック。未登録モデルは null。
 */
export function estimateTotalCost(
  modelId: string | null | undefined,
  tokensIn: number,
  tokensOut: number,
  provider?: string | null,
): number | null {
  const p = getModelPricing(modelId, provider);
  if (!p) return null;
  return (
    (tokensIn / 1_000_000) * p.inputPerMillion +
    (tokensOut / 1_000_000) * p.outputPerMillion
  );
}

/**
 * USD 額を人間に読みやすい形式に整形する。
 * - $0.01 未満は "<$0.01"
 * - $1 未満は "$0.68" (小数点 2 桁)
 * - $1 以上は "$3.40" (小数点 2 桁)
 * - $10 以上は "$15" (整数)
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}
