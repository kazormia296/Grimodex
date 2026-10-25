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
import { PROFILE_ACTIVATION_UI_ENABLED } from "@/features/profile-egress/profileActivationAvailability";

export interface AiGateResult {
  /** コントロールの表示方針（hidden=描画しない / disabled=無効表示 / enabled / pending）。 */
  presentation: AiGatePresentation;
  /** disabled 時に表示する解決済み tooltip 文言。それ以外は null。 */
  tooltip: string | null;
  /** 生の capability（state / reason）。実アクションの可否判定にも使える。 */
  capability: AiCapability;
}

/**
 * `useAiGate` の対象。`"chat-send"` は chat の送信（policy では `chat`）で、外部送信の
 * 制限の閉鎖を呼出し側が扱う（場面の会話の送信は制限中も開いたまま：
 * `src/features/chat/chatEgressClosure.ts` の `chatEgressClosureOf`）。呼出し側は
 * `PROFILE_ACTIVATION_UI_ENABLED ? "chat-send" : "chat"` と書き、定数が false の間は
 * 引数が `"chat"` に畳まれる（起動時の graph に byte を足さない。DR-DA2B-R23）。
 */
export type AiGateFeature = AiFeature | "chat-send";

/**
 * 指定した AI 機能のコントロールを「どう見せるか」を返す中央フック。
 *
 * presentation = policy 由来の disabled は hidden、provider/model 由来は
 * disabled（設定導線維持）。tooltip 文言の i18n もここで解決する。
 * 各 consumer はベタ書きの tooltip 三項を持たず、この戻り値を使う。
 */
export function useAiGate(feature: AiGateFeature): AiGateResult {
  const readiness = useAiSettingsStore(selectProviderReadiness);
  const policy = useCurrentProjectAiPolicy();
  const { t } = useTranslation();
  // DA-2b の PUB-G 前の必須 3（DR-DA2B-R22）。定数（compile time の値）で分かれるので、
  // render ごとの hook の順は変わらない。定数が false の間は minify で消える（同じ chunk に
  // ある store を読むだけで、新しい import を足さない。R23）。
  const egressClosed = PROFILE_ACTIVATION_UI_ENABLED
    ? // eslint-disable-next-line react-hooks/rules-of-hooks
      useAiSettingsStore((s) => s.profileEgressClosed === true)
    : false;

  const policyFeature: AiFeature =
    PROFILE_ACTIVATION_UI_ENABLED && feature === "chat-send"
      ? "chat"
      : (feature as AiFeature);
  const capability = evaluateAiCapability(policy, readiness, policyFeature);
  const gate = deriveAiGate(capability);

  // 外部送信の制限で AI が閉じている間は、見える control を理由つきの disabled にする。
  // policy の hidden は hidden のまま（利用者が切ったものを見せない）。capability（policy
  // の判定の正本）は変えない。防御は Main の gate と Native（`invoke` の手前の局所の拒否も
  // 無駄な呼出しを出さないためだけ）。
  if (
    PROFILE_ACTIVATION_UI_ENABLED &&
    egressClosed &&
    feature !== "chat-send" &&
    gate.presentation !== "hidden"
  ) {
    return {
      presentation: "disabled",
      tooltip: t("profileEgress.ai.closed"),
      capability,
    };
  }

  return {
    presentation: gate.presentation,
    tooltip: gate.tooltipKey ? t(gate.tooltipKey) : null,
    capability,
  };
}
