// LAST_UPDATED: 2026-05-11
/**
 * 主要 AI モデルの推定料金テーブル（USD / 1M tokens）。
 *
 * 用途: chat の context token 数から「このメッセージを送るとおよそいくら掛かるか」を
 * 見える化するため。ユーザーが eco モードと通常モードを比較する判断材料にする。
 *
 * # 仕様
 * - **input** / **output** それぞれ 100 万トークン単価 (USD) を保持。
 * - OpenRouter prefix (`anthropic/claude-...`) と bare ID の両方に対応 (`normalizeModelId`)。
 * - 価格は手作業で同期。確証の無いモデルはテーブルに入れず null を返す
 *   (UI では token 数のみ表示にフォールバック)。
 * - 将来的には OpenRouter API からの動的取得に置き換えたい
 *   (memo: project_dynamic_model_caps.md)。
 *
 * # 対象スコープ
 * 公式公開価格で確証が取れる主要モデルだけ。Claude 4.x は出荷時点で 3-Opus と
 * 同じティア構造 ($15/$75 Opus、$3/$15 Sonnet) を踏襲しているため Sonnet 帯まで
 * 採用。Haiku 4.x、xAI、Gemini 2.5、o1/o3、gpt-4.5 系は変動 / 確証不足のため
 * 意図的に未収録。
 */

export interface ModelPricing {
  /** USD per 1,000,000 input tokens */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens */
  outputPerMillion: number;
}

/**
 * "正規化済みキー" → 料金 のテーブル。
 * キーは小文字、provider prefix なしのモデル名。
 */
const PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude 4.x — 出荷時点で 3-Opus と同じ tier 構造
  "claude-opus-4-7": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-opus-4-6": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-opus-4-5": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-5": { inputPerMillion: 3, outputPerMillion: 15 },
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
 */
export function getModelPricing(
  modelId: string | null | undefined,
): ModelPricing | null {
  if (!modelId) return null;
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
): number | null {
  const p = getModelPricing(modelId);
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
): number | null {
  const p = getModelPricing(modelId);
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
