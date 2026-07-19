import type { AbConfig } from "./abHarness";
import { AI_PROVIDERS, type AiProvider } from "@/features/chat/types";
import { BROWSER_DIRECT_AI_PROVIDERS } from "@/features/chat/browserProviderPolicy";
import { overrideApiVariantForProvider } from "@/features/chat/aiNovelist";

/**
 * A/B 枠で選べるプロバイダ。`cli` は送信経路 (send_chat_message → ai::send_chat) を
 * 通らない subprocess プロバイダなので A/B 比較では除外する。
 */
export const AB_PROVIDERS: AiProvider[] = AI_PROVIDERS.filter(
  (p) => p !== "cli",
);

export function providersForRuntime(
  browserDirectAi: boolean,
): readonly AiProvider[] {
  return browserDirectAi ? BROWSER_DIRECT_AI_PROVIDERS : AB_PROVIDERS;
}

/** A/B 枠の provider 選択ラベル (Settings の表示と揃える)。 */
export const AB_PROVIDER_LABELS: Record<AiProvider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "ollama-local",
  "openai-compatible": "OpenAI-compatible",
  sakana: "Sakana (fugu)",
  "ai-novelist": "AI のべりすと",
  cli: "CLI agent",
};

/**
 * A/B 比較の 1 枠 (スロット)。ダイアログが状態として保持する単位。
 * - `baseline` (1 枠目): 常に「現在の既定」(config={})。固定表示・編集不可・再生成は使い回し。
 * - それ以外 (変種枠): provider / model / promptVariant を自由に上書きできる。
 */
export interface AbSlot {
  /** React key / 結果対応 / 採用判定に使う安定 id。基準枠は固定 "baseline"。 */
  id: string;
  /** この枠の構成。基準枠は常に {}。 */
  config: AbConfig;
  /** 基準枠 (1 枠目・既定固定) か。 */
  baseline: boolean;
}

/** 基準枠 (常に既定構成・固定 id)。 */
export function createBaselineSlot(): AbSlot {
  return { id: "baseline", config: {}, baseline: true };
}

/** 変種枠を生成する。初期構成は任意 (既定値の流し込みに使う)。 */
export function createVariantSlot(config: AbConfig = {}): AbSlot {
  return { id: crypto.randomUUID(), config, baseline: false };
}

/**
 * 枠の構成を送信用に正規化する。空白のみのフィールドは undefined に畳む。
 * `allowProvider=false` (inline) では provider を常に落とす。
 */
export function normalizeAbConfig(
  config: AbConfig,
  allowProvider: boolean,
): AbConfig {
  const out: AbConfig = {};
  const provider = config.provider?.trim();
  const model = config.model?.trim();
  if (model) out.model = model;
  // provider は model とセットでのみ送る (provider 単独だと別プロバイダへ既定モデル名が
  // 漏れて誤動作する = isSlotComplete の不変条件)。model 無しの provider は落とす。
  if (allowProvider && provider && model) out.provider = provider;
  // endpointId は OpenAI 互換 provider を実際に上書きする枠でのみ運ぶ。provider が
  // 落ちた / 互換以外 / inline (allowProvider=false) の枠では stale な endpoint を残さない。
  const endpointId = config.endpointId?.trim();
  if (out.provider === "openai-compatible" && endpointId) {
    out.endpointId = endpointId;
  }
  const promptVariant = config.promptVariant?.trim();
  if (promptVariant) out.promptVariant = promptVariant;
  return out;
}

/**
 * この枠が基準 (既定) と実際に差分を持つか。provider / model / promptVariant の
 * いずれかが指定されていれば差分あり。
 */
export function slotDiffersFromBaseline(config: AbConfig): boolean {
  return !!(
    config.provider?.trim() ||
    config.model?.trim() ||
    config.promptVariant?.trim()
  );
}

/**
 * 比較を走らせる意味があるか (基準と異なる変種枠が 1 つ以上あるか)。
 * 全枠が既定と同じなら同一応答の無駄打ちになるため弾く。
 */
export function isComparisonMeaningful(slots: AbSlot[]): boolean {
  return slots.some((s) => !s.baseline && slotDiffersFromBaseline(s.config));
}

/**
 * 枠の構成が実行可能な形で揃っているか。provider を上書きする枠はモデルも必須
 * (モデル空のまま別プロバイダへ投げると既定プロバイダのモデル名が漏れて誤動作する)。
 */
export function isSlotComplete(config: AbConfig): boolean {
  if (config.provider?.trim()) return !!config.model?.trim();
  return true;
}

/** 比較を実行してよいか (意味があり、かつ全枠が実行可能な形)。 */
export function canRunComparison(slots: AbSlot[]): boolean {
  return (
    isComparisonMeaningful(slots) &&
    slots.every((s) => isSlotComplete(s.config))
  );
}

/**
 * 枠の provider に応じた API 経路 (variant) を解決する。
 * Sakana は `/responses` が推奨経路 (fugu) なので明示する。他プロバイダの override は
 * バックエンドの既定解決に委ねる (undefined)。基準枠 (provider 未指定) も undefined で、
 * バックエンドがグローバル設定どおりに解決する。
 * 規則の正本は `overrideApiVariantForProvider`(チャットの別プロバイダ選択と共有)。
 */
export function resolveSlotApiVariant(config: AbConfig): string | undefined {
  return overrideApiVariantForProvider(config.provider) ?? undefined;
}
