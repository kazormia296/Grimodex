import { useTranslation } from "react-i18next";
import { useCurrentProjectAiPolicy } from "./useCurrentProjectAiPolicy";
import type { AiPolicyPreset } from "./types";
import { openAiPolicySettings } from "./openAiPolicySettings";

const BADGE_CLASSNAME: Record<Exclude<AiPolicyPreset, "full">, string> = {
  "assist-off": "text-amber-600",
  "review-only": "text-blue-600",
  off: "text-red-600",
  custom: "text-muted-foreground",
};

const BADGE_LABEL_KEY: Record<Exclude<AiPolicyPreset, "full">, string> = {
  "assist-off": "aiPolicy.presetLabel.assistOff",
  "review-only": "aiPolicy.presetLabel.reviewOnly",
  off: "aiPolicy.presetLabel.off",
  custom: "aiPolicy.presetLabel.custom",
};

export function AiPolicyBadge() {
  const { t } = useTranslation();
  const policy = useCurrentProjectAiPolicy();
  if (!policy || policy.preset === "full") return null;

  return (
    <button
      type="button"
      onClick={openAiPolicySettings}
      title={t("aiPolicy.openSettingsTooltip")}
      className={`flex h-5 items-center rounded px-2 text-xs hover:bg-accent ${BADGE_CLASSNAME[policy.preset]}`}
    >
      {t(BADGE_LABEL_KEY[policy.preset])}
    </button>
  );
}
