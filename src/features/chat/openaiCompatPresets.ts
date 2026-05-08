/**
 * OpenAI 互換プロバイダのプリセットレジストリ。
 *
 * プリセットは「設定値の hydrator」として動き、UI 表示と Rust 側のリクエスト
 * ビルダーが同じ宣言を参照する。プロトコル自体は OpenAI 互換そのもの (Vercel AI
 * SDK `openai` の `baseURL` 上書き) だが、プロバイダごとに固有の固定 URL・モデル
 * 一覧・サンプリングパラメータ・レート制限をプリセットとして表現する。
 *
 * Phase A.1 では "custom" のみ。Phase A.2 で "ainoverist" を追加予定。
 */

import type { AiModel } from "./types";
import type { ModelCapabilities } from "./agent/modelLimits";

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

const PRESETS: readonly OpenaiCompatPreset[] = [CUSTOM_PRESET];

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
