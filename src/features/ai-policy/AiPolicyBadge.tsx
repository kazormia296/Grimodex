import { useCurrentProjectAiPolicy } from "./useCurrentProjectAiPolicy";
import type { AiPolicyPreset } from "./types";

const BADGE: Record<
  Exclude<AiPolicyPreset, "full">,
  { label: string; className: string }
> = {
  "assist-off": {
    label: "Assist-off",
    className: "text-amber-600",
  },
  "review-only": {
    label: "Review-only",
    className: "text-blue-600",
  },
  off: {
    label: "AI OFF",
    className: "text-red-600",
  },
  custom: {
    label: "AI custom",
    className: "text-muted-foreground",
  },
};

export function AiPolicyBadge() {
  const policy = useCurrentProjectAiPolicy();
  if (!policy || policy.preset === "full") return null;

  const badge = BADGE[policy.preset];

  const onClick = () => {
    window.dispatchEvent(
      new CustomEvent("open-settings", { detail: { category: "project" } }),
    );
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title="AIポリシー設定を開く"
      className={`flex h-5 items-center rounded px-2 text-xs hover:bg-accent ${badge.className}`}
    >
      {badge.label}
    </button>
  );
}
