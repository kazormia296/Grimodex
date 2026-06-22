import type { AiProvider } from "@/features/chat/types";

/**
 * プロバイダごとに「最後に選んだ既定チャットモデル + その API 経路(variant)」を
 * 覚えておくための純ロジック。
 *
 * AiSettings.model は現在アクティブな 1 つしか持てず、プロバイダ切替時に空へ
 * リセットされるため、別プロバイダへ移って戻ると毎回モデルを選び直す必要があった。
 * モデル whitelist / role モデルと同じく settingsStore(グローバル KV)側に
 * per-provider マップとして保存し、切替時に復元する。
 *
 * variant も一緒に覚えるのは、切替直後はまだ新プロバイダの models 一覧が読み込まれて
 * おらず、その時点で variant を models 依存で再解決すると(ai のべりすと v1 など)
 * 誤った値になり得るため。復元時は「前回そのプロバイダで確定していた variant」を
 * そのまま戻すことで、stale な一覧への依存を断つ。
 *
 * settingsStore は文字列 KV なので、本モジュールは JSON 文字列 ↔ マップの境界の
 * パース/直列化と、切替・選択時の更新ルールだけを担う(I/O は呼び出し側)。
 */

/** settingsStore に保存する per-provider モデルマップのキー。 */
export const MODEL_BY_PROVIDER_KEY = "ai.modelByProvider";

/** AiSettings.modelApiVariant と同じ語彙(null = 既定 /chat/completions など)。 */
export type ApiVariant = "legacy" | "v1" | "responses";

const VALID_VARIANTS = new Set<string>(["legacy", "v1", "responses"]);

/** プロバイダ 1 つ分の記憶(選択モデルとその API 経路)。 */
export interface ProviderModelMemory {
  model: string;
  variant: ApiVariant | null;
}

export type ModelByProvider = Partial<Record<AiProvider, ProviderModelMemory>>;

/** 任意値を ProviderModelMemory に正規化する(不正なら null)。 */
function coerceEntry(value: unknown): ProviderModelMemory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.model !== "string" || obj.model === "") return null;
  const variant =
    typeof obj.variant === "string" && VALID_VARIANTS.has(obj.variant)
      ? (obj.variant as ApiVariant)
      : null;
  return { model: obj.model, variant };
}

/** settingsStore から読んだ生文字列を安全にマップへパースする(壊れていれば空)。 */
export function readModelByProvider(raw: string): ModelByProvider {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: ModelByProvider = {};
    for (const [k, v] of Object.entries(parsed)) {
      const entry = coerceEntry(v);
      if (entry) out[k as AiProvider] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * プロバイダ切替時の更新。切替元の現在(モデル+variant)をマップへ焼き込み
 * (モデルが空なら触らない)、切替先の前回記憶を返す。元/先が同一でも安全。
 */
export function applyProviderSwitch(
  map: ModelByProvider,
  fromProvider: AiProvider,
  fromEntry: ProviderModelMemory,
  toProvider: AiProvider,
): { map: ModelByProvider; restored: ProviderModelMemory | undefined } {
  const next: ModelByProvider = { ...map };
  if (fromEntry.model) {
    next[fromProvider] = { model: fromEntry.model, variant: fromEntry.variant };
  }
  return { map: next, restored: next[toProvider] };
}

/**
 * モデル選択時の更新。現在プロバイダのエントリを最新(モデル+variant)へ更新する。
 * 空モデル(=既定に戻す)ならエントリを削除し、stale な復元を防ぐ。
 */
export function rememberModel(
  map: ModelByProvider,
  provider: AiProvider,
  model: string,
  variant: ApiVariant | null,
): ModelByProvider {
  const next: ModelByProvider = { ...map };
  if (model) next[provider] = { model, variant };
  else delete next[provider];
  return next;
}
