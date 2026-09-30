import { useTranslation } from "react-i18next";
import type { PlotPhaseType } from "@/db/schema";
import type { PlannedPlotThreadProposal } from "@/features/plot-threads/extraction/proposalPlanner";
import { PlotThreadProposalCard } from "./PlotThreadProposalCard";

export interface PlotThreadProposalReviewProps {
  readonly proposals: readonly PlannedPlotThreadProposal[];
  readonly documentLabel?: (documentRef: string) => string;
  readonly phaseLabel?: (phase: PlotPhaseType) => string;
}

/**
 * Presentational list of Plot Thread proposal review cards. Purely a
 * function of props — no store access — so it can be wired to whatever
 * proposal source (live extraction run, fixture, replay) is available.
 */
export function PlotThreadProposalReview({
  proposals,
  documentLabel,
  phaseLabel,
}: PlotThreadProposalReviewProps) {
  const { t } = useTranslation();

  if (proposals.length === 0) {
    return (
      <div
        data-testid="plot-thread-proposal-review-empty"
        className="px-3 py-3 text-xs text-muted-foreground"
      >
        {t(
          "plotThread.reviewExtract.empty",
          "レビュー待ちの提案はまだありません。",
        )}
      </div>
    );
  }

  return (
    <ul
      data-testid="plot-thread-proposal-review-list"
      className="max-h-72 divide-y divide-border overflow-y-auto rounded border border-border"
    >
      {proposals.map((proposal) => (
        <PlotThreadProposalCard
          key={proposal.hypothesisId}
          proposal={proposal}
          documentLabel={documentLabel}
          phaseLabel={phaseLabel}
        />
      ))}
    </ul>
  );
}
