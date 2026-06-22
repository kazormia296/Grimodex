/**
 * AI のべりすと専用の定数・モデル能力定義。
 *
 * レガシー `/api` (独自フォーマット) + v1 `/v1` (OpenAI 互換) ハイブリッド。
 */

import type { ModelCapabilities } from "./agent/modelLimits";

/** レガシー Text / Messages API */
export const AINOVERIST_BASE_URL = "https://api.tringpt.com/api";

/** OpenAI 互換 v1 エンドポイント */
export const AINOVERIST_V1_BASE_URL = "https://api.tringpt.com/v1";

/** v1 取得失敗時の静的 fallback */
export const AINOVERIST_V1_KNOWN_MODELS = ["spiko_ultra"] as const;

/**
 * レガシー モデル別の能力情報 (contextWindow / maxOutputTokens)。
 * Rust 側 legacy caps と一致させること。
 */
export const AINOVERIST_MODEL_CAPS: Record<
  string,
  Pick<ModelCapabilities, "contextWindow" | "maxOutputTokens">
> = {
  derrida_03: { contextWindow: 40_000, maxOutputTokens: 4_096 },
  spiko: { contextWindow: 40_000, maxOutputTokens: 4_096 },
  spiko_solid: { contextWindow: 40_000, maxOutputTokens: 4_096 },
  spiko_max: { contextWindow: 40_000, maxOutputTokens: 4_096 },
  damsel_ray: { contextWindow: 12_288, maxOutputTokens: 400 },
  supertrin_highpres: { contextWindow: 9_216, maxOutputTokens: 400 },
  supertrin_maxpres: { contextWindow: 9_216, maxOutputTokens: 400 },
  supertrin: { contextWindow: 9_216, maxOutputTokens: 400 },
  damsel: { contextWindow: 2_400, maxOutputTokens: 400 },
};

/** v1 既知モデルの能力情報 */
export const AINOVERIST_V1_MODEL_CAPS: Record<
  string,
  Pick<ModelCapabilities, "contextWindow" | "maxOutputTokens">
> = {
  spiko_ultra: { contextWindow: 200_000, maxOutputTokens: 32_768 },
};

/** v1 未知モデルの保守的デフォルト */
export const AINOVERIST_V1_DEFAULT_CAPS = {
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
} as const;

/** KoboldAI 系独自サンプリングキー (legacy のみ) */
export const AINOVERIST_EXTRA_SAMPLING_KEYS = [
  "top_a",
  "tailfree",
  "typical_p",
  "min_p",
  "rep_pen",
  "badwords",
  "stoptokens",
  "logit_bias",
] as const;

export type AinoveristSamplingKey =
  (typeof AINOVERIST_EXTRA_SAMPLING_KEYS)[number];

export type AinoveristApiVariant = "legacy" | "v1";

export function isAinoveristV1Model(
  model: string,
  apiVariant?: AinoveristApiVariant | string | null,
): boolean {
  if (apiVariant === "v1") return true;
  if (apiVariant === "legacy") return false;
  return (AINOVERIST_V1_KNOWN_MODELS as readonly string[]).includes(model);
}

export function resolveAinoveristApiVariant(
  model: string,
  models: Array<{ id: string; apiVariant?: string }>,
  persisted?: string | null,
): AinoveristApiVariant | undefined {
  const fromList = models.find((m) => m.id === model)?.apiVariant;
  if (fromList === "v1" || fromList === "legacy") return fromList;
  if (persisted === "v1" || persisted === "legacy") return persisted;
  if (isAinoveristV1Model(model)) return "v1";
  if (model) return "legacy";
  return undefined;
}

/**
 * Responses API (`/responses`) を叩けるプロバイダか。
 *
 * `/responses` を公開しているのは OpenAI 直叩き / OpenAI 互換 gateway (Azure OpenAI /
 * LiteLLM 等) / OpenRouter (beta `/api/v1/responses`)。Responses トグルの表示・
 * 経路解決・provider 切替時のクリア判定はすべてこの述語に集約する(条件のドリフト防止)。
 */
export function isResponsesApiCapableProvider(
  provider: string | undefined,
): boolean {
  return (
    provider === "openai" ||
    provider === "openai-compatible" ||
    provider === "openrouter"
  );
}

/**
 * 送信/永続化に使う API 経路 (variant) をプロバイダ込みで解決する。
 *
 * Responses 対応プロバイダ (isResponsesApiCapableProvider) で Responses トグル
 * (modelApiVariant == "responses") が有効なら最優先で "responses" を返す。それ以外は
 * AI のべりすと用の `resolveAinoveristApiVariant`（legacy/v1 のみ・任意モデルに "legacy"
 * を返す）へ委譲する。
 *
 * `resolveAinoveristApiVariant` は "responses" を一切扱わず legacy に潰すため、送信時
 * (getChatApiVariant) やモデル切替時の永続化 (handleSelectModel / handleModelChange) で
 * 直接呼ぶと Responses 設定が消える。経路解決はすべてこの関数に通すこと。
 */
export function resolveModelApiVariant(
  provider: string | undefined,
  model: string,
  models: Array<{ id: string; apiVariant?: string }>,
  persisted?: string | null,
): "legacy" | "v1" | "responses" | undefined {
  if (isResponsesApiCapableProvider(provider) && persisted === "responses") {
    return "responses";
  }
  return resolveAinoveristApiVariant(model, models, persisted);
}
