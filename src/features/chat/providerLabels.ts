import type { TFunction } from "i18next";
import type { AiProvider } from "./types";

/**
 * プロバイダのブランド表示名(非ローカライズの素ラベル)。
 * 一部(ollama / openai-compatible / cli)は UI 文脈で i18n キーを優先するため
 * `getProviderLabel` 経由で上書きされる。
 */
export const PROVIDER_LABELS: Record<AiProvider, string> = {
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
 * ローカライズ済みプロバイダ表示名。i18n キーがあるものは t() を優先し、
 * 無いブランド名は PROVIDER_LABELS の素ラベルを返す。設定パネルとチャットの
 * モデルピッカーで同一ラベルを使うための単一の正本(ドリフト防止)。
 */
export function getProviderLabel(p: AiProvider, t: TFunction): string {
  if (p === "ollama") return t("settings.ai.ollamaLocal");
  if (p === "openai-compatible")
    return t("settings.ai.providerOpenaiCompatible");
  if (p === "cli") return t("settings.ai.providerCli");
  return PROVIDER_LABELS[p];
}
