import { useTranslation } from "react-i18next";
import {
  useAiSettingsStore,
  selectProviderReadiness,
} from "@/features/chat/store";
import { useCurrentProjectAiPolicy } from "./useCurrentProjectAiPolicy";
import {
  evaluateAiCapability,
  deriveAiGate,
  type AiGatePresentation,
} from "./evaluateAiCapability";
import type { AiCapability, AiFeature } from "./types";

export interface AiGateResult {
  /** コントロールの表示方針（hidden=描画しない / disabled=無効表示 / enabled / pending）。 */
  presentation: AiGatePresentation;
  /** disabled 時に表示する解決済み tooltip 文言。それ以外は null。 */
  tooltip: string | null;
  /** 生の capability（state / reason）。実アクションの可否判定にも使える。 */
  capability: AiCapability;
}

/**
 * 指定した AI 機能のコントロールを「どう見せるか」を返す中央フック。
 *
 * presentation = policy 由来の disabled は hidden、provider/model 由来は
 * disabled（設定導線維持）。tooltip 文言の i18n もここで解決する。
 * 各 consumer はベタ書きの tooltip 三項を持たず、この戻り値を使う。
 */
export function useAiGate(feature: AiFeature): AiGateResult {
  const readiness = useAiSettingsStore(selectProviderReadiness);
  const policy = useCurrentProjectAiPolicy();
  const { t } = useTranslation();

  const capability = evaluateAiCapability(policy, readiness, feature);
  const gate = deriveAiGate(capability);

  return {
    presentation: gate.presentation,
    tooltip: gate.tooltipKey ? t(gate.tooltipKey) : null,
    capability,
  };
}
