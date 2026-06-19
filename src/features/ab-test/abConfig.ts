import type { AbConfig } from "./abHarness";

export type AbMode = "model" | "prompt";

/**
 * A/B の軸 (mode) と B 側入力から、A/B 2 構成を確定する純関数。
 * A 側は常に「現在の既定」(model=undefined → Rust 側で設定既定にフォールバック,
 * promptVariant=なし)。B 側は mode に応じて model か promptVariant のみを変える。
 *
 * - model モード : A=既定 / B=指定モデル (promptVariant は両方なし)
 * - prompt モード: A=既定 / B=既定モデル + 追記指示 (model は両方なし=既定)
 */
export function deriveAbConfigs(
  mode: AbMode,
  bInput: AbConfig,
): { configA: AbConfig; configB: AbConfig } {
  if (mode === "model") {
    return {
      configA: {},
      configB: { model: bInput.model?.trim() || undefined },
    };
  }
  return {
    configA: {},
    configB: { promptVariant: bInput.promptVariant?.trim() || undefined },
  };
}

/**
 * B 構成が実際に A と差分を持つか (空入力での無意味な A/B を弾く)。
 */
export function isAbConfigMeaningful(mode: AbMode, bInput: AbConfig): boolean {
  if (mode === "model") return !!bInput.model?.trim();
  return !!bInput.promptVariant?.trim();
}
