import { useTranslation } from "react-i18next";
import type { CodexRelationReviewProposal } from "./codexStructureExtractionStore";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";
import { localizeBlockedReason } from "./extraction/blockedReasons";

export interface CodexRelationProposalCardProps {
  readonly proposal: CodexRelationReviewProposal;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
  readonly onDecide?: (
    status: Exclude<NarrativeProposalStatus, "unreviewed">,
  ) => void;
}

function statusGlyph(proposal: CodexRelationReviewProposal): string {
  if (proposal.applicability === "already-satisfied") return "✓";
  if (proposal.applicability === "blocked") return "⊘";
  if (proposal.status === "approved") return "☑";
  if (proposal.status === "rejected") return "☒";
  if (proposal.status === "deferred" || proposal.status === "held") return "…";
  return "□";
}

/**
 * Compact list-row card for Codex Relation create proposals.
 * Bulk approve is intentionally unsupported (spec §22).
 */
export function CodexRelationProposalCard({
  proposal,
  selected = false,
  onSelect,
  onDecide,
}: CodexRelationProposalCardProps) {
  const { t } = useTranslation();
  const blocked = proposal.applicability === "blocked";
  const alreadySatisfied = proposal.applicability === "already-satisfied";
  const applied = Boolean(proposal.application);
  const relation = proposal.proposal.payload.relation;

  return (
    <div
      className={`flex flex-col gap-1.5 border-b border-border px-2 py-2 last:border-b-0 ${
        selected ? "bg-accent/50" : "hover:bg-accent/30"
      }`}
      data-testid={`codex-relation-proposal-card-${proposal.proposalId}`}
      data-selected={selected ? "true" : "false"}
      data-applicability={proposal.applicability}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        onClick={onSelect}
      >
        <span className="mt-0.5 w-4 shrink-0 text-xs" aria-hidden>
          {statusGlyph(proposal)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {proposal.displayTitle}
          </span>
          <span className="block text-[10px] text-muted-foreground">
            {proposal.subjectLabel} · {relation.forwardLabel} ·{" "}
            {proposal.objectLabel} ·{" "}
            {t(
              `codex.structureReview.relationCard.directionality.${relation.directionality}`,
            )}
          </span>
          {(blocked || alreadySatisfied) && (
            <span className="block text-[10px] text-amber-700 dark:text-amber-400">
              {localizeBlockedReason(proposal.blockedReason, t) ??
                (alreadySatisfied
                  ? t("codex.structureReview.blockedReason.relationExists")
                  : t(
                      "codex.structureReview.relationCard.unresolvedEndpoints",
                    ))}
            </span>
          )}
          {applied && (
            <span className="block text-[10px] text-muted-foreground">
              {t("codex.structureReview.relationCard.appliedReadonly")}
            </span>
          )}
        </span>
      </button>

      {!blocked && !alreadySatisfied && !applied && (
        <div className="flex flex-wrap gap-1 pl-6">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:opacity-40"
            disabled={proposal.status === "approved"}
            onClick={() => onDecide?.("approved")}
            data-testid={`codex-relation-approve-${proposal.proposalId}`}
          >
            {t("codex.structureReview.relationCard.approve")}
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
            disabled={proposal.status === "rejected"}
            onClick={() => onDecide?.("rejected")}
          >
            {t("codex.structureReview.relationCard.reject")}
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
            disabled={
              proposal.status === "deferred" || proposal.status === "held"
            }
            onClick={() => onDecide?.("deferred")}
          >
            {t("codex.structureReview.relationCard.defer")}
          </button>
        </div>
      )}
    </div>
  );
}
