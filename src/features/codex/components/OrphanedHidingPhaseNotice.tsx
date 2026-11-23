import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OrphanedHidingPhase } from "../orphanedHidingPhase";

/** Phase names shown in the notice. The rest is counted ("and n more"). */
const MAX_NAMED_PHASES = 3;

interface OrphanedHidingPhaseNoticeProps {
  /** `getOrphanedHidingPhaseDisplay(...).warned`. Renders nothing when empty. */
  phases: readonly OrphanedHidingPhase[];
  /**
   * "timeline": the full explanation, at the top of the Timeline tab.
   * "details": a short summary with a way to the Timeline tab (when given).
   */
  variant: "timeline" | "details";
  onOpenTimeline?: () => void;
}

/**
 * A Codex that has a "hide from the AI" Phase whose anchor scene is gone is not
 * sent to the in-app AI at all (DR-MP4-46). There is no dismiss or "later": it
 * stays until the anchor is chosen again or the Phase is deleted.
 */
export function OrphanedHidingPhaseNotice({
  phases,
  variant,
  onOpenTimeline,
}: OrphanedHidingPhaseNoticeProps) {
  const { t } = useTranslation();
  if (phases.length === 0) return null;

  const named = phases.slice(0, MAX_NAMED_PHASES).map((phase) =>
    t("codex.timeline.orphanNotice.phaseName", {
      label: phase.label || t("codex.timeline.orphanNotice.unnamedPhase"),
    }),
  );
  const rest = phases.length - named.length;
  const names =
    named.join(t("codex.timeline.orphanNotice.join")) +
    (rest > 0 ? t("codex.timeline.orphanNotice.more", { count: rest }) : "");
  const key =
    variant === "timeline"
      ? "codex.timeline.orphanNotice.bannerBody"
      : "codex.timeline.orphanNotice.detailsBody";

  return (
    <div
      role="status"
      data-testid={`orphaned-hiding-phase-notice-${variant}`}
      className="mb-3 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-foreground"
    >
      <AlertTriangle
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
        aria-hidden
      />
      <div className="min-w-0 flex-1 break-words">
        <p className="font-semibold">
          {t("codex.timeline.orphanNotice.title")}
        </p>
        <p className="mt-0.5">
          {t(key, { count: phases.length, phases: names })}
        </p>
        {variant === "details" && onOpenTimeline && (
          <button
            type="button"
            onClick={onOpenTimeline}
            className="mt-1.5 rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent"
          >
            {t("codex.timeline.orphanNotice.openTimeline")}
          </button>
        )}
      </div>
    </div>
  );
}
