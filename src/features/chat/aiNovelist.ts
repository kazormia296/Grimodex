/**
 * AI のべりすと専用の定数・モデル能力定義。
 *
 * API エンドポイント: https://api.tringpt.com/api (POST のみ)
 * OpenAI 互換エンドポイントは存在しない。
 */

import type { AiModel } from "./types";
import type { ModelCapabilities } from "./agent/modelLimits";

export const AINOVERIST_BASE_URL = "https://api.tringpt.com/api";

/** UI に表示するモデル一覧 (Rust 側静的リストと一致させること) */
export const AINOVERIST_MODELS: AiModel[] = [
  { id: "derrida_03", name: "derrida_03" },
  { id: "spiko", name: "spiko" },
  { id: "spiko_solid", name: "spiko_solid" },
  { id: "spiko_max", name: "spiko_max" },
  { id: "damsel_ray", name: "damsel_ray" },
  { id: "supertrin_highpres", name: "supertrin_highpres" },
  { id: "supertrin_maxpres", name: "supertrin_maxpres" },
  { id: "supertrin", name: "supertrin (legacy)" },
  { id: "damsel", name: "damsel (legacy)" },
];

/**
 * モデル別の能力情報 (contextWindow / maxOutputTokens)。
 * Rust 側 `ai_novelist::MAX_OUTPUT_TOKENS` と一致させること。
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

/** KoboldAI 系独自サンプリングキー */
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
