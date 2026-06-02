import type { ProviderReadiness } from "@/features/chat/store";
import type { AiCapability, AiFeature, AiPolicy } from "./types";

/**
 * AI 機能の使用可否を判定する pure 関数（React 非依存）。
 *
 * 判定優先順: pending → policy → no-model → no-provider → enabled
 * ユーザの意思 (policy) を provider 状態より優先させることで、
 * 「Off にしたのに未設定ダイアログが出る」事故を防ぐ。
 *
 * React フック (`useAiCapability` / `useAiGate`) と、React 外の実行時
 * チェック（generate / sendMessage のチョークポイント）の両方が
 * この関数を共有し、判定順を単一 source 化する。
 */
export function evaluateAiCapability(
  policy: AiPolicy | null,
  readiness: ProviderReadiness,
  feature: AiFeature,
): AiCapability {
  if (readiness === "pending" || policy === null) return { state: "pending" };
  if (!policy.toggles[feature]) return { state: "disabled", reason: "policy" };
  if (readiness === "no-model")
    return { state: "disabled", reason: "no-model" };
  if (readiness === "no-provider")
    return { state: "disabled", reason: "no-provider" };
  return { state: "enabled" };
}

/** コントロールの表示方針。 */
export type AiGatePresentation = "enabled" | "pending" | "disabled" | "hidden";

export interface AiGate {
  presentation: AiGatePresentation;
  /** disabled 時に表示する理由の i18n キー。hidden/enabled/pending では null。 */
  tooltipKey: string | null;
}

const DISABLED_REASON_TOOLTIP_KEY: Record<
  "policy" | "no-model" | "no-provider",
  string
> = {
  policy: "aiPolicy.disabledReason.policy",
  "no-model": "aiPolicy.disabledReason.noModel",
  "no-provider": "aiPolicy.disabledReason.noProvider",
};

/**
 * capability を「コントロールをどう見せるか」へ変換する pure 関数。
 *
 * - reason="policy"（ユーザが意図的に切った）→ hidden。
 *   ポリシーを *モード* として扱い、コントロール自体を見せない。
 * - reason="no-model" / "no-provider"（セットアップ未完）→ disabled。
 *   隠すと「AI が存在しない／壊れている」誤認になるため、
 *   visible-disabled + 設定への導線を残す。
 * - pending → 表示（hide しない）。mount 時の「表示→hide」ちらつき防止。
 */
export function deriveAiGate(cap: AiCapability): AiGate {
  switch (cap.state) {
    case "enabled":
      return { presentation: "enabled", tooltipKey: null };
    case "pending":
      return { presentation: "pending", tooltipKey: null };
    case "disabled":
      if (cap.reason === "policy") {
        return { presentation: "hidden", tooltipKey: null };
      }
      return {
        presentation: "disabled",
        tooltipKey: DISABLED_REASON_TOOLTIP_KEY[cap.reason],
      };
  }
}
