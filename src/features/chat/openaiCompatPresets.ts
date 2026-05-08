/**
 * OpenAI 互換プロバイダのプリセットレジストリ。
 *
 * プリセットは「設定値の hydrator」として動き、UI 表示と Rust 側のリクエスト
 * ビルダーが同じ宣言を参照する。プロトコル自体は OpenAI 互換そのもの (Vercel AI
 * SDK `openai` の `baseURL` 上書き) だが、プロバイダごとに固有の固定 URL・モデル
 * 一覧・サンプリングパラメータ・レート制限をプリセットとして表現する。
 */

import type { AiModel } from "./types";
import {
  registerAinoveristCaps,
  type ModelCapabilities,
} from "./agent/modelLimits";

export interface OpenaiCompatPresetRateLimit {
  /** デフォルトのリクエスト/分上限 */
  requestsPerMinute: number;
  /** モデル別の上書き (Phase A.2 で AI のべりすと damsel に使用) */
  perModelOverride?: Record<string, number>;
}

export interface OpenaiCompatPreset {
  id: "custom" | "ainoverist";
  /** UI に表示するプリセット名 */
  displayName: string;
  /**
   * 固定 baseURL。null の場合はユーザーが Settings で入力する (custom プリセット)。
   * URL 末尾の "/" は使用時に trim される。
   */
  baseUrl: string | null;
  /**
   * ハードコードのモデル一覧。custom は空（ユーザーが API から取得 or 自由入力）。
   */
  models: AiModel[];
  /**
   * モデル能力のオーバーライド。プリセット側で固定したい能力フラグを指定する
   * (例: AI のべりすとは拡張思考非対応 → supportsThinking=false 等)。
   */
  capabilitiesOverride: Partial<ModelCapabilities>;
  /** レート制限。設定があるプリセットでのみ 429 リトライロジックを有効化 */
  rateLimit?: OpenaiCompatPresetRateLimit;
  /**
   * リクエストボディに素通しするサンプリングキー。OpenAI には存在しない
   * KoboldAI 系パラメータ (top_a / tailfree 等) を AI のべりすとで使用する想定。
   */
  extraSamplingKeys: readonly string[];
  /**
   * AI Codex 自動抽出 / Synopsis 自動生成 / セッションタイトル自動生成を
   * デフォルトで無効化するか。構造化出力の信頼性が低いプロバイダで true にする。
   */
  defaultDisableStructuredTasks: boolean;
  /** UI に表示する案内文 (API キー取得方法 URL 等)。null 可。 */
  helperText?: string;
}

const CUSTOM_PRESET: OpenaiCompatPreset = {
  id: "custom",
  displayName: "カスタム (任意の OpenAI 互換エンドポイント)",
  baseUrl: null,
  models: [],
  capabilitiesOverride: {
    // ローカル LLM では拡張思考の信頼性が低いため OFF 固定
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
  },
  extraSamplingKeys: [],
  defaultDisableStructuredTasks: true,
  helperText:
    "llama.cpp / LM Studio / vLLM / 自前ホストの GPU 推論サーバ等。baseURL を入力してください。API キーが不要なサーバの場合は空欄で構いません。",
};

/**
 * AI のべりすとプリセット。
 * 日本語小説特化のプロバイダ。OpenAI 互換チャット API を提供する。
 *
 * - 固定 baseURL: https://api.tringpt.com/api
 * - モデル別の入力/出力上限が大きく異なる（現行主力 40k/4k vs damsel 2.4k/400）
 * - 独自サンプリングパラメータ（KoboldAI 系）をリクエストボディに素通し
 * - 拡張思考非対応・構造化出力タスクはデフォルト無効化
 * - レート制限: 200 req/分（damsel のみ 90 req/分）
 */
const AINOVERIST_PRESET: OpenaiCompatPreset = {
  id: "ainoverist",
  displayName: "AI のべりすと",
  baseUrl: "https://api.tringpt.com/api",
  models: [
    // 現行主力 (40k 入力 / 4k 出力)
    { id: "derrida_03", name: "derrida_03" },
    { id: "spiko", name: "spiko" },
    { id: "spiko_solid", name: "spiko_solid" },
    { id: "spiko_max", name: "spiko_max" },
    // 現行 (出力小)
    { id: "damsel_ray", name: "damsel_ray" },
    // レガシー (9k / 400)
    { id: "supertrin_highpres", name: "supertrin_highpres" },
    { id: "supertrin_maxpres", name: "supertrin_maxpres" },
    { id: "supertrin", name: "supertrin (legacy)" },
    // レガシー最古 (2.4k / 400)
    { id: "damsel", name: "damsel (legacy)" },
  ],
  capabilitiesOverride: {
    supportsTools: false,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  rateLimit: {
    requestsPerMinute: 200,
    perModelOverride: { damsel: 90 },
  },
  extraSamplingKeys: [
    "top_a",
    "tailfree",
    "typical_p",
    "min_p",
    "rep_pen",
    "badwords",
    "stoptokens",
    "logit_bias",
  ],
  defaultDisableStructuredTasks: true,
  helperText:
    "日本語小説特化のプロバイダ。API キーは https://ai-novel.com/account_api.php で発行できます。",
};

/** ainoverist プリセットのモデル別 capabilities マッピング */
export const AINOVERIST_MODEL_CAPS: Record<
  string,
  Pick<ModelCapabilities, "contextWindow" | "maxOutputTokens">
> = {
  // 現行主力 (40k / 4k)
  derrida_03: { contextWindow: 40_000, maxOutputTokens: 4_096 },
  spiko: { contextWindow: 40_000, maxOutputTokens: 4_096 },
  spiko_solid: { contextWindow: 40_000, maxOutputTokens: 4_096 },
  spiko_max: { contextWindow: 40_000, maxOutputTokens: 4_096 },
  // damsel_ray (12k / 400)
  damsel_ray: { contextWindow: 12_288, maxOutputTokens: 400 },
  // レガシー supertrin 系 (9k / 400)
  supertrin_highpres: { contextWindow: 9_216, maxOutputTokens: 400 },
  supertrin_maxpres: { contextWindow: 9_216, maxOutputTokens: 400 },
  supertrin: { contextWindow: 9_216, maxOutputTokens: 400 },
  // damsel (2.4k / 400) — 縮退モード対象
  damsel: { contextWindow: 2_400, maxOutputTokens: 400 },
};

const PRESETS: readonly OpenaiCompatPreset[] = [
  CUSTOM_PRESET,
  AINOVERIST_PRESET,
];

/** プリセット一覧を返す (UI のドロップダウン構築用) */
export function listOpenaiCompatPresets(): readonly OpenaiCompatPreset[] {
  return PRESETS;
}

/** プリセット ID から定義を取得。未知の ID は custom にフォールバック */
export function getOpenaiCompatPreset(
  id: string | undefined,
): OpenaiCompatPreset {
  return PRESETS.find((p) => p.id === id) ?? CUSTOM_PRESET;
}

// 循環 import 回避: modelLimits 側に ainoverist のモデル能力テーブルを登録する。
// `resolveModelCapabilities` が ainoverist プリセットで参照する。
registerAinoveristCaps(AINOVERIST_MODEL_CAPS);
