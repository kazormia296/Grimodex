import { toast } from "sonner";
import i18next from "@/lib/i18n";
import {
  useProjectStore,
  getCurrentProjectId,
} from "@/features/project/projectStore";
import { getAiPolicyClassification } from "./parse";
import { refreshProjectListOnceIfCurrentMissing } from "./refreshMissingProject";
import { aiDisabledReasonTooltipKey } from "./evaluateAiCapability";
import type { AiFeature } from "./types";

export type AiPolicyBlockReason = "policy" | "invalid" | "unavailable";

/** 書き込みの 3 軸。壊れた値と未読込の作品では止める（chat・analysis は通す）。 */
const WRITE_FEATURES: ReadonlySet<AiFeature> = new Set([
  "bodyWrite",
  "structureWrite",
  "knowledgeWrite",
]);

/** 現在の機能が止まる理由。画面・会話の表示と実行ゲートで共有する。 */
export function getAiFeatureBlockReason(
  feature: AiFeature,
): AiPolicyBlockReason | null {
  const projectId = getCurrentProjectId();
  const project = useProjectStore
    .getState()
    .projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    // 後ろで 1 回だけ読み直す。止める判定は変えない。
    refreshProjectListOnceIfCurrentMissing();
    return WRITE_FEATURES.has(feature) ? "unavailable" : null;
  }

  const policy = getAiPolicyClassification(project.aiPolicy);
  if (policy.state === "invalid" && WRITE_FEATURES.has(feature))
    return "invalid";
  return policy.toggles[feature] ? null : "policy";
}

/** 同期の実行時チョークポイント。未取得・破損でも書込みを許可しない。 */
export function isAiFeatureBlockedByPolicy(feature: AiFeature): boolean {
  return getAiFeatureBlockReason(feature) !== null;
}

const STOP_TEXT_KEYS = {
  invalid: "aiPolicy.disabledReason.invalidPolicy",
  unavailable: "aiPolicy.disabledReason.projectUnavailable",
} as const;

/**
 * 利用方針が壊れた作品と未読込の作品で止まるときの画面の文。それ以外
 * （設定どおりのオフ、止まらない）は null。
 */
export function aiPolicyStopText(feature: AiFeature): string | null {
  const reason = getAiFeatureBlockReason(feature);
  return reason === "invalid" || reason === "unavailable"
    ? i18next.t(STOP_TEXT_KEYS[reason])
    : null;
}

/** policy で止めた操作に、その理由を toast して早期 return する。 */
export function blockIfPolicyOff(feature: AiFeature): boolean {
  const reason = getAiFeatureBlockReason(feature);
  if (!reason) return false;
  const key =
    reason === "policy"
      ? aiDisabledReasonTooltipKey("policy")
      : STOP_TEXT_KEYS[reason];
  toast.error(i18next.t(key));
  return true;
}
