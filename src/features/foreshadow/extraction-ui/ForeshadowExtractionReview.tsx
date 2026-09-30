import { useTranslation } from "react-i18next";
import type { PlannedForeshadowProposal } from "@/features/foreshadow/extraction/proposalPlanner";
import { ForeshadowThreadProposalCard } from "./ForeshadowThreadProposalCard";
import { SetupPayoffTimeline } from "./SetupPayoffTimeline";

export interface ForeshadowExtractionReviewProps {
  readonly proposals?: readonly PlannedForeshadowProposal[];
  readonly documentLabel?: (documentRef: string) => string;
}

/**
 * Presentational review shell for AI-synthesized foreshadow proposals.
 * Pure function of props — no store/commit wiring yet.
 */
export function ForeshadowExtractionReview({
  proposals = [],
  documentLabel,
}: ForeshadowExtractionReviewProps) {
  const { t } = useTranslation();

  if (proposals.length === 0) {
    return (
      <div
        data-testid="foreshadow-extraction-review-empty"
        className="px-3 py-3 text-xs text-muted-foreground"
      >
        {t(
          "foreshadow.reviewExtract.empty",
          "レビュー待ちの伏線候補はまだありません。",
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="foreshadow-extraction-review"
      className="flex flex-col gap-3"
    >
      <SetupPayoffTimeline
        proposals={proposals}
        documentLabel={documentLabel}
      />
      <ul
        data-testid="foreshadow-extraction-review-list"
        className="max-h-72 divide-y divide-border overflow-y-auto rounded border border-border"
      >
        {proposals.map((proposal) => (
          <ForeshadowThreadProposalCard
            key={proposal.hypothesisId}
            proposal={proposal}
            documentLabel={documentLabel}
          />
        ))}
      </ul>
    </div>
  );
}
